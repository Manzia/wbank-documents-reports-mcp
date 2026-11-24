import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { getProject, getProjectWith, parseResultsFramework, MAX_INDICATORS } from '../../../src/tools/get-project';
import { blockNetwork, fixture, json, testUpstream, type Reply, type Route } from '../upstream/fake-fetch';

const ctx = {} as ServerContext;
const text = (reply: { content: unknown[] }): string => (reply.content[0] as { text: string }).text;
const EMPTY_WDS = { total: 0, documents: { facets: {} } };

// Projects: the recorded full records; WDS: the recorded document counts and latest ISR of P117635.
const route =
    (overrides: { projects?: Reply; facets?: Reply; isr?: Reply } = {}): Route =>
    (url) => {
        const p = url.searchParams;
        if (url.pathname.endsWith('/projects')) {
            if (overrides.projects) return overrides.projects;
            const id = p.get('id');
            return id === 'P117635' || id === 'P125740'
                ? json(fixture(`projects-full-${id}.json`))
                : json({ total: '0', projects: {}, facets: {} });
        }
        const project = p.get('proid');
        if (p.get('fct')) {
            return (
                overrides.facets ?? json(project === 'P117635' ? fixture('wds-facet-docty-P117635.json') : EMPTY_WDS)
            );
        }
        return overrides.isr ?? json(project === 'P117635' ? fixture('wds-isr-latest-P117635.json') : EMPTY_WDS);
    };

const run = async (projectId: string, overrides: Parameters<typeof route>[0] = {}) => {
    const { upstream, fetch } = testUpstream(route(overrides));
    const result = await getProjectWith({ upstream: () => upstream }).handler({ project_id: projectId }, ctx);
    return { result, out: text(result), urls: fetch.mock.calls.map(([url]) => new URL(String(url))) };
};

beforeAll(blockNetwork);

describe('get_project', () => {
    it('is read-only and takes only a project ID', () => {
        expect(getProject.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        expect(getProject.description.length).toBeLessThanOrEqual(1024);
        const schema = getProject.inputSchema;
        expect(schema.safeParse({ project_id: 'P117635' }).success).toBe(true);
        expect(schema.safeParse({ project_id: ' p117635 ' }).success).toBe(true);
        for (const bad of ['117635', 'P1', 'P117635&fl=*', 'https://example.com']) {
            expect(schema.safeParse({ project_id: bad }).success).toBe(false);
        }
    });

    it('asks for the full Projects record, the document counts by type and the latest disclosed ISR', async () => {
        const { urls } = await run('p117635');
        const projects = urls.find((url) => url.pathname.endsWith('/projects'))!.searchParams;
        expect(projects.get('id')).toBe('P117635');
        expect(projects.get('fl')).toBe('*');
        const facets = urls.find((url) => url.searchParams.get('fct'))!.searchParams;
        expect(Object.fromEntries(facets)).toMatchObject({ proid: 'P117635', fct: 'docty_exact', rows: '0' });
        const isr = urls.find((url) => url.searchParams.get('docty_exact'))!.searchParams;
        expect(Object.fromEntries(isr)).toMatchObject({
            proid: 'P117635',
            docty_exact: 'Implementation Status and Results Report',
            srt: 'docdt',
            order: 'desc',
            rows: '1',
        });
    });

    it('returns the identity, key dates and classification of the project', async () => {
        const { result, out } = await run('P117635');
        expect(result.isError).toBeUndefined();
        expect(out).toMatch(/^# Kenya Water Security and Climate Resilience Project \(P117635\)\n/);
        expect(out).toContain('Source: World Bank Projects API record, last updated 2024-05-22.');
        expect(out).toContain('- Status: Active');
        expect(out).toContain('- Country: Kenya\n- Region: Eastern and Southern Africa\n- Borrower: Republic of Kenya');
        expect(out).toContain(
            '- Implementing agency: The National Land Commission, Ministry of Water, Sanitation and Irrigation',
        );
        expect(out).toContain('- Project development objective (PDO): (a) increase access to irrigation water');
        expect(out).toContain('- Board approval: 2013-06-18 (FY2013)');
        expect(out).toContain('- Closing (current): 2025-05-31');
        expect(out).toContain('- Effectiveness: not in the Projects API record');
        expect(out).toContain(
            '- Sectors: Public Administration - Water, Sanitation and Waste Management (40%); Other Water Supply, Sanitation and Waste Management (25%); Irrigation and Drainage (20%); Water Supply (10%); Agricultural markets, commercialization and agri-business (5%)',
        );
        expect(out).toContain(
            '- Themes: Environment and Natural Resource Management (Water Resource Management; Climate change)',
        );
        // Staff names and contacts in the record are not part of the profile.
        expect(out).not.toMatch(/@/);
    });

    it('keeps commitments separate from total project cost', async () => {
        const { out } = await run('P117635');
        const financing = out
            .split('## Financing (commitments are kept separate from project cost)\n')[1]
            .split('\n\n')[0];
        expect(financing.split('\n')).toEqual([
            '- World Bank commitment at approval (IBRD + IDA): US$155.00 million (IDA US$155.00 million)',
            '- Grant commitment: US$19.94 million',
            '- Total commitment at approval, including grants: US$174.94 million',
            '- Current World Bank commitment, net of cancellations: IDA US$111.32 million',
            '- Current total commitment, including co-financiers: US$131.26 million',
            '- Financing plan by source (current, including any borrower contribution): Korea Trust Fund US$3.50 million; Borrower/Recipient US$14.80 million; Germany: Kreditanstalt Fur Wiederaufbau (Kfw) US$16.44 million; Ida Credit US$111.32 million',
            '- Total project cost (all sources; not a World Bank commitment): US$182.67 million; current US$146.06 million',
        ]);
    });

    it('labels implementation status as coming from the latest disclosed ISR, with its date', async () => {
        const { out } = await run('P117635');
        expect(out).toContain('## Performance (implementation status from the latest disclosed ISR)');
        expect(out).toContain(
            'ISR ratings as recorded in the Projects API, from the disclosed ISR dated 2023-11-04 (latest disclosed ISR the Projects API holds):',
        );
        expect(out).toContain(
            '- Overall Implementation Progress (IP): Satisfactory (previous ISR, 2023-07-19: Satisfactory)',
        );
        expect(out).toContain('- Progress towards achievement of PDO: Moderately Satisfactory');
        expect(out).toContain('- Overall Risk: High');
        expect(out).toContain(
            '- Latest disclosed ISR in Documents & Reports: "Disclosable Version of the ISR - Kenya Water Security and Climate Resilience Project - P117635 - Sequence No : 26", dated 2025-05-30 (document ID 40017824, report ISR04454)',
        );
        expect(out).toContain(
            '- That ISR is newer than the ratings above: read it with read_document (document_id 40017824) for its ratings.',
        );
        expect(out).toContain('- No IEG ratings in the record');
    });

    it('lists results indicators, PDO indicators first, with baseline, latest value and target', async () => {
        const { out } = await run('P117635');
        expect(out).toContain(
            'Results indicators from the results framework the Projects API holds (sequence 22, from 2023-11-01):',
        );
        expect(out).toContain(
            '- PDO indicator: Area provided with irrigation and drainage services (ha) (Hectare(Ha)): baseline 0 (2013-10-01); latest 534 (2023-08-31); target 1,358 (2023-11-30)',
        );
        expect(out).toContain('  - of which female (Percentage): baseline 0; latest 0; target 35');
        expect(out).toContain(
            '- Intermediate: Project M&E Established and Operational (Text): baseline NA (2013-10-01)',
        );
        expect(out.indexOf('- PDO indicator:')).toBeLessThan(out.indexOf('- Intermediate:'));
    });

    it('counts the public documents by type as matching document records', async () => {
        const { out } = await run('P117635');
        expect(out).toContain(
            '- 129 public document records in Documents & Reports for P117635. Matching document records by type: Procurement Plan 40; Implementation Status and Results Report 27; Auditing Document 14;',
        );
        expect(out).toMatch(/Next steps: search_documents with project_id P117635/);
    });

    it('shows IEG ratings where they exist, and says when there is no disclosed ISR', async () => {
        const { out } = await run('P125740');
        expect(out).toContain(
            '- IEG evaluation (evaluation type ES, 2017-06-23): outcome Moderately Unsatisfactory; Bank performance Unsatisfactory; quality at entry Moderately Unsatisfactory; quality of supervision Unsatisfactory; Borrower performance Moderately Unsatisfactory; government performance Moderately Satisfactory; implementing agency performance Moderately Unsatisfactory; ICR quality Substantial',
        );
        expect(out).toContain('- No disclosed ISR for this project in Documents & Reports.');
        expect(out).toContain(
            '- 0 public document records in Documents & Reports for P125740. Matching document records by type: none.',
        );
        expect(out).toContain('- Total project cost (all sources; not a World Bank commitment): US$2,721.80 million');
        expect(out).not.toContain('Grant commitment');
    });

    it('still returns the profile when the document searches fail, and says what is missing', async () => {
        const busy: Reply = { status: 503 };
        const { result, out } = await run('P117635', { facets: busy, isr: busy });
        expect(result.isError).toBeUndefined();
        expect(out).toContain('## Identity');
        expect(out).not.toContain('## Documents');
        expect(out).toContain(
            'Note: Document counts are unavailable: The World Bank search API (search.worldbank.org) is busy (HTTP 503)',
        );
        expect(out).toContain('Note: The latest disclosed ISR could not be looked up:');
        expect(out).not.toContain('No disclosed ISR for this project');
    });

    it('says plainly when there is no such project', async () => {
        const { result, out } = await run('P000001');
        expect(result.isError).toBe(true);
        expect(out).toBe(
            'No World Bank project with ID P000001 was found in the Projects API. Check the ID, or find the project with search_projects.',
        );
    });

    it('turns a Projects API failure into a plain message', async () => {
        const { result, out } = await run('P117635', { projects: { status: 403 } });
        expect(result.isError).toBe(true);
        expect(out).toBe(
            'The World Bank search API (search.worldbank.org) refused the request (HTTP 403). Its access rules may have changed.',
        );
    });

    it('logs an unexpected failure and returns a generic message', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const tool = getProjectWith({
            upstream: () => {
                throw new Error('boom');
            },
        });
        const result = await tool.handler({ project_id: 'P117635' }, ctx);
        expect(text(result)).toBe('get_project failed unexpectedly. Try again shortly.');
        expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({ message: 'get_project failed', error: 'boom' });
        error.mockRestore();
    });

    it('reports a record with few fields without inventing any', async () => {
        const sparse = { total: '1', projects: { P100001: { id: 'P100001', project_name: 'Sparse Project' } } };
        const { out } = await run('P100001', { projects: json(sparse) });
        expect(out).toContain('# Sparse Project (P100001)');
        expect(out).toContain('## Identity\n- Not in the Projects API record.');
        expect(out).toContain(
            '## Financing (commitments are kept separate from project cost)\n- Not in the Projects API record.',
        );
        expect(out).toContain('- No ISR ratings in the Projects API record.');
        expect(out).toContain('- No results indicators in the Projects API record.');
    });
});

describe('parseResultsFramework', () => {
    const indicator = (name: string, type: string, values: [string, string, string][], child = '') =>
        `<ParentIndicator IndicatorName="${name}" IndicatorUOMName="Number" IndicatorTypeName="${type}">${values
            .map(
                ([valueType, order, value]) =>
                    `<ParentTransaction><ValueType>${valueType}</ValueType><ValueDate>20200101</ValueDate><VALUE>${value}</VALUE><SortOrder>${order}</SortOrder></ParentTransaction>`,
            )
            .join('')}${child}</ParentIndicator>`;

    it('returns null without a filled-in results framework', () => {
        expect(parseResultsFramework(undefined)).toBeNull();
        expect(parseResultsFramework('<Results><Indicators SequenceNumber="3"/></Results>')).toBeNull();
    });

    it('uses the latest form and takes the first baseline and the latest progress and target', () => {
        const xml =
            '<Results>' +
            `<Indicators SequenceNumber="4" FromDate="2014-01-01T00:00:00">${indicator('Old', 'PDO Indicator', [['PG', 'PG01', '1']])}</Indicators>` +
            `<Indicators SequenceNumber="9" FromDate="2020-01-01T00:00:00">${indicator(
                'Roads &amp; bridges',
                'PDO Indicator',
                [
                    ['BS', 'BS1', '0'],
                    ['BS', 'BS2', '5'],
                    ['PG', 'PG09', '7'],
                    ['PG', 'PG10', '12'],
                    ['PG', 'PG11', ''],
                    ['TG', 'TG02', '20'],
                ],
            )}</Indicators>` +
            '</Results>';
        expect(parseResultsFramework(xml)).toEqual({
            sequence: '9',
            from: '2020-01-01',
            indicators: [
                {
                    name: 'Roads & bridges',
                    unit: 'Number',
                    type: 'PDO Indicator',
                    child: false,
                    baseline: { value: '0', date: '2020-01-01' },
                    latest: { value: '12', date: '2020-01-01' },
                    target: { value: '20', date: '2020-01-01' },
                },
            ],
        });
    });

    it('keeps sub-indicators with their parent and caps the list', async () => {
        const child =
            '<ChildIndicator IndicatorName="of which female" IndicatorUOMName="Percentage" IndicatorTypeName="Intermediate Results Indicator"><ChildTransaction><ValueType>TG</ValueType><ValueDate/><VALUE>40</VALUE><SortOrder>TG1</SortOrder></ChildTransaction></ChildIndicator>';
        const parents = Array.from({ length: MAX_INDICATORS + 2 }, (_, i) =>
            indicator(
                `Indicator ${i}`,
                'Intermediate Results Indicator',
                [['TG', 'TG1', String(i)]],
                i === 0 ? child : '',
            ),
        );
        const framework = parseResultsFramework(
            `<Results><Indicators SequenceNumber="1">${parents.join('')}</Indicators></Results>`,
        )!;
        expect(framework.indicators[1]).toMatchObject({
            name: 'of which female',
            child: true,
            target: { value: '40', date: null },
        });
        const many = {
            id: 'P100002',
            project_name: 'Many',
            indicatormappingdata: `<Results><Indicators SequenceNumber="1">${parents.join('')}</Indicators></Results>`,
        };
        const { out } = await run('P100002', { projects: json({ total: '1', projects: { P100002: many } }) });
        expect(out).toContain(
            '- Intermediate: Indicator 0 (Number): target 0 (2020-01-01)\n  - of which female (Percentage): target 40',
        );
        expect(out).toContain(`- (${MAX_INDICATORS + 3 - MAX_INDICATORS} more indicators left out)`);
    });
});
