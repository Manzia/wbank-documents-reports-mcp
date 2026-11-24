import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { HaikuOptions } from '../haiku/client';
import { reformulateQuery } from '../haiku/reformulate';
import { isUpstreamError } from '../upstream/errors';
import type { DocumentRecord, FacetValue, ProvenanceRecord } from '../upstream/normalise';
import { DATE_CEILING, DATE_FLOOR, MAX_OFFSET, type ParamValue, type QueryParams } from '../upstream/params';
import { searchWds, type SearchResult } from '../upstream/search';
import { openUpstream, type Upstream } from '../upstream/transport';
import { VOCABULARY_LISTS, type Vocabulary } from '../vocabulary/format';
import { loadVocabulary } from '../vocabulary/load';
import { filtersOf, freeTextOf, resolveTerm, type ResolveTarget } from '../vocabulary/resolve';
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// Design §5: about 20,000 tokens per result. Text runs about 4 characters a token; this leaves a margin.
export const MAX_OUTPUT_CHARS = 60_000;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
// Merged keyword variants are paged from each variant's top records, so a page needs offset + limit of each.
export const MAX_MERGED_DEPTH = 300;
export const MAX_ABSTRACT_CHARS = 1_000;
export const MAX_TERMS = 10;
// group_by_stage reads the project's whole document list, up to this many records.
export const MAX_PROJECT_RECORDS = 500;
export const MAX_FACET_VALUES = 25;
export const MAX_FACET_YEARS = 10;

// Shared by both search tools (MCP-132).
export interface SearchDeps {
    upstream?: Upstream;
    vocabulary?: () => Promise<Vocabulary>;
    haiku?: HaikuOptions;
    now?: () => Date;
}

// A problem with the inputs: shown to the client as is, and nothing is sent upstream.
export class ToolInputError extends Error {
    override readonly name = 'ToolInputError';
}

const textResult = (text: string, isError = false): CallToolResult => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text }],
});

export const failure = (tool: string, error: unknown): CallToolResult => {
    if (error instanceof ToolInputError) return textResult(`${tool}: ${error.message}`, true);
    if (isUpstreamError(error)) return textResult(`${tool} could not finish: ${error.message}`, true);
    console.error(
        JSON.stringify({ message: 'tool error', tool, error: error instanceof Error ? error.name : 'unknown' }),
    );
    return textResult(`${tool} failed unexpectedly. Try again; if it fails again, simplify the request.`, true);
};

export const notifyProgress = async (ctx: ServerContext | undefined, progress: number, message: string) => {
    const token = ctx?.mcpReq?._meta?.progressToken;
    if (token === undefined) return;
    try {
        await ctx!.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress, message },
        });
    } catch {
        // Progress is best-effort; the result still follows.
    }
};

// Dates: YYYY, YYYY-MM or YYYY-MM-DD; a range's start becomes its first day, its end its last.
export const DATE_INPUT = z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Use YYYY, YYYY-MM or YYYY-MM-DD.')
    .describe('YYYY, YYYY-MM or YYYY-MM-DD');

export const toDate = (value: string | undefined, end: boolean, name: string): string | undefined => {
    if (!value) return undefined;
    const [year, month, day] = value.split('-');
    const m = month ?? (end ? '12' : '01');
    const last = new Date(Date.UTC(Number(year), Number(m), 0)).getUTCDate();
    const d = day ?? (end ? String(last).padStart(2, '0') : '01');
    const date = `${year}-${m}-${d}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(date)) {
        throw new ToolInputError(`${name} '${value}' is not a valid date.`);
    }
    return date;
};

export const dateWindow = (
    from: string | undefined,
    to: string | undefined,
    names: [string, string],
): { from?: string; to?: string } => {
    const window = { from: toDate(from, false, names[0]), to: toDate(to, true, names[1]) };
    if (window.from && window.to && window.from > window.to) {
        throw new ToolInputError(`${names[0]} (${window.from}) is after ${names[1]} (${window.to}).`);
    }
    return window;
};

// --- Term resolution (design §7.1) -------------------------------------------------------------------------

export interface TermRequest {
    // The input the terms came from, e.g. "countries".
    input: string;
    terms: readonly string[];
    target: ResolveTarget;
}

export interface ResolvedTerms {
    filters: Record<string, string[]>;
    freeText: string[];
    interpretedAs: string[];
}

const firstParameter = (target: ResolveTarget): string =>
    (VOCABULARY_LISTS[target.api] as Record<string, string>)[target.lists[0]];

export const resolveInputs = async (requests: readonly TermRequest[], deps: SearchDeps): Promise<ResolvedTerms> => {
    const out: ResolvedTerms = { filters: {}, freeText: [], interpretedAs: [] };
    const wanted = requests.filter((r) => r.terms.some((t) => t.trim()));
    if (!wanted.length) return out;
    let vocabulary: Vocabulary | undefined;
    try {
        vocabulary = await (deps.vocabulary ?? loadVocabulary)();
    } catch (error) {
        console.warn(
            JSON.stringify({ message: 'vocabulary unavailable', reason: (error as Error)?.name ?? 'unknown' }),
        );
    }
    for (const request of wanted) {
        const terms = request.terms.map((t) => t.trim()).filter(Boolean);
        if (!vocabulary) {
            // Without the lists, a value is sent as given and the result says so.
            const parameter = firstParameter(request.target);
            for (const term of terms) {
                if (!out.filters[parameter]?.includes(term)) (out.filters[parameter] ??= []).push(term);
                out.interpretedAs.push(
                    `'${term}' was used as given: the World Bank's list of valid values could not be loaded.`,
                );
            }
            continue;
        }
        const resolutions = await Promise.all(
            terms.map((term) => resolveTerm(term, request.target, { vocabulary, haiku: deps.haiku })),
        );
        for (const [parameter, values] of Object.entries(filtersOf(resolutions))) {
            for (const value of values) {
                if (!out.filters[parameter]?.includes(value)) (out.filters[parameter] ??= []).push(value);
            }
        }
        out.freeText.push(...freeTextOf(resolutions));
        out.interpretedAs.push(...resolutions.map((r) => r.interpretedAs));
    }
    return out;
};

// --- Keyword variants (design §7) --------------------------------------------------------------------------

export interface Keywords {
    // One qterm per search to run; [undefined] for a search without keywords.
    qterms: (string | undefined)[];
    method?: 'haiku' | 'keywords';
    note?: string;
}

export const keywordSearches = async (
    query: string | undefined,
    freeText: readonly string[],
    deps: SearchDeps,
): Promise<Keywords> => {
    const extra = freeText.map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, '')}"` : t)).join(' ');
    const withExtra = (qterm: string) => [qterm, extra].filter(Boolean).join(' ');
    if (!query?.trim()) return { qterms: [extra || undefined] };
    const reformulation = await reformulateQuery(query, deps.haiku);
    const variants = reformulation.variants.length ? reformulation.variants : [query.trim()];
    const note =
        reformulation.method === 'haiku'
            ? `The query was run as ${variants.length} keyword variant${variants.length > 1 ? 's' : ''}; results are merged and duplicates removed.`
            : 'Automatic keyword variants were unavailable; the query was run as typed and as its keywords.';
    return { qterms: variants.map(withExtra), method: reformulation.method, note };
};

// --- Searching and merging ---------------------------------------------------------------------------------

export interface Run<R> {
    qterm?: string;
    result: SearchResult<R>;
}

export interface Merged<R> {
    runs: Run<R>[];
    // The page asked for: records offset to offset + limit of the merged list.
    records: R[];
    more: boolean;
}

export type Order<R> = 'rank' | ((a: R, b: R) => number);

export const recordKey = (record: ProvenanceRecord): string =>
    record.documentId ?? record.projectId ?? `${record.title}|${record.documentDate ?? ''}`;

const mergeRuns = <R extends ProvenanceRecord>(runs: Run<R>[], order: Order<R>): R[] => {
    const seen = new Set<string>();
    const out: R[] = [];
    const add = (record: R | undefined) => {
        if (!record) return;
        const key = recordKey(record);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(record);
    };
    if (order === 'rank') {
        // Round-robin by rank: each variant's best record, then each one's second best, and so on.
        const longest = Math.max(...runs.map((run) => run.result.records.length));
        for (let i = 0; i < longest; i += 1) for (const run of runs) add(run.result.records[i]);
    } else {
        // Each run is already in this order, so the union's first records are among the runs' first records.
        for (const record of runs.flatMap((run) => run.result.records).sort(order)) add(record);
    }
    return out;
};

export const searchMerged = async <R extends ProvenanceRecord>(
    search: (params: QueryParams) => Promise<SearchResult<R>>,
    base: Record<string, ParamValue>,
    qterms: (string | undefined)[],
    page: { offset: number; limit: number; order: Order<R> },
): Promise<Merged<R>> => {
    const { offset, limit, order } = page;
    if (qterms.length === 1) {
        const result = await search({ ...base, qterm: qterms[0], rows: limit, os: offset });
        return {
            runs: [{ qterm: qterms[0], result }],
            records: result.records,
            more: offset + result.records.length < result.total,
        };
    }
    const depth = offset + limit;
    if (depth > MAX_MERGED_DEPTH) {
        throw new ToolInputError(
            `results merged from several keyword variants can be paged to record ${MAX_MERGED_DEPTH}; offset + limit is ${depth}. Narrow the search with filters or a date range, or sort by newest.`,
        );
    }
    // Only the first search asks for facets: counts from several variants can't be added up.
    const runs = await Promise.all(
        qterms.map(async (qterm, i) => {
            const params: Record<string, ParamValue> = { ...base, qterm, rows: depth, os: 0 };
            if (i > 0) delete params.fct;
            return { qterm, result: await search(params) };
        }),
    );
    const merged = mergeRuns(runs, order);
    return {
        runs,
        records: merged.slice(offset, depth),
        more: merged.length > depth || runs.some((run) => run.result.total > run.result.records.length),
    };
};

// --- Rendering ---------------------------------------------------------------------------------------------

export const number = (n: number): string => n.toLocaleString('en-US');

const SHOWN_CONTROLS = new Set(['format', 'fl']);

// The query as sent, without the fixed format and field list: what the client changes to call again.
export const sentQuery = (params: Record<string, string>): string =>
    Object.entries(params)
        .filter(([name]) => !SHOWN_CONTROLS.has(name))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');

export const field = (raw: unknown, key?: string): string | undefined => {
    if (typeof raw === 'string') return raw.trim() || undefined;
    if (typeof raw === 'number') return String(raw);
    if (Array.isArray(raw)) return field(raw[0], key);
    if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        if (key && key in record) return field(record[key]);
        if ('cdata!' in record) return field(record['cdata!']);
        const first = Object.values(record)[0];
        return first === undefined ? undefined : field(first, key);
    }
    return undefined;
};

export const fieldList = (raw: unknown, key: string, max = 3): string | undefined => {
    if (!raw || typeof raw !== 'object') return field(raw);
    const values = Object.values(raw as Record<string, unknown>)
        .map((v) => field(v, key))
        .filter((v): v is string => Boolean(v));
    if (!values.length) return undefined;
    return values.length > max
        ? `${values.slice(0, max).join('; ')} and ${values.length - max} more`
        : values.join('; ');
};

const shorten = (text: string, max: number): string => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max).replace(/\s+\S*$/, '')} … (shortened; read_document has the full text)`;
};

export const joinParts = (parts: (string | false | undefined | null)[]): string =>
    parts.filter((p): p is string => Boolean(p)).join(' · ');

const renderDocument = (record: DocumentRecord, index: number, withAbstract: boolean): string => {
    const f = record.fields;
    const abstract = withAbstract ? field(f.abstracts) : undefined;
    const lines = [
        `${index}. ${record.title}`,
        `   ${joinParts([
            record.documentId && `Document ID: ${record.documentId}`,
            record.reportNumber && `Report number: ${record.reportNumber}`,
            record.projectId && `Project: ${record.projectId}`,
        ])}`,
        `   ${joinParts([
            record.documentType && `Type: ${record.documentType}`,
            `Document date: ${record.documentDate ?? 'not given'}`,
            record.disclosureDate && `Disclosed: ${record.disclosureDate}`,
            field(f.count) && `Country: ${field(f.count)}`,
            field(f.lang) && `Language: ${field(f.lang)}`,
        ])}`,
    ];
    const byline = joinParts([
        fieldList(f.authors, 'author') && `Authors: ${fieldList(f.authors, 'author')}`,
        field(f.colti) && `Series: ${field(f.colti)}`,
    ]);
    if (byline) lines.push(`   ${byline}`);
    lines.push(
        `   ${joinParts([`Record: ${record.recordUrl ?? 'none listed'}`, record.fileUrl && `PDF: ${record.fileUrl}`])}`,
    );
    if (abstract) lines.push(`   Abstract: ${shorten(abstract, MAX_ABSTRACT_CHARS)}`);
    return lines.join('\n');
};

// Adds records until the output budget is reached; returns how many fit.
export const addWithinBudget = (
    sections: string[],
    items: string[],
    reserved: number,
    max = MAX_OUTPUT_CHARS,
): number => {
    let used = sections.join('\n\n').length + reserved;
    let added = 0;
    for (const item of items) {
        if (used + item.length + 2 > max && added > 0) break;
        sections.push(item);
        used += item.length + 2;
        added += 1;
    }
    return added;
};

// --- search_documents --------------------------------------------------------------------------------------

const FACETS = {
    country: 'count_exact',
    document_type: 'docty_exact',
    language: 'lang_exact',
} as const;

// The fields the tool shows; WDS adds a few of its own (MCP-102 F5).
const FIELDS = [
    'id',
    'display_title',
    'docna',
    'docty',
    'majdocty',
    'docdt',
    'disclosure_date',
    'repnb',
    'projectid',
    'count',
    'lang',
    'abstracts',
    'pdfurl',
    'txturl',
    'url',
    'guid',
    'authr',
    'colti',
].join(',');

// Design §5.1, group_by_stage: a fixed table of WDS document types (as the API names them) by project stage.
// It groups records for display; it does not resolve terms (design §7.1).
export const STAGES: { stage: string; types: string[] }[] = [
    {
        stage: 'Design',
        types: [
            'Project Information Document',
            'Program Information Document',
            'Project Information and Integrated Safeguards Data Sheet',
            'Integrated Safeguards Data Sheet',
            'Project Appraisal Document',
            'Program Appraisal Document',
            'Program Document',
            'Staff Appraisal Report',
            'Technical Annex',
            'Letter of Development Policy',
            'Memorandum & Recommendation of the President',
            'Memorandum & Recommendation of the Director',
            'Memorandum & Recommendation of the Managing Director',
            "President's Report",
            'Board Report',
            'Board Summary',
            'Program-for-Results Technical Assessment',
            'Program-for-Results Fiduciary Systems Assessment',
            'Program-for-Results Fiduciary Systems Assessment ',
            'GEF Project Brief',
            'GEF Project Document',
            'Funding Proposal',
            'Climate Co-Benefits Assessment',
        ],
    },
    {
        stage: 'Legal',
        types: [
            'Agreement',
            'Financing Agreement',
            'Loan Agreement',
            'Credit Agreement',
            'Grant or Trust Fund Agreement',
            'Project Agreement',
            'Guarantee Agreement',
            'Trust Fund Administrative Agreement',
            'Side Letter',
            'Disbursement Letter',
            'Legal Opinion',
        ],
    },
    {
        stage: 'Environmental and social',
        types: [
            'Environmental and Social Commitment Plan',
            'Environmental and Social Review Summary',
            'Environmental and Social Management Plan',
            'Environmental and Social Management Framework',
            'Environmental and Social Assessment',
            'Environmental Assessment',
            'Environmental Action Plan',
            'Stakeholder Engagement Plan',
            'Resettlement Plan',
            'Indigenous Peoples Plan',
            'Social Assessment',
            'Social Action Plan',
            'Program-for-Results Environmental and Social Systems Assessment',
            'Safeguards Diagnostic Review',
            'Environment and Social Post-Closure Action Plan',
        ],
    },
    {
        stage: 'Implementation',
        types: [
            'Implementation Status and Results Report',
            'Procurement Plan',
            'Aide Memoire',
            'Auditing Document',
            'Auditing/Financial Management',
            'Financial Monitoring Report',
            'Financial Statement',
            'Project Implementation Plan',
            'Manual',
            'Tranche Release Document',
        ],
    },
    { stage: 'Restructuring and additional financing', types: ['Project Paper', 'Restructuring Paper'] },
    {
        stage: 'Completion',
        types: [
            'Implementation Completion and Results Report',
            'Implementation Completion Report Review',
            'Project Completion Report',
            'Project Performance Assessment Report',
            'Note on Cancelled Operation',
            'Evaluation Memorandum',
        ],
    },
];
const OTHER_STAGE = 'Other';

export const stageOf = (documentType: string | null): string =>
    STAGES.find((s) => documentType && s.types.includes(documentType))?.stage ?? OTHER_STAGE;

const PROJECT_ID = /^P\d{6}$/i;

const inputSchema = z.object({
    query: z
        .string()
        .max(500)
        .optional()
        .describe('Keywords or a plain-language description; quote exact phrases, e.g. "learning poverty".'),
    project_id: z.string().regex(PROJECT_ID, 'A project ID looks like P117635.').optional().describe('e.g. P117635'),
    countries: z
        .array(z.string().max(200))
        .max(MAX_TERMS)
        .optional()
        .describe('Plain country names, e.g. ["Morocco", "Tunisia"] (any of them).'),
    region: z.string().max(200).optional().describe('e.g. "South Asia", "Eastern and Southern Africa".'),
    document_types: z
        .array(z.string().max(200))
        .max(MAX_TERMS)
        .optional()
        .describe(
            'Any of, e.g. "Project Appraisal Document" (PAD), "Implementation Status and Results Report" (ISR), "Implementation Completion and Results Report" (ICR), "Procurement Plan", "Financing Agreement", "Project Paper" (restructuring), "Environmental and Social Commitment Plan".',
        ),
    language: z.string().max(100).optional().describe('e.g. "French".'),
    date_from: DATE_INPUT.optional(),
    date_to: DATE_INPUT.optional(),
    author: z.string().max(200).optional(),
    report_number: z.string().max(100).optional(),
    document_id: z
        .string()
        .regex(/^\d{1,12}$/, 'A document ID is a number.')
        .optional(),
    collection: z.string().max(200).optional().describe('Series, e.g. "Policy Research working paper".'),
    sort: z
        .enum(['relevance', 'newest', 'oldest'])
        .optional()
        .describe('By document date for newest/oldest. Default: relevance with a query, else newest.'),
    facet: z
        .enum(['country', 'document_type', 'language', 'year'])
        .optional()
        .describe('Also return counts of matching document records by this field.'),
    group_by_stage: z
        .boolean()
        .optional()
        .describe("With project_id: the project's documents grouped by stage, newest first, up to limit per group."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
    offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
});

export type SearchDocumentsInput = z.infer<typeof inputSchema>;

const byDate =
    (direction: 'asc' | 'desc') =>
    (a: ProvenanceRecord, b: ProvenanceRecord): number => {
        // Undated records go last either way.
        const x = a.documentDate ?? (direction === 'asc' ? '9999' : '0000');
        const y = b.documentDate ?? (direction === 'asc' ? '9999' : '0000');
        return direction === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
    };

const filterLines = (
    input: SearchDocumentsInput,
    filters: Record<string, string[]>,
    window: { from?: string; to?: string },
) =>
    [
        input.project_id && `project ${input.project_id.toUpperCase()}`,
        filters.count_exact && `country: ${filters.count_exact.join(' or ')}`,
        filters.admreg_exact && `region: ${filters.admreg_exact.join(' or ')}`,
        filters.docty_exact && `document type: ${filters.docty_exact.join(' or ')}`,
        filters.lang_exact && `language: ${filters.lang_exact.join(' or ')}`,
        (window.from || window.to) && `document date ${window.from ?? DATE_FLOOR} to ${window.to ?? DATE_CEILING}`,
        input.author && `author: ${input.author}`,
        input.report_number && `report number: ${input.report_number}`,
        input.document_id && `document ID: ${input.document_id}`,
        input.collection && `series: ${input.collection}`,
    ].filter((line): line is string => Boolean(line));

const queryEcho = (
    runs: Run<unknown>[],
    keywords: Keywords,
    filters: string[],
    sortLabel: string,
    page: { offset: number; limit: number },
): string[] => {
    const lines = ['Query as executed:'];
    for (const run of runs) {
        const label = run.qterm ? `keywords ${run.qterm}` : 'no keywords';
        lines.push(`- ${label}: ${number(run.result.total)} matching records · ${sentQuery(run.result.query.params)}`);
    }
    if (keywords.note) lines.push(`- ${keywords.note}`);
    lines.push(`- Filters: ${filters.length ? filters.join('; ') : 'none'}`);
    lines.push(`- Sort: ${sortLabel} · limit ${page.limit} · offset ${page.offset}`);
    return lines;
};

const facetSection = (name: string, values: FacetValue[], note: string): string => {
    const shown = values.slice(0, MAX_FACET_VALUES);
    const lines = [`Facet "${name}": counts of matching document records${note}.`];
    if (!shown.length) lines.push('- No values were returned.');
    for (const value of shown) lines.push(`- ${value.name}: ${number(value.count)}`);
    if (values.length > shown.length) lines.push(`- … and ${values.length - shown.length} more values`);
    return lines.join('\n');
};

const yearFacet = async (
    upstream: Upstream,
    base: Record<string, ParamValue>,
    qterm: string | undefined,
    window: { from?: string; to?: string },
    now: Date,
): Promise<FacetValue[]> => {
    const lastYear = Number((window.to ?? now.toISOString()).slice(0, 4));
    const firstYear = Math.max(Number((window.from ?? DATE_FLOOR).slice(0, 4)), lastYear - MAX_FACET_YEARS + 1);
    const ranges: { name: string; strdate: string; enddate: string }[] = [];
    for (let year = lastYear; year >= firstYear; year -= 1) {
        ranges.push({
            name: String(year),
            strdate: year === firstYear && window.from ? window.from : `${year}-01-01`,
            enddate: year === lastYear && window.to ? window.to : `${year}-12-31`,
        });
    }
    const earliest = window.from ?? DATE_FLOOR;
    if (earliest < `${firstYear}-01-01`) {
        ranges.push({ name: `before ${firstYear}`, strdate: earliest, enddate: `${firstYear - 1}-12-31` });
    }
    const { fct, ...rest } = base;
    void fct;
    return Promise.all(
        ranges.map(async (range) => {
            const result = await searchWds(upstream, {
                ...rest,
                qterm,
                strdate: range.strdate,
                enddate: range.enddate,
                srt: undefined,
                order: undefined,
                rows: 0,
            });
            return { name: range.name, count: result.total };
        }),
    );
};

const NEXT_STEPS = [
    'Next steps:',
    '- To answer from a document, call read_document with its document_id and a question (or pages); cite page numbers.',
    '- For a project profile (objective, financing, ratings), call get_project with the project ID.',
    '- For "latest", use sort "newest": relevance order is not date order.',
    '- To change "those results", call again with the same inputs and change one (a filter, sort or offset).',
    '- For multi-step research, call retrieve_skill first.',
];

const groupByStage = async (
    input: SearchDocumentsInput,
    base: Record<string, ParamValue>,
    keywords: Keywords,
    interpretedAs: string[],
    filters: string[],
    upstream: Upstream,
): Promise<CallToolResult> => {
    const perGroup = input.limit ?? DEFAULT_LIMIT;
    // One list, newest first; keywords as typed (the first variant) so the grouping covers one record set.
    const qterm = keywords.qterms[0];
    const result = await searchWds(upstream, {
        ...base,
        qterm,
        fl: FIELDS.replace(',abstracts', ''),
        srt: 'docdt',
        order: 'desc',
        rows: MAX_PROJECT_RECORDS,
        os: 0,
    });
    const groups = new Map<string, DocumentRecord[]>();
    for (const stage of [...STAGES.map((s) => s.stage), OTHER_STAGE]) groups.set(stage, []);
    const records = [...result.records].sort(byDate('desc'));
    for (const record of records) groups.get(stageOf(record.documentType))!.push(record);

    const id = input.project_id!.toUpperCase();
    const sections = [
        `World Bank Documents & Reports: public documents of project ${id}, grouped by stage.`,
        [
            `Matching document records: ${number(result.total)}${result.records.length < result.total ? ` (grouped: the newest ${number(result.records.length)})` : ''}.`,
            `Each group lists its documents newest first (by document date), up to ${perGroup}.`,
        ].join(' '),
        [
            'Query as executed:',
            `- ${qterm ? `keywords ${qterm}` : 'no keywords'}: ${number(result.total)} matching records · ${sentQuery(result.query.params)}`,
            `- Filters: ${filters.join('; ')}`,
        ].join('\n'),
    ];
    if (interpretedAs.length) sections.push(['Interpreted as:', ...interpretedAs.map((s) => `- ${s}`)].join('\n'));
    const footer = [
        'Stages follow a fixed table of document types; "Restructuring and additional financing" holds Project Papers, which cover both.',
        ...NEXT_STEPS,
        `- For all records of one group, call search_documents with project_id ${id}, its document_types and sort "newest".`,
    ].join('\n');
    const blocks: string[] = [];
    for (const [stage, list] of groups) {
        if (!list.length) continue;
        const types = [...new Set(list.map((r) => r.documentType ?? 'no type'))];
        const header = `## ${stage}: ${list.length} document${list.length > 1 ? 's' : ''} (${types.join(', ')})`;
        const shown = list.slice(0, perGroup).map((r, i) => renderDocument(r, i + 1, false));
        const more = list.length > perGroup ? `\n   … ${list.length - perGroup} older in this group` : '';
        blocks.push([header, ...shown].join('\n') + more);
    }
    if (!blocks.length) blocks.push('No public documents matched.');
    const added = addWithinBudget(sections, blocks, footer.length);
    if (added < blocks.length) {
        sections.push(
            `Output truncated after ${added} of ${blocks.length} groups to stay within the size limit; ask for the remaining groups with document_types.`,
        );
    }
    sections.push(footer);
    return textResult(sections.join('\n\n'));
};

export const runSearchDocuments = async (
    input: SearchDocumentsInput,
    deps: SearchDeps = {},
    ctx?: ServerContext,
): Promise<CallToolResult> => {
    try {
        if (input.group_by_stage && !input.project_id) {
            throw new ToolInputError('group_by_stage needs a project_id.');
        }
        const window = dateWindow(input.date_from, input.date_to, ['date_from', 'date_to']);
        const resolved = await resolveInputs(
            [
                {
                    input: 'countries',
                    terms: input.countries ?? [],
                    target: { api: 'wds', lists: ['countries', 'regions'] },
                },
                {
                    input: 'region',
                    terms: input.region ? [input.region] : [],
                    target: { api: 'wds', lists: ['regions', 'countries'] },
                },
                {
                    input: 'document_types',
                    terms: input.document_types ?? [],
                    target: { api: 'wds', lists: ['documentTypes'] },
                },
                {
                    input: 'language',
                    terms: input.language ? [input.language] : [],
                    target: { api: 'wds', lists: ['languages'] },
                },
            ],
            deps,
        );
        const keywords = await keywordSearches(input.query, resolved.freeText, deps);
        const hasKeywords = keywords.qterms.some(Boolean);
        const sort = input.sort ?? (hasKeywords ? 'relevance' : 'newest');
        const offset = input.offset ?? 0;
        const limit = input.limit ?? DEFAULT_LIMIT;
        const upstream = deps.upstream ?? openUpstream();
        const base: Record<string, ParamValue> = {
            fl: FIELDS,
            proid: input.project_id?.toUpperCase(),
            ...resolved.filters,
            strdate: window.from,
            enddate: window.to,
            authr: input.author?.trim(),
            repnb: input.report_number?.trim(),
            id: input.document_id,
            colti: input.collection?.trim(),
            ...(sort === 'relevance' ? {} : { srt: 'docdt', order: sort === 'newest' ? 'desc' : 'asc' }),
            ...(input.facet && input.facet !== 'year' ? { fct: FACETS[input.facet] } : {}),
        };
        const filters = filterLines(input, resolved.filters, window);

        if (input.group_by_stage) {
            return await groupByStage(input, base, keywords, resolved.interpretedAs, filters, upstream);
        }

        if (keywords.qterms.length > 1) {
            await notifyProgress(ctx, 0, `searching ${keywords.qterms.length} keyword variants`);
        }
        const search = (params: QueryParams) => searchWds(upstream, params);
        const order = sort === 'relevance' ? 'rank' : byDate(sort === 'newest' ? 'desc' : 'asc');
        const [merged, years] = await Promise.all([
            searchMerged(search, base, keywords.qterms, { offset, limit, order }),
            input.facet === 'year'
                ? yearFacet(upstream, base, keywords.qterms[0], window, (deps.now ?? (() => new Date()))())
                : undefined,
        ]);

        const several = merged.runs.length > 1;
        const totals = merged.runs.map((run) => run.result.total);
        const sortLabel =
            sort === 'relevance'
                ? 'relevance (not date order)'
                : `${sort} first, by document date${sort === 'oldest' ? ' (undated records last)' : ''}`;
        const shownTo = offset + merged.records.length;
        const sections = [
            'World Bank Documents & Reports search: matching document records.',
            [
                several
                    ? `Matching document records: up to ${number(Math.max(...totals))} per keyword variant (${totals.map(number).join(', ')}); a record matching several variants is listed once.`
                    : `Matching document records: ${number(totals[0])}.`,
                merged.records.length
                    ? `Showing ${offset + 1}–${shownTo}, ${sortLabel}.`
                    : `No records at offset ${offset}.`,
            ].join(' '),
            queryEcho(merged.runs as Run<unknown>[], keywords, filters, sortLabel, { offset, limit }).join('\n'),
        ];
        if (resolved.interpretedAs.length) {
            sections.push(['Interpreted as:', ...resolved.interpretedAs.map((s) => `- ${s}`)].join('\n'));
        }
        if (input.facet && input.facet !== 'year') {
            const facetName = FACETS[input.facet];
            const note = [
                several ? ` for the first keyword variant (${merged.runs[0].qterm})` : '',
                input.facet === 'country' ? '; a record listing several countries counts toward each' : '',
            ].join('');
            sections.push(facetSection(input.facet, merged.runs[0].result.facets[facetName] ?? [], note));
        }
        if (years) {
            const note = several
                ? ` for the first keyword variant (${merged.runs[0].qterm}), by document date`
                : ', by document date';
            sections.push(facetSection('year', years, note));
        }

        const nextOffset = offset + merged.records.length;
        const steps = [...NEXT_STEPS];
        if (merged.more)
            steps.splice(
                1,
                0,
                `- For the next ${limit} records, call again with the same inputs and offset ${nextOffset}.`,
            );
        const footer = steps.join('\n');
        const items = merged.records.map((record, i) => renderDocument(record, offset + i + 1, true));
        if (!items.length) items.push('No records matched. Try fewer filters, other keywords, or a wider date range.');
        const added = addWithinBudget(sections, items, footer.length + 400);
        if (added < merged.records.length) {
            sections.push(
                `Output truncated after ${added} of ${merged.records.length} records to stay within the size limit. For the rest, call again with offset ${offset + added}.`,
            );
        }
        sections.push(footer);
        return textResult(sections.join('\n\n'));
    } catch (error) {
        return failure('search_documents', error);
    }
};

export const searchDocuments = defineTool({
    name: 'search_documents',
    title: 'Search World Bank documents',
    description:
        'Finds World Bank Documents & Reports records (reports, project documents, working papers) by keywords, project ID, country, region, document type, language, dates, author, report number, document ID or series. With project_id it lists that project\'s documents; group_by_stage groups them by stage. sort "newest" gives the latest by document date. facet counts matching records by country, type, language or year. Every result echoes the query it ran and how each term was interpreted: to refine, call again changing one input. Expand informal names yourself where you can. For multi-step research, call retrieve_skill first.',
    inputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (args, ctx) => runSearchDocuments(args, {}, ctx),
});
