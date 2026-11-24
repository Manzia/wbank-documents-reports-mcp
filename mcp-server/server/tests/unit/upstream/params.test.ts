import { beforeAll, describe, expect, it } from '@jest/globals';
import * as z from 'zod';
import { UpstreamError } from '../../../src/upstream/errors';
import {
    ALLOWED_PARAMETERS,
    DATE_CEILING,
    DATE_FLOOR,
    MAX_VALUE_LENGTH,
    buildQuery,
    type QueryParams,
} from '../../../src/upstream/params';
import { searchWds } from '../../../src/upstream/search';
import { blockNetwork, json, testUpstream } from './fake-fetch';

const refused = (api: 'wds' | 'projects', params: QueryParams): UpstreamError => {
    try {
        buildQuery(api, params);
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).kind).toBe('refused-parameter');
        return error as UpstreamError;
    }
    throw new Error('expected the parameters to be refused');
};

beforeAll(blockNetwork);

describe('allow-lists', () => {
    it('hold the documented parameters confirmed in MCP-102', () => {
        expect([...ALLOWED_PARAMETERS.wds].sort()).toEqual(
            [
                'format',
                'fl',
                'rows',
                'os',
                'srt',
                'order',
                'fct',
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
            ].sort(),
        );
        expect([...ALLOWED_PARAMETERS.projects].sort()).toEqual(
            [
                'format',
                'fl',
                'rows',
                'os',
                'srt',
                'order',
                'fct',
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
            ].sort(),
        );
    });

    it.each([
        ['wds', 'callback'],
        ['wds', 'sort'],
        ['wds', 'url'],
        ['wds', 'status_exact'],
        ['projects', 'proid'],
        ['projects', 'docty_exact'],
    ] as const)('refuse %s parameter %s', (api, name) => {
        expect(refused(api, { qterm: 'roads', [name]: 'x' }).message).toBe(
            `Refused to query the ${api === 'wds' ? 'Documents & Reports (WDS)' : 'Projects'} API: '${name}' is not a parameter this server sends.`,
        );
    });

    it('refuse a parameter injected through a tool input before anything is sent', async () => {
        // A tool that passes its input's keys through, as a careless one might, with a client-supplied extra key.
        const toolInput = z
            .looseObject({ query: z.string() })
            .parse(JSON.parse('{"query":"road fund","fl":"*","host":"example.com"}'));
        const { query, ...rest } = toolInput;
        const { upstream, fetch } = testUpstream(() => json({ total: 0, documents: {} }));
        await expect(searchWds(upstream, { qterm: query, ...(rest as QueryParams) })).rejects.toMatchObject({
            kind: 'refused-parameter',
            message: "Refused to query the Documents & Reports (WDS) API: 'host' is not a parameter this server sends.",
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuse a __proto__ key from parsed JSON', () => {
        refused('wds', JSON.parse('{"__proto__": {"x": 1}}') as QueryParams);
    });

    it('send a value that looks like more parameters as one encoded value', () => {
        const { url, params } = buildQuery('wds', { qterm: 'roads&fl=*&callback=x#frag' });
        expect(params.qterm).toBe('roads&fl=*&callback=x#frag');
        expect([...url.searchParams.keys()]).toEqual(['format', 'qterm']);
        expect(url.hash).toBe('');
    });
});

describe('values', () => {
    it('always send format=json first, and refuse any other format', () => {
        expect(buildQuery('wds', { qterm: 'x' }).url.href).toBe(
            'https://search.worldbank.org/api/v3/wds?format=json&qterm=x',
        );
        expect(buildQuery('wds', { format: 'json' }).params).toEqual({ format: 'json' });
        refused('wds', { format: 'xml' });
    });

    it('join a list with ^, which the APIs read as OR', () => {
        expect(buildQuery('wds', { count_exact: ['Kenya', 'Uganda'] }).url.search).toBe(
            '?format=json&count_exact=Kenya%5EUganda',
        );
        refused('wds', { count_exact: ['Kenya^Uganda'] });
    });

    it('leave out empty values', () => {
        expect(buildQuery('projects', { qterm: '', status_exact: [], sector_exact: undefined }).params).toEqual({
            format: 'json',
        });
    });

    it('check rows, os, order, srt, fct and fl', () => {
        expect(buildQuery('wds', { rows: 50, os: '20', order: 'desc', srt: 'docdt' }).params).toMatchObject({
            rows: '50',
            os: '20',
            order: 'desc',
            srt: 'docdt',
        });
        for (const params of [
            { rows: -1 },
            { rows: 1001 },
            { rows: 1.5 },
            { os: 'abc' },
            { os: 100_001 },
            { order: 'up' },
            { srt: 'sort' },
            { srt: ['docdt'] },
            { fct: 'count_exact,url' },
            { fl: 'id,display_title;drop' },
        ]) {
            refused('wds', params);
        }
        // Projects closing dates don't sort upstream (MCP-102 F5).
        refused('projects', { srt: 'closingdate' });
        expect(
            buildQuery('projects', { srt: 'boardapprovaldate', fct: 'status_exact, regionname_exact' }).params.fct,
        ).toBe('status_exact,regionname_exact');
        expect(buildQuery('wds', { fl: '*' }).params.fl).toBe('*');
    });

    it('refuse control characters and over-long values', () => {
        refused('wds', { qterm: 'roads\nfl=*' });
        refused('wds', { qterm: 'x'.repeat(MAX_VALUE_LENGTH + 1) });
        expect(buildQuery('wds', { qterm: 'x'.repeat(MAX_VALUE_LENGTH) }).params.qterm).toHaveLength(MAX_VALUE_LENGTH);
    });

    it('check dates and years', () => {
        for (const value of ['2024-13-01', '2024-02-30', '2024/01/01', 'bad']) refused('wds', { strdate: value });
        refused('projects', { frmYear: '24' });
        expect(buildQuery('projects', { frmYear: 2024, toYear: '2025' }).params).toMatchObject({
            frmYear: '2024',
            toYear: '2025',
        });
    });
});

describe('date ranges (MCP-102 F5)', () => {
    it('always send both ends', () => {
        expect(buildQuery('wds', { strdate: '2023-01-01' }).params).toMatchObject({
            strdate: '2023-01-01',
            enddate: DATE_CEILING,
        });
        expect(buildQuery('projects', { enddate: '2020-12-31' }).params).toMatchObject({
            strdate: DATE_FLOOR,
            enddate: '2020-12-31',
        });
        refused('wds', { strdate: '2024-01-01', enddate: '2023-01-01' });
    });

    it('keep undated and placeholder records out of oldest-first', () => {
        expect(buildQuery('wds', { srt: 'docdt', order: 'asc' }).params).toMatchObject({
            strdate: DATE_FLOOR,
            enddate: DATE_CEILING,
        });
        expect(buildQuery('wds', { srt: 'docdt', order: 'desc' }).params).not.toHaveProperty('strdate');
    });
});
