import { beforeAll, describe, expect, it } from '@jest/globals';
import { FACET_CAP, fetchVocabulary } from '../../../src/vocabulary/fetch';
import { VOCABULARY_LISTS, parseVocabulary } from '../../../src/vocabulary/format';
import { blockNetwork, fixture, json, testUpstream, type Reply } from '../upstream/fake-fetch';

type Values = Record<string, number>;

// A fake facet API: `facet(field, filters)` gives the values of `field` within the filters, and their total.
type FakeFacet = (field: string, filters: Record<string, string>) => { total: number; values: Values } | Reply;

const values = (prefix: string, n: number, count = 1): Values =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, count]));

const respond = (api: 'wds' | 'projects', answer: { total: number; values: Values }, field: string) => {
    const facets = {
        [field]: Object.fromEntries(
            Object.entries(answer.values)
                .slice(0, FACET_CAP)
                .map(([name, count], i) => [
                    String(i),
                    { name, label: name, count: api === 'wds' ? count : String(count) },
                ]),
        ),
    };
    return api === 'wds'
        ? json({ total: answer.total, documents: { facets } })
        : json({ total: String(answer.total), projects: {}, facets });
};

const upstreamFor = (fake: FakeFacet) =>
    testUpstream((url) => {
        const api = url.pathname.endsWith('/wds') ? 'wds' : 'projects';
        const filters = Object.fromEntries(
            [...url.searchParams].filter(([k]) => !['format', 'rows', 'os', 'fct'].includes(k)),
        );
        const field = url.searchParams.get('fct') ?? '';
        const answer = fake(field, filters);
        return 'status' in answer || 'body' in answer
            ? (answer as Reply)
            : respond(api, answer as { total: number; values: Values }, field);
    });

const small: FakeFacet = (field) => ({ total: 10, values: { [`${field}-a`]: 7, [`${field}-b`]: 3 } });

beforeAll(blockNetwork);

describe('fetchVocabulary', () => {
    it('builds every list, sorted by count, with the date fetched', async () => {
        const { upstream, fetch } = upstreamFor(small);
        const vocabulary = await fetchVocabulary({
            upstream,
            sleep: async () => {},
            now: () => new Date('2026-11-23T12:00:00Z'),
        });
        expect(parseVocabulary(vocabulary)).toEqual(vocabulary);
        expect(vocabulary.fetchedAt).toBe('2026-11-23T12:00:00.000Z');
        expect(Object.keys(vocabulary.lists.wds)).toEqual(Object.keys(VOCABULARY_LISTS.wds));
        expect(Object.keys(vocabulary.lists.projects)).toEqual(Object.keys(VOCABULARY_LISTS.projects));
        expect(vocabulary.lists.wds.countries).toEqual({
            api: 'wds',
            parameter: 'count_exact',
            complete: true,
            notes: [],
            requests: 1,
            values: [
                { value: 'count_exact-a', count: 7 },
                { value: 'count_exact-b', count: 3 },
            ],
        });
        expect(fetch).toHaveBeenCalledTimes(9);
        expect(new URL(String(fetch.mock.calls[0][0])).search).toBe('?format=json&rows=0&fct=count_exact&os=0');
    });

    it('paces its requests', async () => {
        const { upstream } = upstreamFor(small);
        const waits: number[] = [];
        await fetchVocabulary({ upstream, paceMs: 1500, sleep: async (ms) => void waits.push(ms) });
        expect(waits).toHaveLength(8);
        for (const ms of waits) expect(ms).toBeGreaterThan(1400);
    });

    it('rebuilds a capped list from its partitions and marks it complete when they cover every record', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'count_exact' && !filters.majdocty_exact) return { total: 30, values: values('c', 150) };
            if (field === 'majdocty_exact') return { total: 30, values: { A: 20, B: 10, '': 5 } };
            if (field === 'count_exact' && filters.majdocty_exact === 'A')
                return { total: 20, values: values('c', 80, 2) };
            if (field === 'count_exact' && filters.majdocty_exact === 'B')
                return { total: 10, values: { ...values('c', 5, 9), late: 1 } };
            if (field === 'count_exact') throw new Error(`unexpected ${JSON.stringify(filters)}`);
            return small(field, filters);
        };
        const { upstream } = upstreamFor(fake);
        const list = (await fetchVocabulary({ upstream, sleep: async () => {} })).lists.wds.countries;
        expect(list.complete).toBe(true);
        expect(list.requests).toBe(4);
        expect(list.values).toHaveLength(101);
        expect(list.values.find((v) => v.value === 'c0')).toEqual({ value: 'c0', count: 9 });
        expect(list.values.find((v) => v.value === 'late')).toEqual({ value: 'late', count: 1 });
    });

    it('stops a list at its request budget and marks it best-effort', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'regionname_exact' && Object.keys(filters).length === 0)
                return { total: 100, values: { R1: 60, R2: 30 } };
            if (field === 'status_exact') return { total: 60, values: { Active: 60 } };
            if (field === 'sector_exact')
                return { total: filters.regionname_exact === 'R2' ? 30 : 100, values: values('s', 120) };
            return small(field, filters);
        };
        const { upstream } = upstreamFor(fake);
        const vocabulary = await fetchVocabulary({ upstream, sleep: async () => {}, maxRequestsPerList: 10 });
        const sectors = vocabulary.lists.projects.sectors;
        expect(sectors.complete).toBe(false);
        expect(sectors.requests).toBeLessThanOrEqual(10);
        expect(sectors.notes).toContain('request budget (10) reached');
        expect(sectors.values).toHaveLength(100);
        expect(vocabulary.lists.projects.themes.complete).toBe(true);
    });

    it('notes records that no partition covers', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'theme_exact' && !filters.regionname_exact) return { total: 50, values: values('t', 100) };
            if (field === 'regionname_exact') return { total: 50, values: { R1: 40 } };
            if (field === 'theme_exact') return { total: 40, values: values('t', 30) };
            return small(field, filters);
        };
        const { upstream } = upstreamFor(fake);
        const themes = (await fetchVocabulary({ upstream, sleep: async () => {} })).lists.projects.themes;
        expect(themes.complete).toBe(false);
        expect(themes.notes).toEqual(['10 records have no regionname_exact']);
    });

    it('partitions by years last, and says when no field is left', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'lang_exact') return { total: 10, values: values('l', 100) };
            if (field === 'majdocty_exact') return { total: 10, values: { M: 10 } };
            if (field === 'admreg_exact' && filters.majdocty_exact) return { total: 10, values: { R: 10 } };
            return small(field, filters);
        };
        const { upstream, fetch } = upstreamFor(fake);
        const languages = (await fetchVocabulary({ upstream, sleep: async () => {} })).lists.wds.languages;
        expect(languages.complete).toBe(false);
        expect(languages.notes[0]).toMatch(
            /^still 100 values within .*"strdate":"1944-01-01".* with no field left to partition on$/,
        );
        const years = fetch.mock.calls
            .map(([u]) => new URL(String(u)).searchParams)
            .filter((p) => p.get('fct') === 'lang_exact' && p.has('strdate'));
        expect(years).toHaveLength(7);
        expect(years[0].get('enddate')).toBe('1989-12-31');
    });

    it('notes undated records left out of the year partitions', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'sector_exact' && !filters.strdate) return { total: 100, values: values('s', 100) };
            if (field === 'sector_exact') return { total: 10, values: values('s', 3) };
            if (field === 'regionname_exact' && Object.keys(filters).length === 0)
                return { total: 100, values: { R: 100 } };
            if (field === 'status_exact' && filters.regionname_exact) return { total: 100, values: { Closed: 100 } };
            return small(field, filters);
        };
        const { upstream } = upstreamFor(fake);
        const sectors = (await fetchVocabulary({ upstream, sleep: async () => {} })).lists.projects.sectors;
        expect(sectors.complete).toBe(false);
        expect(sectors.notes).toEqual([
            '30 records within {"regionname_exact":"R","status_exact":"Closed"} have no date',
        ]);
    });

    it('keeps one request per list with a budget of 0', async () => {
        const { upstream, fetch } = upstreamFor((field) => ({ total: 10, values: values(field, 100) }));
        const vocabulary = await fetchVocabulary({ upstream, sleep: async () => {}, maxRequestsPerList: 0 });
        expect(fetch).toHaveBeenCalledTimes(9);
        expect(vocabulary.lists.wds.documentTypes).toMatchObject({
            complete: false,
            notes: ['request budget (1) reached'],
        });
    });

    it('marks a list best-effort when a partition fails', async () => {
        const fake: FakeFacet = (field, filters) => {
            if (field === 'docty_exact' && filters.majdocty_exact === 'B') return { status: 404 };
            if (field === 'docty_exact' && !filters.majdocty_exact) return { total: 10, values: values('d', 100) };
            if (field === 'majdocty_exact') return { total: 10, values: { A: 5, B: 5 } };
            return small(field, filters);
        };
        const { upstream } = upstreamFor(fake);
        const types = (await fetchVocabulary({ upstream, sleep: async () => {} })).lists.wds.documentTypes;
        expect(types.complete).toBe(false);
        expect(types.notes).toEqual([
            'partition {"majdocty_exact":"B"} failed: The World Bank search API (search.worldbank.org) has no such record or file (HTTP 404).',
        ]);
    });

    it('fails when a list cannot be fetched at all, so nothing is written', async () => {
        const { upstream } = upstreamFor((field, filters) =>
            field === 'status_exact' ? { status: 403 } : small(field, filters),
        );
        await expect(fetchVocabulary({ upstream, sleep: async () => {} })).rejects.toMatchObject({
            kind: 'http',
            status: 403,
        });
    });

    it('reads the recorded facet responses', async () => {
        const { upstream } = testUpstream((url) => {
            const field = url.searchParams.get('fct');
            if (field === 'admreg_exact') return { body: fixture('wds-facet-admreg.json') };
            if (field === 'status_exact') return { body: fixture('projects-facet-status.json') };
            if (field === 'regionname_exact') return { body: fixture('projects-facet-regionname.json') };
            return url.pathname.endsWith('/wds')
                ? json({ total: 0, documents: { facets: {} } })
                : json({ total: '0', projects: {}, facets: {} });
        });
        const vocabulary = await fetchVocabulary({ upstream, sleep: async () => {} });
        expect(vocabulary.lists.wds.regions.values[0]).toEqual({ value: 'Eastern and Southern Africa', count: 92842 });
        expect(vocabulary.lists.projects.statuses.values.map((v) => v.value)).toEqual([
            'Closed',
            'Active',
            'Dropped',
            'Pipeline',
        ]);
        expect(vocabulary.lists.projects.regions.values).toHaveLength(9);
        expect(vocabulary.lists.wds.countries).toMatchObject({ complete: true, values: [] });
    });
});
