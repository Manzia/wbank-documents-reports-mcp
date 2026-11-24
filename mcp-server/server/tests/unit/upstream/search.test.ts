import { beforeAll, describe, expect, it } from '@jest/globals';
import { PAGE_SIZE, searchProjects, searchWds } from '../../../src/upstream/search';
import { blockNetwork, fixture, json, testUpstream } from './fake-fetch';

const page = (offset: number, rows: number, total: number) =>
    json({
        total,
        documents: Object.fromEntries(
            Array.from({ length: Math.max(0, Math.min(rows, total - offset)) }, (_, i) => [
                `D${offset + i}`,
                { id: String(offset + i), display_title: `Doc ${offset + i}` },
            ]),
        ),
    });

beforeAll(blockNetwork);

describe('searchWds', () => {
    it('returns normalised records with the query as sent', async () => {
        const { upstream, fetch } = testUpstream(() => ({ body: fixture('wds-proid-P117635.json') }));
        const result = await searchWds(upstream, { proid: 'P117635', srt: 'docdt', order: 'desc', rows: 2 });
        expect(result.total).toBe(129);
        expect(result.records.map((r) => r.reportNumber)).toEqual(['ICRR0024889', expect.any(String)]);
        expect(result.query).toEqual({
            api: 'wds',
            params: { format: 'json', proid: 'P117635', srt: 'docdt', order: 'desc', rows: '2', os: '0' },
            urls: [
                'https://search.worldbank.org/api/v3/wds?format=json&proid=P117635&srt=docdt&order=desc&rows=2&os=0',
            ],
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('sends the APIs default of 10 rows when none is given', async () => {
        const { upstream } = testUpstream(() => ({ body: fixture('wds-id-40139216.json') }));
        const result = await searchWds(upstream, { id: '40139216' });
        expect(result.query.params).toMatchObject({ rows: '10', os: '0' });
        expect(result.records[0].documentType).toBe('Procurement Plan');
    });

    it('fetches more than one page of rows in parts', async () => {
        const { upstream, fetch } = testUpstream((url) =>
            page(Number(url.searchParams.get('os')), Number(url.searchParams.get('rows')), 129),
        );
        const result = await searchWds(upstream, { proid: 'P117635', rows: 200, os: 0 });
        expect(result.records).toHaveLength(129);
        expect(result.records[128].documentId).toBe('128');
        expect(result.query.params.rows).toBe('200');
        expect(result.query.urls).toHaveLength(2);
        expect(fetch.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('rows'))).toEqual([
            String(PAGE_SIZE),
            '29',
        ]);
    });

    it('returns facets', async () => {
        const { upstream } = testUpstream(() => ({ body: fixture('wds-facet-admreg.json') }));
        const result = await searchWds(upstream, { rows: 0, fct: 'admreg_exact' });
        expect(result.facets.admreg_exact).toHaveLength(10);
    });

    it('refuses a bad parameter before sending anything', async () => {
        const { upstream, fetch } = testUpstream(() => json({}));
        await expect(searchWds(upstream, { rows: 5000 })).rejects.toMatchObject({ kind: 'refused-parameter' });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('searchProjects', () => {
    it('returns normalised project records', async () => {
        const { upstream } = testUpstream(() => ({ body: fixture('projects-id-P117635.json') }));
        const result = await searchProjects(upstream, { id: 'P117635', fl: '*' });
        expect(result.records[0]).toMatchObject({ projectId: 'P117635', closingDate: '2025-05-31' });
        expect(result.query.urls[0]).toBe(
            'https://search.worldbank.org/api/v2/projects?format=json&id=P117635&fl=*&rows=10&os=0',
        );
    });

    it('passes upstream errors on', async () => {
        const { upstream } = testUpstream(() => ({ status: 403 }));
        await expect(searchProjects(upstream, { qterm: 'roads' })).rejects.toMatchObject({ kind: 'http', status: 403 });
    });
});
