import {
    parseProjectsResponse,
    parseWdsResponse,
    type DocumentRecord,
    type Facets,
    type ParsedResponse,
    type ProjectRecord,
} from './normalise';
import { buildQuery, type Api, type QueryParams } from './params';
import { collectPages, type RequestOptions, type Upstream } from './transport';

// Larger requests are split into pages of this size.
export const PAGE_SIZE = 100;
// The APIs' own default.
export const DEFAULT_ROWS = 10;

// The query as sent, returned with every result so a tool can echo it (design §5: "those results" without
// server state). `params` holds the whole request; `urls` every page fetched for it.
export interface SentQuery {
    api: Api;
    params: Record<string, string>;
    urls: string[];
}

export interface SearchResult<R> {
    query: SentQuery;
    total: number;
    records: R[];
    facets: Facets;
}

const search = async <R>(
    api: Api,
    parse: (body: unknown) => ParsedResponse<R>,
    upstream: Upstream,
    params: QueryParams,
    options: RequestOptions,
): Promise<SearchResult<R>> => {
    // Checked as a whole before any page is sent.
    const checked = buildQuery(api, params);
    const rows = Number(checked.params.rows ?? DEFAULT_ROWS);
    const offset = Number(checked.params.os ?? 0);
    const sent = { ...checked.params, rows: String(rows), os: String(offset) };
    const urls: string[] = [];
    let facets: Facets = {};
    const fetchPage = async (os: number, pageRows: number) => {
        const page = buildQuery(api, { ...sent, rows: String(pageRows), os: String(os) });
        urls.push(page.url.href);
        const parsed = parse(await upstream.search.getJson(page.url, options));
        if (os === offset) facets = parsed.facets;
        return { items: parsed.records, total: parsed.total };
    };
    const { items, total } =
        rows <= PAGE_SIZE
            ? await fetchPage(offset, rows)
            : await collectPages(fetchPage, { offset, limit: rows, pageSize: PAGE_SIZE });
    return { query: { api, params: sent, urls }, total, records: items, facets };
};

export const searchWds = (
    upstream: Upstream,
    params: QueryParams,
    options: RequestOptions = {},
): Promise<SearchResult<DocumentRecord>> => search('wds', parseWdsResponse, upstream, params, options);

export const searchProjects = (
    upstream: Upstream,
    params: QueryParams,
    options: RequestOptions = {},
): Promise<SearchResult<ProjectRecord>> => search('projects', parseProjectsResponse, upstream, params, options);
