import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { forgetReformulations } from '../../../src/haiku/reformulate';
import {
    MAX_MERGED_DEPTH,
    MAX_OUTPUT_CHARS,
    STAGES,
    addWithinBudget,
    runSearchDocuments,
    searchDocuments,
    stageOf,
    type SearchDocumentsInput,
} from '../../../src/tools/search-documents';
import { sharedCache } from '../../../src/upstream/transport';
import { bedrock, haikuCalls, silenceWarnings } from '../haiku/fake-bedrock';
import { blockNetwork, fakeFetch, json } from '../upstream/fake-fetch';
import {
    listed,
    progressContext,
    recorded,
    routed,
    scriptHaiku,
    testVocabulary,
    text,
    type Params,
} from './search-helpers';

let vocabulary = testVocabulary();
let warn: ReturnType<typeof silenceWarnings>;
const deps = (upstream: ReturnType<typeof routed>['upstream']) => ({
    upstream,
    vocabulary: async () => vocabulary,
    now: () => new Date('2026-11-24T12:00:00Z'),
});

beforeAll(blockNetwork);
beforeEach(() => {
    bedrock.reset();
    forgetReformulations();
    vocabulary = testVocabulary();
    warn = silenceWarnings();
});
afterEach(() => warn.mockRestore());

const run = async (input: SearchDocumentsInput, routes: Parameters<typeof routed>[0], ctx?: never) => {
    const { upstream, recorder } = routed(routes);
    const result = await runSearchDocuments(input, deps(upstream), ctx);
    expect(recorder.unmatched).toEqual([]);
    return { result, output: text(result), requests: recorder.requests };
};

const without = (params: Params, ...names: string[]) =>
    Object.fromEntries(Object.entries(params).filter(([name]) => !['format', 'fl', ...names].includes(name)));

describe('search_documents: the Q1 query shapes (expected-queries doc)', () => {
    it('"Find World Bank reports on digital learning in Uganda since 2020": variants in parallel, merged', async () => {
        scriptHaiku({ variants: ['"digital learning"', '"education technology" EdTech'] });
        const { ctx, notify } = progressContext();
        const { upstream, recorder } = routed([
            [(p) => p.qterm === '"digital learning"', 'wds-uganda-digital-learning'],
            [(p) => p.qterm === '"education technology" EdTech', 'wds-uganda-edtech'],
        ]);
        const result = await runSearchDocuments(
            { query: 'digital learning in Uganda since 2020', countries: ['Uganda'], date_from: '2020' },
            deps(upstream),
            ctx,
        );
        const output = text(result);
        expect(result.isError).toBeUndefined();
        expect(recorder.requests.map((p) => without(p, 'qterm'))).toEqual([
            { count_exact: 'Uganda', strdate: '2020-01-01', enddate: '2099-12-31', rows: '10', os: '0' },
            { count_exact: 'Uganda', strdate: '2020-01-01', enddate: '2099-12-31', rows: '10', os: '0' },
        ]);
        expect(listed(output)).toEqual([
            expect.stringContaining('Enhancing Uganda’s E-Learning System'),
            expect.stringContaining('The EdTech Readiness Index'),
        ]);
        expect(output).toContain('Matching document records: up to 1 per keyword variant (1, 1)');
        expect(output).toContain(
            '- keywords "digital learning": 1 matching records · count_exact=Uganda&strdate=2020-01-01&qterm="digital learning"&rows=10&os=0&enddate=2099-12-31',
        );
        expect(output).toContain('The query was run as 2 keyword variants; results are merged and duplicates removed.');
        expect(output).toContain("Interpreted as:\n- 'Uganda' matched the country Uganda.");
        expect(output).toContain('Filters: country: Uganda; document date 2020-01-01 to 2099-12-31');
        expect(output).toContain('Sort: relevance (not date order) · limit 10 · offset 0');
        expect(output).toContain('Document ID: 40100461');
        expect(output).toContain('Record: https://documents.worldbank.org/curated/en/');
        expect(output).toMatch(/Next steps:\n- To answer from a document, call read_document with its document_id/);
        expect(output).toContain('call retrieve_skill first');
        expect(notify).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: { progressToken: 'p1', progress: 0, message: 'searching 2 keyword variants' },
        });
    });

    it('"Show me the five most recent procurement plans for the Philippines": newest first by srt=docdt', async () => {
        const { output, requests } = await run(
            { countries: ['Philippines'], document_types: ['procurement plans'], sort: 'newest', limit: 5 },
            [[(p) => p.docty_exact === 'Procurement Plan', 'wds-philippines-procurement-plans']],
        );
        expect(without(requests[0])).toEqual({
            count_exact: 'Philippines',
            docty_exact: 'Procurement Plan',
            srt: 'docdt',
            order: 'desc',
            rows: '5',
            os: '0',
        });
        expect(haikuCalls()).toHaveLength(0);
        expect(listed(output)).toHaveLength(5);
        expect(output).toContain('Matching document records: 813. Showing 1–5, newest first, by document date.');
        expect(output).toContain(
            "'procurement plans' is not an exact World Bank document type; searched the closest spelling, the document type Procurement Plan.",
        );
        const dates = [...output.matchAll(/Document date: (\S+)/g)].map((m) => m[1]);
        expect(dates).toEqual([...dates].sort().reverse());
        expect(output).toContain('For the next 5 records, call again with the same inputs and offset 5.');
    });

    it('"\'learning poverty\' was in the title": the quoted phrase, and the keyword fallback when Haiku is throttled', async () => {
        scriptHaiku({});
        const { output, requests } = await run({ query: '"learning poverty"' }, [
            [(p) => p.qterm === '"learning poverty"', 'wds-learning-poverty'],
        ]);
        expect(requests).toHaveLength(1);
        expect(output).toContain(
            'Automatic keyword variants were unavailable; the query was run as typed and as its keywords.',
        );
        expect(listed(output)).toEqual([
            'Niger - Learning Poverty Brief - 2021',
            'China - Learning Poverty Brief - 2021',
            'Cameroon - Learning Poverty Brief - 2019',
            'Poland - Learning Poverty Brief - 2019',
        ]);
        expect(output).toContain('Country: World · Language: English');
        expect(output).toContain('Matching document records: 761.');
    });

    it('"French-language reports on teacher training for Morocco or Tunisia": language filter, either country', async () => {
        scriptHaiku({ variants: ['"teacher training"', '"formation des enseignants"'] });
        const { output, requests } = await run(
            { query: 'teacher training', countries: ['Morocco', 'Tunisia'], language: 'french' },
            [
                [(p) => p.qterm === '"teacher training"', 'wds-french-teacher-training'],
                [(p) => p.qterm === '"formation des enseignants"', 'wds-french-formation-enseignants'],
            ],
        );
        for (const params of requests) {
            expect(params).toMatchObject({ count_exact: 'Morocco^Tunisia', lang_exact: 'French' });
        }
        expect(output).toContain("'french' matched the language French.");
        expect(output).toContain('Filters: country: Morocco or Tunisia; language: French');
        // Round-robin by rank: each variant's first record, then each one's second.
        expect([...output.matchAll(/Document ID: (\d+)/g)].map((m) => m[1]).slice(0, 4)).toEqual([
            '10193015',
            '40076559',
            '32149055',
            '40095361',
        ]);
        expect(listed(output)).toHaveLength(7);
    });

    it('"I have the project ID. Show me its appraisal document, procurement plans and completion report in chronological order"', async () => {
        scriptHaiku({
            choose: {
                PAD: ['Project Appraisal Document'],
                'completion report': ['Implementation Completion and Results Report'],
            },
        });
        const { output, requests } = await run(
            { project_id: 'p117635', document_types: ['PAD', 'Procurement Plan', 'completion report'], sort: 'oldest' },
            [[(p) => p.proid === 'P117635' && Boolean(p.docty_exact), 'wds-P117635-types-oldest']],
        );
        expect(without(requests[0])).toEqual({
            proid: 'P117635',
            docty_exact: 'Project Appraisal Document^Procurement Plan^Implementation Completion and Results Report',
            srt: 'docdt',
            order: 'asc',
            rows: '10',
            os: '0',
            strdate: '1944-01-01',
            enddate: '2099-12-31',
        });
        expect(output).toContain(
            "'PAD' is not a World Bank document type; searched the document type Project Appraisal Document.",
        );
        expect(output).toContain('Showing 1–10, oldest first, by document date (undated records last).');
        const dates = [...output.matchAll(/Document date: (\S+)/g)].map((m) => m[1]);
        expect(dates[0]).toBe('2013-05-22');
        expect(dates).toEqual([...dates].sort());
        expect(output).toContain('call again with the same inputs and offset 10');
    });

    it('"Find this report number and give me its abstract and PDF"; and the same record by document ID', async () => {
        const byReport = await run({ report_number: 'ICR00185' }, [
            [(p) => p.repnb === 'ICR00185', 'wds-repnb-ICR00185'],
        ]);
        expect(without(byReport.requests[0])).toEqual({
            repnb: 'ICR00185',
            srt: 'docdt',
            order: 'desc',
            rows: '10',
            os: '0',
        });
        expect(byReport.output).toContain('Report number: ICR00185 · Project: P117635');
        expect(byReport.output).toContain(
            'Abstract: Ratings of the Kenya Water Security and Climate Resilience Project',
        );
        expect(byReport.output).toMatch(/PDF: https:\/\/documents\.worldbank\.org\/curated\/en\/\S+\.pdf/);
        expect(byReport.output).not.toContain('For the next');

        const byId = await run({ document_id: '40079232' }, [[(p) => p.id === '40079232', 'wds-repnb-ICR00185']]);
        expect(byId.output).toContain('Document ID: 40079232');
    });

    it('"Find working papers by this author on education finance": author, series and keywords; duplicates removed', async () => {
        scriptHaiku({ variants: ['"education finance"', '"education financing"'] });
        const { output, requests } = await run(
            { query: 'education finance', author: 'Patrinos', collection: 'Policy Research working paper' },
            [[(p) => p.authr === 'Patrinos', 'wds-author-education-finance']],
        );
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ authr: 'Patrinos', colti: 'Policy Research working paper' });
        // Both variants returned the same records: each is listed once.
        expect(listed(output)).toHaveLength(4);
        expect(output).toContain('Series: Policy Research working paper ; no. WPS 5185');
        expect(output).toContain('Filters: author: Patrinos; series: Policy Research working paper');
    });

    it('"Which countries appear most often in the results for school connectivity?": country facet, labelled', async () => {
        scriptHaiku({ variants: ['school connectivity', '"connecting schools" internet'] });
        const { output, requests } = await run({ query: 'school connectivity', facet: 'country' }, [
            [(p) => p.qterm === 'school connectivity', 'wds-school-connectivity-facet'],
            [(p) => p.qterm === '"connecting schools" internet', 'wds-connecting-schools'],
        ]);
        expect(requests[0].fct).toBe('count_exact');
        expect(requests[1].fct).toBeUndefined();
        expect(output).toContain(
            'Facet "country": counts of matching document records for the first keyword variant (school connectivity); a record listing several countries counts toward each.',
        );
        expect(output).toContain('- World: 430\n- India: 233\n- Viet Nam: 152');
    });

    it('"Of those results, show only English-language reports from 2022 onward. Give me the next ten."', async () => {
        scriptHaiku({ variants: ['school connectivity', '"connecting schools" internet'] });
        const { output, requests } = await run(
            { query: 'school connectivity', language: 'English', date_from: '2022', offset: 10 },
            [
                [(p) => p.qterm === 'school connectivity', 'wds-school-connectivity-english-2022'],
                [(p) => p.qterm === '"connecting schools" internet', 'wds-connecting-schools-english-2022'],
            ],
        );
        // Merged pages come from each variant's top offset + limit records.
        for (const params of requests) {
            expect(params).toMatchObject({ lang_exact: 'English', strdate: '2022-01-01', rows: '20', os: '0' });
        }
        expect(listed(output)).toHaveLength(10);
        expect(output).toContain('Showing 11–20');
        expect(output).toContain('call again with the same inputs and offset 20');
        expect(output).toMatch(/^1[1-9]\. |^20\. /m);
    });
});

describe('search_documents: group_by_stage', () => {
    it("groups a project's documents by stage with the latest of each first", async () => {
        const { output, requests } = await run({ project_id: 'P117635', group_by_stage: true, limit: 3 }, [
            [(p) => p.proid === 'P117635' && p.os === '0', 'wds-P117635-all'],
            [(p) => p.proid === 'P117635' && p.os === '100', 'wds-P117635-all-page2'],
        ]);
        expect(requests.map((p) => [p.rows, p.os, p.srt, p.order])).toEqual([
            ['100', '0', 'docdt', 'desc'],
            ['29', '100', 'docdt', 'desc'],
        ]);
        expect(requests[0].fl).not.toContain('abstracts');
        expect(output).toContain('public documents of project P117635, grouped by stage');
        expect(output).toContain('Matching document records: 129.');
        expect(output).toMatch(/## Design: 7 documents \(/);
        expect(output).toMatch(/## Legal: 11 documents \(/);
        expect(output).toMatch(/## Environmental and social: 16 documents \(/);
        expect(output).toMatch(/## Implementation: 83 documents \(/);
        expect(output).toMatch(/## Restructuring and additional financing: 8 documents \(Project Paper\)/);
        expect(output).toMatch(/## Completion: 2 documents \(/);
        expect(output).toContain('… 80 older in this group');
        const completion = output.split('## Completion')[1].split('##')[0];
        expect(completion).toContain('Implementation Completion Report Review');
        expect(completion).toContain('Report number: ICR00185');
        expect(output).toContain('call search_documents with project_id P117635, its document_types and sort "newest"');
    });

    it('uses a query as typed, without keyword variants or facets', async () => {
        const { output, requests } = await run(
            { project_id: 'P117635', group_by_stage: true, query: 'canal', facet: 'country' },
            [[(p) => p.qterm === 'canal', () => json({ total: 0, documents: {} })]],
        );
        expect(haikuCalls()).toHaveLength(0);
        expect(requests).toHaveLength(1);
        expect(requests[0].fct).toBeUndefined();
        expect(output).toContain('- keywords canal: 0 matching records');
        expect(output).toContain('No public documents matched.');
    });

    it('needs a project ID', async () => {
        const { result } = await run({ group_by_stage: true }, []);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe('search_documents: group_by_stage needs a project_id.');
    });

    it('classifies document types by a fixed table, and anything else as Other', () => {
        expect(stageOf('Project Paper')).toBe('Restructuring and additional financing');
        expect(stageOf('Environmental and Social Commitment Plan')).toBe('Environmental and social');
        expect(stageOf('Minutes')).toBe('Other');
        expect(stageOf(null)).toBe('Other');
        const all = STAGES.flatMap((s) => s.types);
        expect(new Set(all).size).toBe(all.length);
    });
});

describe('search_documents: year facet', () => {
    const byYear = (p: Params) => json({ total: Number(p.enddate.slice(2, 4)), documents: {} });

    it('counts records per year within the dates given', async () => {
        const { output, requests } = await run(
            { countries: ['Kenya'], facet: 'year', date_from: '2020', date_to: '2022' },
            [
                [(p) => p.rows === '0', byYear],
                [(p) => p.rows === '10', 'wds-repnb-ICR00185'],
            ],
        );
        const counts = requests.filter((p) => p.rows === '0');
        expect(counts.map((p) => [p.strdate, p.enddate])).toEqual([
            ['2022-01-01', '2022-12-31'],
            ['2021-01-01', '2021-12-31'],
            ['2020-01-01', '2020-12-31'],
        ]);
        expect(counts.every((p) => p.count_exact === 'Kenya' && !p.fct && !p.srt)).toBe(true);
        expect(output).toContain(
            'Facet "year": counts of matching document records, by document date.\n- 2022: 22\n- 2021: 21\n- 2020: 20',
        );
    });

    it('without dates, covers the last 10 years and everything before', async () => {
        const { output, requests } = await run({ report_number: 'X1', facet: 'year' }, [
            [(p) => p.rows === '0', byYear],
            [(p) => p.rows === '10', 'wds-repnb-ICR00185'],
        ]);
        expect(requests.filter((p) => p.rows === '0')).toHaveLength(11);
        expect(output).toContain('- 2026: 26');
        expect(output).toContain('- 2017: 17');
        expect(output).toContain('- before 2017: 16');
    });
});

describe('search_documents: inputs and errors', () => {
    it('refuses inconsistent or invalid dates before sending anything', async () => {
        const after = await run({ date_from: '2023', date_to: '2022-06' }, []);
        expect(text(after.result)).toBe('search_documents: date_from (2023-01-01) is after date_to (2022-06-30).');
        expect(after.requests).toHaveLength(0);
        const invalid = await run({ date_from: '2023-02-30' }, []);
        expect(text(invalid.result)).toBe("search_documents: date_from '2023-02-30' is not a valid date.");
    });

    it('checks inputs with its schema: no arbitrary parameters, IDs in their formats', () => {
        const schema = searchDocuments.inputSchema;
        expect(schema.safeParse({ document_id: '4007; DROP' }).success).toBe(false);
        expect(schema.safeParse({ project_id: 'https://example.com' }).success).toBe(false);
        expect(schema.safeParse({ limit: 51 }).success).toBe(false);
        expect(schema.safeParse({ date_from: 'last year' }).success).toBe(false);
        expect(schema.safeParse({ sort: 'closing' }).success).toBe(false);
        expect(Object.keys(schema.parse({ query: 'x', url: 'https://example.com', fct: 'x' }))).toEqual(['query']);
    });

    it('sends injected parameter text only as the value of qterm', async () => {
        scriptHaiku({});
        const { requests } = await run({ query: 'roads&fct=count_exact&rows=1000' }, [
            [() => true, 'wds-learning-poverty'],
        ]);
        for (const params of requests) {
            expect(Object.keys(params).sort()).toEqual(['fl', 'format', 'os', 'qterm', 'rows']);
            expect(params.rows).toBe('10');
        }
    });

    it('puts a term that matches no value into the keywords, with the closest values', async () => {
        scriptHaiku({});
        const { output, requests } = await run({ document_types: ['xyzzy plan'] }, [
            [() => true, 'wds-learning-poverty'],
        ]);
        expect(requests[0].qterm).toBe('"xyzzy plan"');
        expect(requests[0].docty_exact).toBeUndefined();
        expect(output).toContain("'xyzzy plan' matched no World Bank document type; searched it as free text instead.");
    });

    it('uses filter values as given when the vocabulary cannot be loaded, and says so', async () => {
        const { upstream, recorder } = routed([[() => true, 'wds-philippines-procurement-plans']]);
        const result = await runSearchDocuments(
            { countries: ['Philippines'] },
            {
                upstream,
                vocabulary: async () => {
                    throw new Error('no vocabulary');
                },
            },
        );
        expect(recorder.requests[0].count_exact).toBe('Philippines');
        expect(text(result)).toContain(
            "'Philippines' was used as given: the World Bank's list of valid values could not be loaded.",
        );
    });

    it('turns an upstream failure into a plain error', async () => {
        const { result } = await run({ report_number: 'X' }, [[() => true, () => ({ status: 403 })]]);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
            'search_documents could not finish: The World Bank search API (search.worldbank.org) refused the request (HTTP 403). Its access rules may have changed.',
        );
    });

    it('reports an unexpected error without its details', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await runSearchDocuments(
            { report_number: 'X' },
            { upstream: { search: { getJson: () => Promise.reject(new TypeError('boom')) } } as never },
        );
        expect(text(result)).toBe(
            'search_documents failed unexpectedly. Try again; if it fails again, simplify the request.',
        );
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"error":"TypeError"'));
        error.mockRestore();
    });

    it('pages merged variants only to a fixed depth', async () => {
        scriptHaiku({ variants: ['a', 'b'] });
        const { result, requests } = await run({ query: 'a b', offset: MAX_MERGED_DEPTH, limit: 10 }, []);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(`can be paged to record ${MAX_MERGED_DEPTH}`);
        expect(requests).toHaveLength(0);
    });

    it('says when there are no records', async () => {
        const { output } = await run({ report_number: 'none' }, [
            [() => true, () => json({ total: 0, documents: {} })],
        ]);
        expect(output).toContain('Matching document records: 0. No records at offset 0.');
        expect(output).toContain('No records matched.');
    });
});

describe('search_documents: output budget', () => {
    it('stays under the budget and says how to get the rest', async () => {
        const long = 'word '.repeat(400);
        const documents = Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
                `D${i}`,
                {
                    id: String(i),
                    display_title: `Title ${i} ${'x'.repeat(300)}`,
                    abstracts: { 'cdata!': long },
                    docdt: '2024-01-01T00:00:00Z',
                },
            ]),
        );
        const { output } = await run({ report_number: 'many', limit: 50 }, [
            [() => true, () => json({ total: 500, documents })],
        ]);
        expect(output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
        const shown = listed(output).length;
        expect(shown).toBeLessThan(50);
        expect(output).toContain(
            `Output truncated after ${shown} of 50 records to stay within the size limit. For the rest, call again with offset ${shown}.`,
        );
        expect(output).toContain('(shortened; read_document has the full text)');
    });

    it('always adds at least one item', () => {
        const sections = ['header'];
        expect(addWithinBudget(sections, ['a'.repeat(100), 'b'], 0, 50)).toBe(1);
        expect(sections).toHaveLength(2);
    });
});

describe('search_documents tool', () => {
    it('is read-only and has a short description', () => {
        expect(searchDocuments.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: true,
        });
        expect(searchDocuments.description.length).toBeLessThanOrEqual(1024);
        expect(searchDocuments.description).toContain('retrieve_skill');
    });

    it('runs through its handler with the default transport', async () => {
        sharedCache.clear();
        const fetch = fakeFetch(() => ({
            body: recorded('wds-repnb-ICR00185'),
            headers: { 'content-type': 'application/json' },
        }));
        globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
        try {
            const result = await searchDocuments.handler({ report_number: 'ICR00185' }, {} as never);
            expect(text(result)).toContain('Report number: ICR00185');
            expect(new URL(String(fetch.mock.calls[0][0])).hostname).toBe('search.worldbank.org');
        } finally {
            blockNetwork();
            sharedCache.clear();
        }
    });
});
