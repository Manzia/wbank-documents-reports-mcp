import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ProjectRecord } from '../upstream/normalise';
import { MAX_OFFSET, type ParamValue, type QueryParams } from '../upstream/params';
import { searchProjects as searchProjectsApi, type SearchResult } from '../upstream/search';
import { openUpstream } from '../upstream/transport';
import {
    DATE_INPUT,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MAX_TERMS,
    addWithinBudget,
    dateWindow,
    failure,
    field,
    fieldList,
    joinParts,
    keywordSearches,
    notifyProgress,
    number,
    recordKey,
    resolveInputs,
    searchMerged,
    sentQuery,
    type Merged,
    type Run,
    type SearchDeps,
} from './search-documents';
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// The Projects API doesn't filter or sort by closing date correctly (MCP-102 F5), so the tool does both over
// the first matches, up to this many.
export const MAX_CLOSING_SCAN = 300;

const FIELDS = [
    'id',
    'project_name',
    'countryshortname',
    'regionname',
    'status',
    'boardapprovaldate',
    'closingdate',
    'curr_total_commitment',
    'totalcommamt',
    'curr_project_cost',
    'lendinginstr',
    'impagency',
    'url',
].join(',');

const SORTS = ['relevance', 'approval_newest', 'approval_oldest', 'closing_soonest', 'closing_latest'] as const;
type Sort = (typeof SORTS)[number];

const inputSchema = z.object({
    query: z
        .string()
        .max(500)
        .optional()
        .describe('Sector or topic keywords, e.g. "rural water supply"; quote exact phrases.'),
    countries: z
        .array(z.string().max(200))
        .max(MAX_TERMS)
        .optional()
        .describe('Plain country names, e.g. ["Peru", "Bolivia"] (any of them).'),
    region: z.string().max(200).optional().describe('e.g. "South Asia", "Latin America and Caribbean".'),
    status: z.string().max(50).optional().describe('Active, Closed, Pipeline or Dropped.'),
    sector: z.string().max(200).optional().describe('e.g. "Health", "Irrigation and Drainage".'),
    theme: z.string().max(200).optional(),
    approval_from: DATE_INPUT.optional(),
    approval_to: DATE_INPUT.optional(),
    closing_from: DATE_INPUT.optional(),
    closing_to: DATE_INPUT.optional(),
    sort: z
        .enum(SORTS)
        .optional()
        .describe('Default: relevance with a query, else approval_newest. closing_soonest for "approaching closing".'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
    offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
});

export type SearchProjectsInput = z.infer<typeof inputSchema>;

const byDate =
    (key: 'approvalDate' | 'closingDate', direction: 'asc' | 'desc') =>
    (a: ProjectRecord, b: ProjectRecord): number => {
        // Undated projects go last either way.
        const x = a[key] ?? (direction === 'asc' ? '9999' : '0000');
        const y = b[key] ?? (direction === 'asc' ? '9999' : '0000');
        return direction === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
    };

// "174,940,000" or 174940000 → "US$174.9 million"; the Projects API gives curr_* amounts in millions.
const usd = (raw: unknown, millions = false): string | undefined => {
    const text = field(raw);
    if (!text) return undefined;
    const value = Number(text.replace(/,/g, '')) * (millions ? 1_000_000 : 1);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    if (value >= 1e9) return `US$${(value / 1e9).toFixed(2)} billion`;
    return `US$${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)} million`;
};

const financing = (f: Readonly<Record<string, unknown>>): string => {
    const commitment = usd(f.totalcommamt);
    const current = usd(f.curr_total_commitment, true);
    const cost = usd(f.curr_project_cost);
    const parts = [
        commitment ? `Commitment: ${commitment}` : current ? `Commitment: ${current}` : 'Commitment: not given',
        commitment && current && current !== commitment && `current commitment ${current}`,
        cost && `total project cost ${cost} (a cost, not a commitment)`,
    ];
    return joinParts(parts);
};

const renderProject = (record: ProjectRecord, index: number): string => {
    const f = record.fields;
    return [
        `${index}. ${record.title} (${record.projectId ?? 'no ID'})`,
        `   ${joinParts([
            field(f.countryshortname) && `Country: ${field(f.countryshortname)}`,
            field(f.regionname) && `Region: ${field(f.regionname)}`,
            field(f.status) && `Status: ${field(f.status)}`,
        ])}`,
        `   ${joinParts([`Approved: ${record.approvalDate ?? 'not given'}`, `Closing: ${record.closingDate ?? 'not given'}`])}`,
        `   ${financing(f)}`,
        `   ${joinParts([
            field(f.lendinginstr) && `Lending instrument: ${field(f.lendinginstr)}`,
            fieldList(f.impagency, 'impagency') && `Implementing agency: ${fieldList(f.impagency, 'impagency')}`,
        ])}`,
        `   Record: ${record.recordUrl ?? 'none listed'}`,
    ]
        .filter((line) => line.trim())
        .join('\n');
};

// Closing-date filter and sort, in code over the first MAX_CLOSING_SCAN matches of each keyword variant.
const closingSearch = async (
    search: (params: QueryParams) => Promise<SearchResult<ProjectRecord>>,
    base: Record<string, ParamValue>,
    qterms: (string | undefined)[],
    window: { from?: string; to?: string },
    sort: Sort,
    page: { offset: number; limit: number },
): Promise<Merged<ProjectRecord> & { scanned: boolean }> => {
    const runs: Run<ProjectRecord>[] = await Promise.all(
        qterms.map(async (qterm) => ({
            qterm,
            result: await search({ ...base, qterm, rows: MAX_CLOSING_SCAN, os: 0 }),
        })),
    );
    const seen = new Set<string>();
    const matching = runs
        .flatMap((run) => run.result.records)
        .filter((record) => {
            const key = recordKey(record);
            if (seen.has(key)) return false;
            seen.add(key);
            const closing = record.closingDate;
            if (window.from && (!closing || closing < window.from)) return false;
            if (window.to && (!closing || closing > window.to)) return false;
            return true;
        });
    if (sort === 'closing_soonest' || sort === 'closing_latest') {
        matching.sort(byDate('closingDate', sort === 'closing_soonest' ? 'asc' : 'desc'));
    }
    return {
        runs,
        records: matching.slice(page.offset, page.offset + page.limit),
        more: matching.length > page.offset + page.limit,
        scanned: runs.some((run) => run.result.total > run.result.records.length),
    };
};

const NEXT_STEPS = [
    'Next steps:',
    '- For a project profile (objective, financing, ISR and IEG ratings), call get_project with its project ID.',
    "- For a project's documents (PAD, ISRs, ICR), call search_documents with its project_id (group_by_stage for an overview).",
    '- To change "those results", call again with the same inputs and change one (a filter, sort or offset).',
    '- For multi-step research such as comparable operations, call retrieve_skill first.',
];

const SORT_LABELS: Record<Sort, string> = {
    relevance: 'relevance (not date order)',
    approval_newest: 'newest approval first',
    approval_oldest: 'oldest approval first',
    closing_soonest: 'soonest closing date first (projects without one last)',
    closing_latest: 'latest closing date first (projects without one last)',
};

export const runSearchProjects = async (
    input: SearchProjectsInput,
    deps: SearchDeps = {},
    ctx?: ServerContext,
): Promise<CallToolResult> => {
    try {
        const approval = dateWindow(input.approval_from, input.approval_to, ['approval_from', 'approval_to']);
        const closing = dateWindow(input.closing_from, input.closing_to, ['closing_from', 'closing_to']);
        const resolved = await resolveInputs(
            [
                {
                    input: 'countries',
                    terms: input.countries ?? [],
                    target: { api: 'projects', lists: ['countries', 'regions'] },
                },
                {
                    input: 'region',
                    terms: input.region ? [input.region] : [],
                    target: { api: 'projects', lists: ['regions', 'countries'] },
                },
                {
                    input: 'status',
                    terms: input.status ? [input.status] : [],
                    target: { api: 'projects', lists: ['statuses'] },
                },
                {
                    input: 'sector',
                    terms: input.sector ? [input.sector] : [],
                    target: { api: 'projects', lists: ['sectors'] },
                },
                {
                    input: 'theme',
                    terms: input.theme ? [input.theme] : [],
                    target: { api: 'projects', lists: ['themes'] },
                },
            ],
            deps,
        );
        const keywords = await keywordSearches(input.query, resolved.freeText, deps);
        const hasKeywords = keywords.qterms.some(Boolean);
        const sort: Sort = input.sort ?? (hasKeywords ? 'relevance' : 'approval_newest');
        const offset = input.offset ?? 0;
        const limit = input.limit ?? DEFAULT_LIMIT;
        const upstream = deps.upstream ?? openUpstream();
        const inCode = Boolean(closing.from || closing.to || sort.startsWith('closing'));
        const approvalSort = sort.startsWith('approval') || (inCode && sort !== 'relevance');
        const base: Record<string, ParamValue> = {
            fl: FIELDS,
            ...resolved.filters,
            strdate: approval.from,
            enddate: approval.to,
            ...(approvalSort ? { srt: 'boardapprovaldate', order: sort === 'approval_oldest' ? 'asc' : 'desc' } : {}),
        };
        if (keywords.qterms.length > 1) {
            await notifyProgress(ctx, 0, `searching ${keywords.qterms.length} keyword variants`);
        }
        const search = (params: QueryParams) => searchProjectsApi(upstream, params);
        const merged = inCode
            ? await closingSearch(search, base, keywords.qterms, closing, sort, { offset, limit })
            : {
                  ...(await searchMerged(search, base, keywords.qterms, {
                      offset,
                      limit,
                      order:
                          sort === 'relevance'
                              ? 'rank'
                              : byDate('approvalDate', sort === 'approval_oldest' ? 'asc' : 'desc'),
                  })),
                  scanned: false,
              };

        const filters = [
            resolved.filters.countryshortname_exact &&
                `country: ${resolved.filters.countryshortname_exact.join(' or ')}`,
            resolved.filters.regionname_exact && `region: ${resolved.filters.regionname_exact.join(' or ')}`,
            resolved.filters.status_exact && `status: ${resolved.filters.status_exact.join(' or ')}`,
            resolved.filters.sector_exact && `sector: ${resolved.filters.sector_exact.join(' or ')}`,
            resolved.filters.theme_exact && `theme: ${resolved.filters.theme_exact.join(' or ')}`,
            (approval.from || approval.to) && `approval date ${approval.from ?? 'any'} to ${approval.to ?? 'any'}`,
            (closing.from || closing.to) &&
                `closing date ${closing.from ?? 'any'} to ${closing.to ?? 'any'} (filtered by this server)`,
        ].filter((line): line is string => Boolean(line));
        const several = merged.runs.length > 1;
        const totals = merged.runs.map((run) => run.result.total);
        const sections = [
            'World Bank Projects & Operations search: matching projects.',
            [
                several
                    ? `Matching projects: up to ${number(Math.max(...totals))} per keyword variant (${totals.map(number).join(', ')}); a project matching several variants is listed once.`
                    : `Matching projects: ${number(totals[0])}${inCode && (closing.from || closing.to) ? ' before the closing-date filter' : ''}.`,
                merged.records.length
                    ? `Showing ${offset + 1}–${offset + merged.records.length}, ${SORT_LABELS[sort]}.`
                    : `No projects at offset ${offset}.`,
            ].join(' '),
        ];
        const echo = ['Query as executed:'];
        for (const run of merged.runs) {
            echo.push(
                `- ${run.qterm ? `keywords ${run.qterm}` : 'no keywords'}: ${number(run.result.total)} matching projects · ${sentQuery(run.result.query.params)}`,
            );
        }
        if (keywords.note) echo.push(`- ${keywords.note}`);
        echo.push(`- Filters: ${filters.length ? filters.join('; ') : 'none'}`);
        echo.push(`- Sort: ${SORT_LABELS[sort]} · limit ${limit} · offset ${offset}`);
        if (merged.scanned) {
            echo.push(
                `- Closing dates are filtered and sorted by this server over the first ${MAX_CLOSING_SCAN} matches of each search only; narrow the search (country, status, approval dates) for a complete list.`,
            );
        }
        sections.push(echo.join('\n'));
        if (resolved.interpretedAs.length) {
            sections.push(['Interpreted as:', ...resolved.interpretedAs.map((s) => `- ${s}`)].join('\n'));
        }
        sections.push(
            'Amounts: "commitment" is the World Bank financing committed (US$); total project cost is a separate figure and is not a commitment.',
        );
        const steps = [...NEXT_STEPS];
        if (merged.more) {
            steps.splice(
                1,
                0,
                `- For the next ${limit} projects, call again with the same inputs and offset ${offset + merged.records.length}.`,
            );
        }
        const footer = steps.join('\n');
        const items = merged.records.map((record, i) => renderProject(record, offset + i + 1));
        if (!items.length) items.push('No projects matched. Try fewer filters, other keywords, or wider dates.');
        const added = addWithinBudget(sections, items, footer.length + 400);
        if (added < merged.records.length) {
            sections.push(
                `Output truncated after ${added} of ${merged.records.length} projects to stay within the size limit. For the rest, call again with offset ${offset + added}.`,
            );
        }
        sections.push(footer);
        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    } catch (error) {
        return failure('search_projects', error);
    }
};

export const searchProjects = defineTool({
    name: 'search_projects',
    title: 'Search World Bank projects',
    description:
        'Finds World Bank projects (Projects & Operations) by keywords, country, region, status, sector, theme, approval dates and closing dates. Each project shows its ID, name, country, region, status, approval and closing dates, commitment (kept separate from total project cost), lending instrument, implementing agency and record link. Use it to build a set of comparable operations, or a portfolio scan (e.g. status Active, sort closing_soonest). Every result echoes the query it ran and how each term was interpreted: to refine, call again changing one input. For multi-step research, call retrieve_skill first.',
    inputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (args, ctx) => runSearchProjects(args, {}, ctx),
});
