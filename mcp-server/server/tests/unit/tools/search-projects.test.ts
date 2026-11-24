import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { forgetReformulations } from '../../../src/haiku/reformulate';
import {
    MAX_CLOSING_SCAN,
    runSearchProjects,
    searchProjects,
    type SearchProjectsInput,
} from '../../../src/tools/search-projects';
import { sharedCache } from '../../../src/upstream/transport';
import { bedrock, silenceWarnings } from '../haiku/fake-bedrock';
import { blockNetwork, fakeFetch, json } from '../upstream/fake-fetch';
import { listed, progressContext, recorded, routed, scriptHaiku, testVocabulary, text } from './search-helpers';

let vocabulary = testVocabulary();
let warn: ReturnType<typeof silenceWarnings>;

beforeAll(blockNetwork);
beforeEach(() => {
    bedrock.reset();
    forgetReformulations();
    vocabulary = testVocabulary();
    warn = silenceWarnings();
});
afterEach(() => warn.mockRestore());

const run = async (input: SearchProjectsInput, routes: Parameters<typeof routed>[0]) => {
    const { upstream, recorder } = routed(routes);
    const result = await runSearchProjects(input, { upstream, vocabulary: async () => vocabulary });
    expect(recorder.unmatched).toEqual([]);
    return { result, output: text(result), requests: recorder.requests };
};

const ids = (output: string): string[] => listed(output).map((line) => /\((P\d+)\)$/.exec(line)?.[1] ?? line);

describe('search_projects: the Q3 and Q4 query shapes', () => {
    it('"Which active agriculture projects in Bangladesh are approaching their closing dates? Who implements them?"', async () => {
        scriptHaiku({ variants: ['agriculture', '"agricultural development"'] });
        const { ctx, notify } = progressContext();
        const { upstream, recorder } = routed([
            [(p) => p.countryshortname_exact === 'Bangladesh', 'projects-bangladesh-agriculture-active'],
        ]);
        const result = await runSearchProjects(
            {
                query: 'agriculture',
                countries: ['Bangladesh'],
                status: 'active',
                sort: 'closing_soonest',
                closing_from: '2025-11-24',
            },
            { upstream, vocabulary: async () => vocabulary },
            ctx,
        );
        const output = text(result);
        for (const params of recorder.requests) {
            expect(params).toMatchObject({
                countryshortname_exact: 'Bangladesh',
                status_exact: 'Active',
                // The first page of MAX_CLOSING_SCAN; the recorded answer holds every match.
                rows: '100',
                os: '0',
            });
        }
        // Closing dates on or after 2025-11-24, soonest first; the same projects from both variants once.
        expect(ids(output)).toEqual(['P175820', 'P161534', 'P181563', 'P176374', 'P172499', 'P178985']);
        expect(output).toContain('Approved: 2021-05-20 · Closing: 2026-05-28');
        expect(output).toContain('Implementing agency: Social Development Foundation');
        expect(output).toContain(
            'Commitment: US$300 million · total project cost US$341 million (a cost, not a commitment)',
        );
        expect(output).toContain('Commitment: US$0 · total project cost US$14.5 million');
        expect(output).toContain('closing date 2025-11-24 to any (filtered by this server)');
        expect(output).toContain("'active' matched the status Active.");
        expect(output).toContain('Matching projects: up to 12 per keyword variant (12, 12)');
        expect(output).toContain('call get_project with its project ID');
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('"Find active rural water projects in South Asia": region and status filters, variants merged', async () => {
        scriptHaiku({ variants: ['"rural water"', '"rural water supply" sanitation'] });
        const { output, requests } = await run({ query: 'rural water', region: 'south asia', status: 'Active' }, [
            [(p) => p.regionname_exact === 'South Asia', 'projects-south-asia-rural-water'],
        ]);
        expect(requests).toHaveLength(2);
        for (const params of requests) {
            expect(params).toMatchObject({
                regionname_exact: 'South Asia',
                status_exact: 'Active',
                rows: '10',
                os: '0',
            });
            expect(params.srt).toBeUndefined();
        }
        expect(ids(output)).toEqual(['P179039', 'P169342', 'P158146', 'P170843', 'P169071']);
        expect(output).toContain('Showing 1–5, relevance (not date order).');
        expect(output).toContain('Country: India · Region: South Asia · Status: Active');
        expect(output).toContain(
            'Record: https://projects.worldbank.org/en/projects-operations/project-detail/P179039',
        );
    });

    it('"Find comparable rural roads projects in the Andean countries": any of several countries', async () => {
        scriptHaiku({});
        const { output, requests } = await run(
            { query: '"rural roads"', countries: ['Peru', 'Bolivia', 'Ecuador', 'Colombia'] },
            [[(p) => p.qterm === '"rural roads"', 'projects-andean-rural-roads']],
        );
        expect(requests).toHaveLength(1);
        expect(requests[0].countryshortname_exact).toBe('Peru^Bolivia^Ecuador^Colombia');
        expect(output).toContain('Filters: country: Peru or Bolivia or Ecuador or Colombia');
        expect(ids(output)).toHaveLength(5);
        expect(output).toContain('For the next 10 projects, call again with the same inputs and offset 5.');
    });

    it('"Across recently closed urban transport projects in Latin America": closing-date window, latest first', async () => {
        scriptHaiku({});
        const { output } = await run(
            {
                query: '"urban transport"',
                region: 'Latin America and Caribbean',
                status: 'closed',
                closing_from: '2020',
                sort: 'closing_latest',
            },
            [[(p) => p.regionname_exact === 'Latin America and Caribbean', 'projects-latam-urban-transport-closed']],
        );
        expect(ids(output)).toEqual(['P132505', 'P111996', 'P169272', 'P117947', 'P145610']);
        expect(output).toContain('Matching projects: 30 before the closing-date filter.');
        expect(output).not.toContain('over the first');
    });

    it('sorts by approval date through the API, within an approval window', async () => {
        const { output, requests } = await run(
            { countries: ['Kenya'], approval_from: '2018', approval_to: '2023-06', sort: 'approval_oldest', limit: 2 },
            [[() => true, 'projects-south-asia-rural-water']],
        );
        expect(requests[0]).toMatchObject({
            countryshortname_exact: 'Kenya',
            strdate: '2018-01-01',
            enddate: '2023-06-30',
            srt: 'boardapprovaldate',
            order: 'asc',
            rows: '2',
        });
        expect(output).toContain('approval date 2018-01-01 to 2023-06-30');
        expect(output).toContain('oldest approval first');
    });

    it('defaults to newest approval without keywords', async () => {
        const { requests, output } = await run({ status: 'Pipeline' }, [
            [() => true, 'projects-south-asia-rural-water'],
        ]);
        expect(requests[0]).toMatchObject({ srt: 'boardapprovaldate', order: 'desc' });
        expect(output).toContain('newest approval first');
    });

    it('merges variants by approval date when sorting by it', async () => {
        scriptHaiku({ variants: ['"rural water"', 'sanitation'] });
        const { output } = await run({ query: 'rural water', sort: 'approval_newest' }, [
            [(p) => p.qterm === '"rural water"', 'projects-south-asia-rural-water'],
            [(p) => p.qterm === 'sanitation', 'projects-andean-rural-roads'],
        ]);
        const approvals = [...output.matchAll(/Approved: (\S+)/g)].map((m) => m[1]);
        expect(approvals.slice(0, 3)).toEqual(['2023-03-28', '2021-06-18', '2021-06-10']);
    });
});

describe('search_projects: limits and errors', () => {
    it('says when closing dates were checked over the first matches only', async () => {
        const projects = Object.fromEntries(
            ['P1', 'P2'].map((id, i) => [id, { id, project_name: `Project ${id}`, closingdate: `6/30/202${i + 5}` }]),
        );
        const { output } = await run({ sort: 'closing_soonest' }, [
            [() => true, () => json({ total: 5000, projects })],
        ]);
        expect(output).toContain(`over the first ${MAX_CLOSING_SCAN} matches of each search only`);
        expect(ids(output)).toEqual(['P1', 'P2']);
    });

    it('lists projects without a closing date last, and leaves them out of a closing window', async () => {
        const projects = {
            P3: { id: 'P3', project_name: 'No closing date' },
            P4: { id: 'P4', project_name: 'Closing', closingdate: '2027-01-31T00:00:00Z' },
        };
        const sorted = await run({ sort: 'closing_latest' }, [[() => true, () => json({ total: 2, projects })]]);
        expect(ids(sorted.output)).toEqual(['P4', 'P3']);
        expect(sorted.output).toContain('Approved: not given · Closing: not given');
        expect(sorted.output).toContain('Commitment: not given');
        const window = await run({ closing_to: '2030' }, [[() => true, () => json({ total: 2, projects })]]);
        expect(ids(window.output)).toEqual(['P4']);
        const none = await run({ closing_to: '2020' }, [[() => true, () => json({ total: 2, projects })]]);
        expect(none.output).toContain('No projects matched.');
    });

    it('shows a current commitment that differs from the total commitment', async () => {
        const { output } = await run({ status: 'Active' }, [[() => true, 'projects-latam-urban-transport-closed']]);
        expect(output).toMatch(/Commitment: US\$[\d.]+ (million|billion)/);
        const kenya = await run({ status: 'Active' }, [
            [
                () => true,
                () => ({
                    body: recorded('projects-bangladesh-agriculture-active').replace('"120,000,000"', '"174,940,000"'),
                }),
            ],
        ]);
        expect(kenya.output).toContain('Commitment: US$175 million · current commitment US$120 million');
    });

    it('refuses an approval window that ends before it starts', async () => {
        const { result, requests } = await run({ approval_from: '2024', approval_to: '2023' }, []);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe('search_projects: approval_from (2024-01-01) is after approval_to (2023-12-31).');
        expect(requests).toHaveLength(0);
    });

    it('turns an upstream failure into a plain error', async () => {
        const { result, requests } = await run({ status: 'Active' }, [[() => true, () => ({ status: 503 })]]);
        expect(requests).toHaveLength(2);
        expect(text(result)).toContain(
            'search_projects could not finish: The World Bank search API (search.worldbank.org) is busy (HTTP 503)',
        );
    });

    it('stays within the budget for long results', async () => {
        const projects = Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
                `P${i}`,
                { id: `P${i}`, project_name: 'n'.repeat(2000), impagency: 'a'.repeat(2000) },
            ]),
        );
        const { output } = await run({ limit: 50 }, [[() => true, () => json({ total: 50, projects })]]);
        expect(output.length).toBeLessThanOrEqual(60_000);
        expect(output).toMatch(/Output truncated after \d+ of 50 projects/);
    });
});

describe('search_projects tool', () => {
    it('is read-only and has a short description', () => {
        expect(searchProjects.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        expect(searchProjects.description.length).toBeLessThanOrEqual(1024);
        expect(searchProjects.description).toContain('commitment (kept separate from total project cost)');
    });

    it('checks inputs with its schema', () => {
        const schema = searchProjects.inputSchema;
        expect(schema.safeParse({ sort: 'newest' }).success).toBe(false);
        expect(schema.safeParse({ closing_from: '30/06/2025' }).success).toBe(false);
        expect(schema.safeParse({ offset: -1 }).success).toBe(false);
    });

    it('runs through its handler with the default transport', async () => {
        sharedCache.clear();
        const fetch = fakeFetch(() => ({
            body: recorded('projects-south-asia-rural-water'),
            headers: { 'content-type': 'application/json' },
        }));
        globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
        try {
            const result = await searchProjects.handler({}, {} as never);
            expect(text(result)).toContain('(P179039)');
            const sent = new URL(String(fetch.mock.calls[0][0]));
            expect(`${sent.hostname}${sent.pathname}`).toBe('search.worldbank.org/api/v2/projects');
        } finally {
            blockNetwork();
            sharedCache.clear();
        }
    });

    it('reports an unexpected error without its details', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await runSearchProjects(
            {},
            { upstream: { search: { getJson: () => Promise.reject(new RangeError('x')) } } as never },
        );
        expect(text(result)).toBe(
            'search_projects failed unexpectedly. Try again; if it fails again, simplify the request.',
        );
        error.mockRestore();
    });
});
