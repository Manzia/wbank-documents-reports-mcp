import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
    isUpstreamError,
    normaliseDate,
    openUpstream,
    searchProjects,
    searchWds,
    type DocumentRecord,
    type FacetValue,
    type ProjectRecord,
    type Upstream,
} from '../upstream';
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// Design §5.3: a profile from the full Projects record. Commitments stay separate from project cost, and
// implementation status is always labelled as coming from the latest *disclosed* ISR, with its date.

export const ISR_TYPE = 'Implementation Status and Results Report';
export const MAX_INDICATORS = 30;
const ISR_FIELDS = 'id,docdt,disclosure_date,docty,repnb,display_title,url,pdfurl,projectid';

type Raw = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

// Text of a field: strings, numbers, {"cdata!": "..."} and the first item of a list.
const textOf = (value: unknown): string | null => {
    if (Array.isArray(value)) return textOf(value[0]);
    if (isObject(value)) return textOf(value['cdata!']);
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed && trimmed.toUpperCase() !== 'NIL' ? trimmed : null;
};

const listOf = (value: unknown): string[] => {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return items.map(textOf).filter((item): item is string => item !== null);
};

const numberOf = (value: unknown): number | null => {
    const raw = textOf(value);
    if (raw === null) return null;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const usd = (dollars: number): string =>
    `US$${(dollars / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} million`;

// "MODERATELY UNSATISFACTORY" → "Moderately Unsatisfactory"
const rating = (value: string): string =>
    value === value.toUpperCase() ? value.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : value;

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decodeXml = (text: string): string =>
    text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
        if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
        if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
        return XML_ENTITIES[code.toLowerCase()] ?? entity;
    });

const attribute = (tag: string, name: string): string =>
    decodeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '').trim();

const element = (xml: string, name: string): string =>
    decodeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '').trim();

// ---------- Results indicators ----------

export interface IndicatorValue {
    value: string;
    date: string | null;
}

export interface Indicator {
    name: string;
    unit: string;
    type: string;
    child: boolean;
    baseline?: IndicatorValue;
    latest?: IndicatorValue;
    target?: IndicatorValue;
}

export interface ResultsFramework {
    sequence: string;
    from: string | null;
    indicators: Indicator[];
}

const compactDate = (value: string): string | null => {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const valuesOf = (body: string, tag: string): Record<string, IndicatorValue> => {
    const last: Record<string, { order: string; value: IndicatorValue }> = {};
    for (const [, transaction] of body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))) {
        const value = element(transaction, 'VALUE');
        if (!value) continue;
        const type = element(transaction, 'ValueType');
        const order = element(transaction, 'SortOrder');
        // Baseline: the first; progress and target: the latest by sort order.
        const keep =
            type === 'BS'
                ? !last[type]
                : !last[type] || order.localeCompare(last[type].order, 'en', { numeric: true }) > 0;
        if (keep) last[type] = { order, value: { value, date: compactDate(element(transaction, 'ValueDate')) } };
    }
    return Object.fromEntries(Object.entries(last).map(([type, { value }]) => [type, value]));
};

const indicatorOf = (tag: string, body: string, child: boolean): Indicator => {
    const values = valuesOf(body, child ? 'ChildTransaction' : 'ParentTransaction');
    return {
        name: attribute(tag, 'IndicatorName'),
        unit: attribute(tag, 'IndicatorUOMName'),
        type: attribute(tag, 'IndicatorTypeName'),
        child,
        baseline: values.BS,
        latest: values.PG,
        target: values.TG,
    };
};

// The Projects API carries the results framework as XML in `indicatormappingdata`; the latest filled-in form is
// used. Parsed with patterns only: nothing in it is executed or followed.
export const parseResultsFramework = (xml: unknown): ResultsFramework | null => {
    if (typeof xml !== 'string') return null;
    let best: { sequence: number; tag: string; body: string } | null = null;
    for (const [, tag, body] of xml.matchAll(/<Indicators\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Indicators>)/g)) {
        if (!body || !body.includes('<ParentIndicator')) continue;
        const sequence = Number(attribute(tag, 'SequenceNumber')) || 0;
        if (!best || sequence > best.sequence) best = { sequence, tag, body };
    }
    if (!best) return null;
    const indicators: Indicator[] = [];
    for (const [, tag, body] of best.body.matchAll(/<ParentIndicator\b([^>]*)>([\s\S]*?)<\/ParentIndicator>/g)) {
        const parent = indicatorOf(tag, body.replace(/<ChildIndicator\b[\s\S]*?<\/ChildIndicator>/g, ''), false);
        if (!parent.name) continue;
        indicators.push(parent);
        for (const [, childTag, childBody] of body.matchAll(/<ChildIndicator\b([^>]*)>([\s\S]*?)<\/ChildIndicator>/g)) {
            const child = indicatorOf(childTag, childBody, true);
            if (child.name) indicators.push(child);
        }
    }
    const from = normaliseDate(attribute(best.tag, 'FromDate'));
    return { sequence: attribute(best.tag, 'SequenceNumber'), from, indicators };
};

const formatValue = ({ value, date }: IndicatorValue): string => {
    const shown = /^-?\d+(?:\.\d+)?$/.test(value)
        ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
        : value.replace(/\s+/g, ' ');
    return date ? `${shown} (${date})` : shown;
};

const indicatorLines = (framework: ResultsFramework): string[] => {
    // PDO indicators first, each followed by its sub-indicators.
    const groups: Indicator[][] = [];
    for (const indicator of framework.indicators) {
        if (indicator.child && groups.length) groups[groups.length - 1].push(indicator);
        else groups.push([indicator]);
    }
    const isPdo = (group: Indicator[]) => /\bPDO\b/i.test(group[0].type);
    const ordered = [...groups.filter(isPdo), ...groups.filter((group) => !isPdo(group))].flat();
    const lines = ordered.slice(0, MAX_INDICATORS).map((indicator) => {
        const parts = [
            indicator.baseline && `baseline ${formatValue(indicator.baseline)}`,
            indicator.latest && `latest ${formatValue(indicator.latest)}`,
            indicator.target && `target ${formatValue(indicator.target)}`,
        ].filter(Boolean);
        const kind = indicator.child ? '' : /\bPDO\b/i.test(indicator.type) ? 'PDO indicator: ' : 'Intermediate: ';
        const unit = indicator.unit ? ` (${indicator.unit})` : '';
        return `${indicator.child ? '  ' : ''}- ${kind}${indicator.name}${unit}: ${parts.join('; ') || 'no values'}`;
    });
    if (ordered.length > MAX_INDICATORS) lines.push(`- (${ordered.length - MAX_INDICATORS} more indicators left out)`);
    return lines;
};

// ---------- Profile ----------

export interface ProjectExtras {
    // Counts of matching document records by type, with the total; null when the search failed.
    documents: { total: number; byType: FacetValue[] } | null;
    latestIsr: DocumentRecord | null;
    notes: string[];
}

const line = (label: string, value: string | null | undefined): string | null =>
    value ? `- ${label}: ${value}` : null;

const section = (title: string, lines: (string | null | undefined)[]): string => {
    const shown = lines.filter((item): item is string => Boolean(item));
    return `## ${title}\n${shown.length ? shown.join('\n') : '- Not in the Projects API record.'}`;
};

const sectorsOf = (fields: Raw): string[] => {
    const sectors: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
        const value = fields[`sector${i}`];
        if (isObject(value) && textOf(value.Name)) {
            const percent = numberOf(value.Percent);
            sectors.push(`${textOf(value.Name)}${percent ? ` (${percent}%)` : ''}`);
        } else if (typeof value === 'string') {
            // "Name!$!percent!$!code"
            const [name, percent] = value.split('!$!');
            if (name) sectors.push(`${name.trim()}${Number(percent) ? ` (${Number(percent)}%)` : ''}`);
        }
    }
    return sectors.length ? sectors : listOf(fields.sector_exact);
};

const themesOf = (fields: Raw): string[] => {
    const themes = Array.isArray(fields.theme_list) ? fields.theme_list.filter(isObject) : [];
    if (!themes.length) return listOf(fields.themev2_level1_exact ?? fields.theme_exact);
    return themes.map((theme) => {
        const below = (Array.isArray(theme.theme2) ? theme.theme2 : []).filter(isObject).map((t) => textOf(t.name));
        const names = below.filter(Boolean).join('; ');
        return `${textOf(theme.name)}${names ? ` (${names})` : ''}`;
    });
};

const financing = (fields: Raw): string[] => {
    const lines: (string | null)[] = [];
    const ida = numberOf(fields.idacommamt);
    const ibrd = numberOf(fields.ibrdcommamt);
    const bank = numberOf(fields.totalamt);
    if (bank !== null) {
        const split = [ida && `IDA ${usd(ida)}`, ibrd && `IBRD ${usd(ibrd)}`].filter(Boolean).join(', ');
        lines.push(line('World Bank commitment at approval (IBRD + IDA)', `${usd(bank)}${split ? ` (${split})` : ''}`));
    }
    const grant = numberOf(fields.grantamt);
    if (grant) lines.push(line('Grant commitment', usd(grant)));
    const total = numberOf(fields.totalcommamt);
    if (total !== null && total !== bank)
        lines.push(line('Total commitment at approval, including grants', usd(total)));
    const currentIda = numberOf(fields.curr_ida_commitment);
    const currentIbrd = numberOf(fields.curr_ibrd_commitment);
    if (currentIda !== null || currentIbrd !== null) {
        const current = [currentIda && `IDA ${usd(currentIda * 1e6)}`, currentIbrd && `IBRD ${usd(currentIbrd * 1e6)}`];
        lines.push(
            line('Current World Bank commitment, net of cancellations', current.filter(Boolean).join(', ') || usd(0)),
        );
    }
    const allFinanciers = numberOf(fields.curr_total_commitment);
    if (allFinanciers !== null) {
        lines.push(line('Current total commitment, including co-financiers', usd(allFinanciers * 1e6)));
    }
    const names = listOf(fields.fincrname);
    const amounts = (Array.isArray(fields.fincr_usd_amt) ? fields.fincr_usd_amt : []).map(numberOf);
    if (names.length && names.length === amounts.length) {
        const sources = names.map(
            (name, i) => `${name} ${amounts[i] === null ? 'amount not given' : usd(amounts[i] as number)}`,
        );
        lines.push(line('Financing plan by source (current, including any borrower contribution)', sources.join('; ')));
    }
    const cost = numberOf(fields.lendprojectcost);
    const currentCost = numberOf(fields.curr_project_cost);
    if (cost !== null || currentCost !== null) {
        const costs = [
            cost !== null && usd(cost),
            currentCost !== null && currentCost !== cost && `current ${usd(currentCost)}`,
        ];
        lines.push(
            line('Total project cost (all sources; not a World Bank commitment)', costs.filter(Boolean).join('; ')),
        );
    }
    return lines.filter((item): item is string => item !== null);
};

const ratingsOf = (fields: Raw): string[] => {
    const lines: string[] = [];
    const names = (textOf(fields.performance_templatename) ?? '').split(',').map((name) => name.trim());
    const current = listOf(fields.performance_currrating);
    const previous = listOf(fields.performance_prevrating);
    const date = normaliseDate(fields.statusdate);
    const previousDate = normaliseDate(fields.laststatusdate);
    current.forEach((value, i) => {
        const before = previous[i] ? ` (previous ISR${previousDate ? `, ${previousDate}` : ''}: ${previous[i]})` : '';
        lines.push(`- ${names[i] || `Rating ${i + 1}`}: ${value}${before}`);
    });
    const risk = textOf(fields.overall_currentrating);
    if (risk) lines.push(`- ${textOf(fields.catname) ?? 'Overall risk'}: ${risk}`);
    if (!lines.length) return ['- No ISR ratings in the Projects API record.'];
    return [
        `ISR ratings as recorded in the Projects API, from the disclosed ISR dated ${date ?? 'not given'} (latest disclosed ISR the Projects API holds):`,
        ...lines,
    ];
};

const isrLines = (fields: Raw, isr: DocumentRecord | null, notes: string[]): string[] => {
    if (!isr) {
        return notes.some((note) => note.includes('ISR'))
            ? []
            : ['- No disclosed ISR for this project in Documents & Reports.'];
    }
    const date = normaliseDate(fields.statusdate);
    const ids = [isr.documentId && `document ID ${isr.documentId}`, isr.reportNumber && `report ${isr.reportNumber}`];
    const lines = [
        `- Latest disclosed ISR in Documents & Reports: "${isr.title}", dated ${isr.documentDate ?? 'not given'} (${ids.filter(Boolean).join(', ')})${isr.recordUrl ? `, ${isr.recordUrl}` : ''}`,
    ];
    if (isr.documentDate && (!date || isr.documentDate > date)) {
        lines.push(
            `- That ISR is newer than the ratings above: read it with read_document (document_id ${isr.documentId}) for its ratings.`,
        );
    }
    return lines;
};

const iegLines = (fields: Raw): string[] => {
    const outcome = textOf(fields.outcome);
    if (!outcome) return ['- No IEG ratings in the record (IEG rates a project after its completion report).'];
    const date = normaliseDate(fields.evaldate);
    const type = textOf(fields.evaltype);
    const rated = (label: string, key: string) => {
        const value = textOf(fields[key]);
        return value ? `${label} ${rating(value)}` : null;
    };
    const parts = [
        `outcome ${rating(outcome)}`,
        rated('Bank performance', 'overallbankperf'),
        rated('quality at entry', 'bankqualityatentry'),
        rated('quality of supervision', 'bankqualityofsupervision'),
        rated('Borrower performance', 'overallborrowperf'),
        rated('government performance', 'borrowcompliance'),
        rated('implementing agency performance', 'borrowimplementation'),
        rated('ICR quality', 'icrquality'),
    ];
    const about = [type && `evaluation type ${type}`, date].filter(Boolean).join(', ');
    return [`- IEG evaluation${about ? ` (${about})` : ''}: ${parts.filter(Boolean).join('; ')}`];
};

export const renderProfile = (project: ProjectRecord, extras: ProjectExtras): string => {
    const f = project.fields;
    const id = project.projectId ?? '';
    const country = textOf(f.countryshortname) ?? textOf(f.countryname);
    const updated = normaliseDate(f.proj_last_upd_date);
    const head = [
        `# ${project.title} (${id})`,
        `Source: World Bank Projects API record${updated ? `, last updated ${updated}` : ''}.${project.recordUrl ? ` Record: ${project.recordUrl}` : ''}`,
    ].join('\n');
    const identity = section('Identity', [
        line('Status', textOf(f.status) ?? textOf(f.projectstatusdisplay)),
        line('Country', country),
        line('Region', textOf(f.regionname)),
        line('Borrower', textOf(f.borrower)),
        line('Implementing agency', textOf(f.impagency) ?? textOf(f.implementingname)),
        line('Lending instrument', textOf(f.lendinginstr)),
        line('Environmental assessment category', textOf(f.envassesmentcategorycode)),
        line('Project development objective (PDO)', textOf(f.pdo)),
    ]);
    const fiscalYear = textOf(f.approvalfy);
    const dates = section('Key dates', [
        line(
            'Board approval',
            project.approvalDate && `${project.approvalDate}${fiscalYear ? ` (FY${fiscalYear})` : ''}`,
        ),
        '- Effectiveness: not in the Projects API record; the ICR data sheet or the legal agreement gives it.',
        line('Closing (current)', project.closingDate),
    ]);
    const money = section('Financing (commitments are kept separate from project cost)', financing(f));
    const classification = section('Classification', [
        line('Sectors', sectorsOf(f).join('; ')),
        line('Themes', themesOf(f).join('; ')),
    ]);
    const framework = parseResultsFramework(f.indicatormappingdata);
    const results = framework
        ? [
              `Results indicators from the results framework the Projects API holds (sequence ${framework.sequence}${framework.from ? `, from ${framework.from}` : ''}):`,
              ...indicatorLines(framework),
          ]
        : ['- No results indicators in the Projects API record.'];
    const performance = section('Performance (implementation status from the latest disclosed ISR)', [
        ...ratingsOf(f),
        ...isrLines(f, extras.latestIsr, extras.notes),
        ...iegLines(f),
        ...results,
    ]);
    const documents = extras.documents
        ? section('Documents', [
              `- ${extras.documents.total} public document records in Documents & Reports for ${id}. Matching document records by type: ${
                  extras.documents.byType.map((value) => `${value.name} ${value.count}`).join('; ') || 'none'
              }.`,
          ])
        : null;
    const notes = extras.notes.length ? extras.notes.map((note) => `Note: ${note}`).join('\n') : null;
    const next =
        `Next steps: search_documents with project_id ${id} (and document_types, sort newest) lists the documents; ` +
        'read_document reads one (outline, then pages), e.g. the latest ISR, the PAD or the ICR.';
    return [head, identity, dates, money, classification, performance, documents, notes, next]
        .filter(Boolean)
        .join('\n\n');
};

// ---------- Tool ----------

export interface GetProjectDeps {
    upstream?: () => Upstream;
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export const loadProject = async (
    upstream: Upstream,
    projectId: string,
): Promise<{ project: ProjectRecord | null; extras: ProjectExtras }> => {
    const [projects, documents, isrs] = await Promise.allSettled([
        searchProjects(upstream, { id: projectId, fl: '*', rows: 1 }),
        searchWds(upstream, { proid: projectId, rows: 0, fct: 'docty_exact' }),
        searchWds(upstream, {
            proid: projectId,
            docty_exact: ISR_TYPE,
            fl: ISR_FIELDS,
            srt: 'docdt',
            order: 'desc',
            rows: 1,
        }),
    ]);
    if (projects.status === 'rejected') throw projects.reason;
    const project = projects.value.records.find((record) => record.projectId === projectId) ?? null;
    const notes: string[] = [];
    const reason = (result: PromiseRejectedResult) =>
        isUpstreamError(result.reason) ? result.reason.message : 'the search failed';
    if (documents.status === 'rejected') notes.push(`Document counts are unavailable: ${reason(documents)}`);
    if (isrs.status === 'rejected') notes.push(`The latest disclosed ISR could not be looked up: ${reason(isrs)}`);
    return {
        project,
        extras: {
            documents:
                documents.status === 'fulfilled'
                    ? { total: documents.value.total, byType: documents.value.facets.docty_exact ?? [] }
                    : null,
            latestIsr: isrs.status === 'fulfilled' ? (isrs.value.records[0] ?? null) : null,
            notes,
        },
    };
};

export const getProjectWith = (deps: GetProjectDeps = {}) =>
    defineTool({
        name: 'get_project',
        title: 'Get a World Bank project profile',
        description:
            'Returns the profile of one World Bank project from its Projects API record, given its project ID (e.g. P117635): ' +
            'objective (PDO), borrower, implementing agency, country, region, status; approval and closing dates; financing, with commitments kept separate from total project cost; ' +
            'sectors and themes; ISR ratings with their dates and the latest disclosed ISR, IEG ratings where they exist, results indicators; and counts of public documents by type. ' +
            'Implementation status comes from the latest disclosed ISR, not live data: say so, with its date. Use search_documents and read_document for the documents themselves.',
        inputSchema: z.object({
            project_id: z
                .string()
                .trim()
                .regex(/^[Pp]\d{5,7}$/, 'A project ID looks like P117635.')
                .describe('World Bank project ID, e.g. P117635'),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ project_id }) => {
            const projectId = project_id.toUpperCase();
            try {
                const { project, extras } = await loadProject((deps.upstream ?? openUpstream)(), projectId);
                if (!project) {
                    return failure(
                        `No World Bank project with ID ${projectId} was found in the Projects API. Check the ID, or find the project with search_projects.`,
                    );
                }
                return { content: [{ type: 'text', text: renderProfile(project, extras) }] };
            } catch (error) {
                if (isUpstreamError(error)) return failure(error.message);
                console.error(
                    JSON.stringify({
                        message: 'get_project failed',
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
                return failure('get_project failed unexpectedly. Try again shortly.');
            }
        },
    });

export const getProject = getProjectWith();
