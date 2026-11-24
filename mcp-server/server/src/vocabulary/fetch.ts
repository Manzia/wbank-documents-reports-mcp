import { isUpstreamError } from '../upstream/errors';
import type { Api, QueryParams } from '../upstream/params';
import { searchProjects, searchWds } from '../upstream/search';
import { openUpstream, type Upstream } from '../upstream/transport';
import { VOCABULARY_LISTS, VOCABULARY_VERSION, type Vocabulary, type VocabularyList } from './format';

// Facets stop at 100 values (MCP-102 F4). A list that reaches the cap is rebuilt from the same facet inside each
// value of a partition field, recursively, and marked best-effort when that can't be shown complete (D7).
export const FACET_CAP = 100;
// search.worldbank.org answers bursts with 503 (MCP-102 F6), so the requests are sequential and paced.
export const DEFAULT_PACE_MS = 1500;
export const DEFAULT_MAX_REQUESTS_PER_LIST = 60;

const YEARS = '@years';
const YEAR_RANGES: [string, string][] = [
    ['1944-01-01', '1989-12-31'],
    ['1990-01-01', '1999-12-31'],
    ['2000-01-01', '2009-12-31'],
    ['2010-01-01', '2014-12-31'],
    ['2015-01-01', '2019-12-31'],
    ['2020-01-01', '2022-12-31'],
    ['2023-01-01', '2099-12-31'],
];

// The partition fields tried in turn, as in the prechecks (MCP-102, check 3).
const PARTITIONS: Record<Api, string[]> = {
    wds: ['majdocty_exact', 'admreg_exact', YEARS],
    projects: ['regionname_exact', 'status_exact', YEARS],
};

export interface FetchVocabularyOptions {
    upstream?: Upstream;
    // Requests one list may use; the first request of each list always runs. 0 keeps each list to one request.
    maxRequestsPerList?: number;
    paceMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
}

interface Facet {
    total: number;
    values: Map<string, number>;
}

interface ListState {
    used: number;
    max: number;
    notes: string[];
}

class Fetcher {
    private lastRequest = 0;

    constructor(
        private readonly upstream: Upstream,
        private readonly paceMs: number,
        private readonly sleep: (ms: number) => Promise<void>,
    ) {}

    async facet(api: Api, field: string, filters: QueryParams, state: ListState): Promise<Facet> {
        const wait = this.lastRequest + this.paceMs - Date.now();
        if (this.lastRequest > 0 && wait > 0) await this.sleep(wait);
        this.lastRequest = Date.now();
        state.used += 1;
        const params = { ...filters, rows: 0, fct: field };
        const search = api === 'wds' ? searchWds : searchProjects;
        const result = await search(this.upstream, params, { cache: false });
        const values = new Map<string, number>();
        for (const value of result.facets[field] ?? []) values.set(value.name, value.count);
        return { total: result.total, values };
    }

    // Returns the values of `field` within `filters`; `complete` is false when any part may be missing.
    async complete(
        api: Api,
        field: string,
        chain: string[],
        filters: QueryParams,
        state: ListState,
        top?: Facet,
    ): Promise<{ facet: Facet; complete: boolean }> {
        const facet = top ?? (await this.facet(api, field, filters, state));
        if (facet.values.size < FACET_CAP) return { facet, complete: true };
        const [partition, ...rest] = chain.filter(
            (c) => c !== field && !(c in filters) && !(c === YEARS && 'strdate' in filters),
        );
        const where = Object.keys(filters).length ? ` within ${JSON.stringify(filters)}` : '';
        if (!partition) {
            state.notes.push(`still ${FACET_CAP} values${where} with no field left to partition on`);
            return { facet, complete: false };
        }
        let parts: QueryParams[];
        if (partition === YEARS) {
            parts = YEAR_RANGES.map(([strdate, enddate]) => ({ strdate, enddate }));
        } else {
            if (state.used >= state.max) return this.outOfBudget(facet, state);
            const values = await this.facet(api, partition, filters, state);
            // An empty value acts as no filter at all (MCP-102 F4), so it is skipped.
            parts = [...values.values.keys()].filter((v) => v.length > 0).map((v) => ({ [partition]: v }));
        }
        let complete = true;
        let covered = 0;
        for (const part of parts) {
            if (state.used >= state.max) return this.outOfBudget(facet, state);
            try {
                const sub = await this.complete(api, field, rest, { ...filters, ...part }, state);
                complete &&= sub.complete;
                covered += sub.facet.total;
                for (const [value, count] of sub.facet.values) {
                    facet.values.set(value, Math.max(facet.values.get(value) ?? 0, count));
                }
            } catch (error) {
                if (!isUpstreamError(error)) throw error;
                state.notes.push(`partition ${JSON.stringify({ ...filters, ...part })} failed: ${error.message}`);
                complete = false;
            }
        }
        // Records without the partition field are in no partition, so their values may be missing.
        if (complete && covered < facet.total) {
            state.notes.push(
                `${facet.total - covered} records${where} have no ${partition === YEARS ? 'date' : partition}`,
            );
            complete = false;
        }
        return { facet, complete };
    }

    private outOfBudget(facet: Facet, state: ListState): { facet: Facet; complete: boolean } {
        if (!state.notes.some((note) => note.startsWith('request budget'))) {
            state.notes.push(`request budget (${state.max}) reached`);
        }
        return { facet, complete: false };
    }
}

const toList = (api: Api, parameter: string, facet: Facet, complete: boolean, state: ListState): VocabularyList => ({
    api,
    parameter,
    complete,
    notes: state.notes,
    requests: state.used,
    values: [...facet.values]
        .filter(([value]) => value.length > 0)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
});

// Builds the snapshot from the WDS and Projects API facets. The first request of every list must succeed, or
// this throws and nothing should be written (MCP-135); a failed partition only makes its list best-effort.
export const fetchVocabulary = async (options: FetchVocabularyOptions = {}): Promise<Vocabulary> => {
    const fetcher = new Fetcher(
        options.upstream ?? openUpstream(),
        options.paceMs ?? DEFAULT_PACE_MS,
        options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
    const max = Math.max(1, options.maxRequestsPerList ?? DEFAULT_MAX_REQUESTS_PER_LIST);
    const build = async (api: Api, lists: Record<string, string>) => {
        const out: Record<string, VocabularyList> = {};
        for (const [name, parameter] of Object.entries(lists)) {
            const state: ListState = { used: 0, max, notes: [] };
            const top = await fetcher.facet(api, parameter, {}, state);
            const { facet, complete } = await fetcher.complete(api, parameter, PARTITIONS[api], {}, state, top);
            out[name] = toList(api, parameter, facet, complete, state);
        }
        return out;
    };
    const wds = await build('wds', VOCABULARY_LISTS.wds);
    const projects = await build('projects', VOCABULARY_LISTS.projects);
    return {
        version: VOCABULARY_VERSION,
        fetchedAt: (options.now?.() ?? new Date()).toISOString(),
        lists: { wds, projects } as Vocabulary['lists'],
    };
};
