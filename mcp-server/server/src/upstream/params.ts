import { UpstreamError } from './errors';

// Query building uses the APIs' own parameter names, checked against these allow-lists (design §5). The lists
// are the documented parameters, each confirmed live in the build prechecks (context/ops/records/MCP-102.md,
// check 3). Nothing outside them is ever sent, whoever supplied it: a tool, Haiku, the client or document text.
export type Api = 'wds' | 'projects';

export const API_URLS: Record<Api, string> = {
    wds: 'https://search.worldbank.org/api/v3/wds',
    projects: 'https://search.worldbank.org/api/v2/projects',
};

const API_LABELS: Record<Api, string> = { wds: 'Documents & Reports (WDS)', projects: 'Projects' };

const CONTROLS = ['format', 'fl', 'rows', 'os', 'srt', 'order', 'fct'] as const;

export const WDS_FILTERS = [
    'qterm',
    'proid',
    'count_exact',
    'admreg_exact',
    'docty_exact',
    'majdocty_exact',
    'lang_exact',
    'strdate',
    'enddate',
    'repnb',
    'id',
    'guid',
    'display_title',
    'authr',
    'colti',
    'lndinstr_exact',
] as const;

export const PROJECTS_FILTERS = [
    'qterm',
    'id',
    'countrycode_exact',
    'countryshortname_exact',
    'regionname_exact',
    'status_exact',
    'sector_exact',
    'theme_exact',
    'strdate',
    'enddate',
    'frmYear',
    'toYear',
    'lendinginstr_exact',
] as const;

export const ALLOWED_PARAMETERS: Record<Api, ReadonlySet<string>> = {
    wds: new Set([...CONTROLS, ...WDS_FILTERS]),
    projects: new Set([...CONTROLS, ...PROJECTS_FILTERS]),
};

// `srt` values that sort (MCP-102 F5). Projects `closingdate` doesn't sort correctly, so tools sort by closing
// date in code.
export const SORT_FIELDS: Record<Api, ReadonlySet<string>> = {
    wds: new Set(['docdt']),
    projects: new Set(['boardapprovaldate']),
};

export const FACET_FIELDS: Record<Api, ReadonlySet<string>> = {
    wds: new Set(['count_exact', 'admreg_exact', 'docty_exact', 'majdocty_exact', 'lang_exact', 'lndinstr_exact']),
    projects: new Set([
        'countrycode_exact',
        'countryshortname_exact',
        'regionname_exact',
        'status_exact',
        'sector_exact',
        'theme_exact',
        'lendinginstr_exact',
    ]),
};

// WDS caps `os` (Azure Search's $skip limit); larger values fail upstream.
export const MAX_ROWS = 1000;
export const MAX_OFFSET = 100_000;
export const MAX_VALUE_LENGTH = 500;

// `strdate` without `enddate` returns a different set (MCP-102 F5), so both are always sent. Dates before the
// World Bank existed are placeholders (year 1, 1900-01-01) and are left out of an open-ended range.
export const DATE_FLOOR = '1944-01-01';
export const DATE_CEILING = '2099-12-31';

export type ParamValue = string | number | readonly string[] | undefined;
export type QueryParams = Readonly<Record<string, ParamValue>>;

export interface BuiltQuery {
    api: Api;
    // The parameters as sent, in order.
    params: Record<string, string>;
    url: URL;
}

const refuse = (api: Api, message: string): never => {
    throw new UpstreamError('refused-parameter', `Refused to query the ${API_LABELS[api]} API: ${message}`);
};

const isDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const integer = (api: Api, name: string, value: string, max: number): string => {
    if (!/^\d{1,7}$/.test(value) || Number(value) > max)
        refuse(api, `'${name}' must be a whole number from 0 to ${max}.`);
    return String(Number(value));
};

const fieldList = (api: Api, name: string, value: string, allowed?: ReadonlySet<string>): string => {
    const fields = value.split(',').map((field) => field.trim());
    for (const field of fields) {
        const ok = allowed ? allowed.has(field) : field === '*' || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field);
        if (!ok) refuse(api, `'${field}' is not a field that '${name}' accepts.`);
    }
    return fields.join(',');
};

const text = (api: Api, name: string, value: string | number | readonly string[]): string => {
    const parts = Array.isArray(value) ? value : [String(value)];
    for (const part of parts) {
        if (typeof part !== 'string') refuse(api, `'${name}' values must be text.`);
        // Control characters never belong in a search value; a caret would join values (WDS treats it as OR).
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(part) || (Array.isArray(value) && part.includes('^'))) {
            refuse(api, `'${name}' contains characters that cannot be sent.`);
        }
    }
    const joined = parts.join('^');
    if (joined.length > MAX_VALUE_LENGTH) refuse(api, `'${name}' is longer than ${MAX_VALUE_LENGTH} characters.`);
    return joined;
};

const checkValue = (api: Api, name: string, value: string | number | readonly string[]): string => {
    const single = Array.isArray(value) ? undefined : String(value);
    switch (name) {
        case 'format':
            if (single !== 'json') refuse(api, "'format' can only be json.");
            return 'json';
        case 'rows':
            return integer(api, name, single ?? '', MAX_ROWS);
        case 'os':
            return integer(api, name, single ?? '', MAX_OFFSET);
        case 'order':
            if (single !== 'asc' && single !== 'desc') refuse(api, "'order' must be asc or desc.");
            return single as string;
        case 'srt':
            if (single === undefined || !SORT_FIELDS[api].has(single)) refuse(api, `'${single}' is not a sort field.`);
            return single as string;
        case 'fct':
            return fieldList(api, name, single ?? '', FACET_FIELDS[api]);
        case 'fl':
            return fieldList(api, name, single ?? '');
        case 'strdate':
        case 'enddate':
            if (single === undefined || !isDate(single)) refuse(api, `'${name}' must be a date as YYYY-MM-DD.`);
            return single as string;
        case 'frmYear':
        case 'toYear':
            if (single === undefined || !/^\d{4}$/.test(single)) refuse(api, `'${name}' must be a four-digit year.`);
            return single as string;
        default:
            return text(api, name, value);
    }
};

const isEmpty = (value: ParamValue): value is undefined =>
    value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

// Checks every parameter before anything is sent and builds the URL. Throws UpstreamError('refused-parameter')
// for a parameter outside the allow-list or a value the API would reject.
export const buildQuery = (api: Api, params: QueryParams): BuiltQuery => {
    const allowed = ALLOWED_PARAMETERS[api];
    const sent: Record<string, string> = { format: 'json' };
    for (const [name, value] of Object.entries(params)) {
        if (!allowed.has(name)) refuse(api, `'${name}' is not a parameter this server sends.`);
        if (isEmpty(value)) continue;
        sent[name] = checkValue(api, name, value);
    }
    const oldestFirst = api === 'wds' && sent.srt === 'docdt' && sent.order === 'asc';
    if (sent.strdate || sent.enddate || oldestFirst) {
        sent.strdate ??= DATE_FLOOR;
        sent.enddate ??= DATE_CEILING;
        if (sent.strdate > sent.enddate) refuse(api, "'strdate' is after 'enddate'.");
    }
    const url = new URL(API_URLS[api]);
    for (const [name, value] of Object.entries(sent)) url.searchParams.set(name, value);
    return { api, params: sent, url };
};
