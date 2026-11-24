import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { forgetReformulations } from '../../../src/haiku/reformulate';
import {
    FIRST_PAGES,
    MAX_PAGE_CHARS,
    MAX_RESULT_CHARS,
    PART_CHARS,
    buildOutline,
    formatRanges,
    matchPages,
    parsePageRanges,
    readDocument,
    readDocumentWith,
    splitPages,
    termOf,
    termsOf,
    type Page,
} from '../../../src/tools/read-document';
import { awsError, bedrock, haikuCalls, lastPrompt, silenceWarnings, toolAnswer } from '../haiku/fake-bedrock';
import { blockNetwork, fixture, json, testUpstream, type Reply, type Route } from '../upstream/fake-fetch';

const ICR = fixture('document-ICR00185.txt');
const PAD = fixture('document-PADMP00270.txt');
const ICR_ID = '40079232';
const PAD_ID = '40135874';

const text = (reply: { content: unknown[] }): string => (reply.content[0] as { text: string }).text;
const plain = (body: string): Reply => ({ body, headers: { 'content-type': 'text/plain;charset=utf-8' } });

// A WDS record whose text link points at `file` on documents1.
const wdsRecord = (id: string, extra: Record<string, unknown> = {}) => ({
    total: 1,
    documents: {
        [`D${id}`]: {
            id,
            docty: 'Implementation Completion and Results Report',
            docdt: '2025-12-19T05:00:00Z',
            repnb: `ICR${id}`,
            display_title: `Document ${id}`,
            url: `http://documents.worldbank.org/curated/en/0991${id}`,
            pdfurl: `https://documents.worldbank.org/curated/en/0991${id}/pdf/file-${id}.pdf`,
            txturl: `https://documents.worldbank.org/curated/en/0991${id}/text/file-${id}.txt`,
            ...extra,
        },
        facets: {},
    },
});

const route =
    (texts: Record<string, string | Reply> = {}): Route =>
    (url) => {
        if (url.host === 'documents1.worldbank.org') {
            const id = /file-(\d+)\.txt$/.exec(url.pathname)?.[1];
            if (url.pathname.includes('24e62aba')) return plain(ICR);
            if (url.pathname.includes('2bab892a')) return plain(PAD);
            const body = id ? texts[id] : undefined;
            if (body === undefined) return { status: 404 };
            return typeof body === 'string' ? plain(body) : body;
        }
        const p = url.searchParams;
        const id = p.get('id');
        if (id === ICR_ID || id === PAD_ID) return json(fixture(`wds-id-${id}.json`));
        if (p.get('repnb')) {
            const wanted = p.get('repnb')!.toUpperCase().replace(/-/g, '');
            if (wanted === 'ICR00185') return json(fixture('wds-id-40079232.json'));
            return json({ total: 0, documents: { facets: {} } });
        }
        if (id && id in texts) return json(wdsRecord(id));
        return json({ total: 0, documents: { facets: {} } });
    };

const tool = (texts: Record<string, string | Reply> = {}) => {
    const { upstream, fetch } = testUpstream(route(texts));
    return { read: readDocumentWith({ upstream: () => upstream }), fetch };
};

const contextWith = (progressToken?: string, notify = jest.fn(async (n: unknown) => void n)) => ({
    ctx: { mcpReq: { notify, _meta: progressToken ? { progressToken } : undefined } } as unknown as ServerContext,
    notify,
});
const { ctx } = contextWith();

const pagesWith = (...texts: string[]): Page[] => texts.map((t, i) => ({ first: i + 1, last: i + 1, text: t }));

let warn: ReturnType<typeof silenceWarnings>;
beforeAll(blockNetwork);
beforeEach(() => {
    bedrock.reset();
    forgetReformulations();
    warn = silenceWarnings();
});
afterEach(() => warn.mockRestore());

describe('splitPages', () => {
    it('splits on form feeds, so pages match the PDF, and ignores a trailing form feed', () => {
        const split = splitPages(`${ICR}\f\n`);
        expect(split.method).toBe('form-feeds');
        expect(split.pages).toHaveLength(36);
        expect(split.pages.map((page) => page.first)).toEqual(Array.from({ length: 36 }, (_, i) => i + 1));
        expect(split.pages[0].text).toContain('Report No: ICR00185');
        expect(split.pages[11].text).toContain('PROJECT CONTEXT AND DEVELOPMENT OBJECTIVES');
    });

    it('splits on "Page N" lines of a running header, with front matter as page 0', () => {
        const split = splitPages(PAD);
        expect(split.method).toBe('page-lines');
        expect(split.printed).toBe(true);
        expect(split.pages[0]).toMatchObject({ first: 0, last: 0 });
        expect(split.pages.slice(1).map((page) => page.first)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
        // Each page starts with its running header and holds what the printed page holds.
        const page17 = split.pages.find((page) => page.first === 17)!;
        expect(page17.text.split('\n')[0]).toBe('The World Bank');
        expect(page17.text).toMatch(/\nPage 17\n/);
        expect(page17.text).toContain('I. STRATEGIC CONTEXT');
        expect(split.pages[1].text).toContain('I. MPA PROGRAM STRATEGIC CONTEXT');
    });

    it('keeps the text of a page whose "Page N" line is joined with its first line', () => {
        const split = splitPages(PAD);
        expect(split.pages.find((page) => page.first === 3)!.text).toMatch(/^Page 3 providers\./m);
    });

    it('splits after "-N-" footers, joins a page whose footer is missing and keeps the tail', () => {
        const split = splitPages(['Cover', '-1-', 'Two', '- 2 -', 'Three', 'Four', '-4-', 'Five'].join('\n'));
        expect(split).toMatchObject({ method: 'page-lines', printed: true });
        expect(split.pages.map(({ first, last }) => [first, last])).toEqual([
            [1, 1],
            [2, 2],
            [3, 4],
            [5, 5],
        ]);
        expect(split.pages[2].text).toBe('Three\nFour\n-4-');
    });

    it('starts a page at its header when a "Page N" line is missing on one page', () => {
        const header = (n: number) => `Report title\nPage ${n}`;
        const split = splitPages(
            ['Cover page', header(1), 'One', header(2), 'Two', 'Three', header(4), 'Four'].join('\n'),
        );
        expect(split.pages.map(({ first, last }) => [first, last])).toEqual([
            [0, 0],
            [1, 1],
            [2, 3],
            [4, 4],
        ]);
        expect(split.pages[1].text).toBe('Report title\nPage 1\nOne');
    });

    it('numbers pages in file order when the page lines do not run in order', () => {
        const split = splitPages(['A', '-1-', 'B', '-2-', 'Annex A', '-1-', 'Annex B', '-2-'].join('\n'));
        expect(split).toMatchObject({ method: 'page-lines', printed: false });
        expect(split.pages.map((page) => page.first)).toEqual([1, 2, 3, 4]);
    });

    it('splits a file with no page breaks into fixed-size parts without losing text', () => {
        const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. ${'word '.repeat(80).trim()}`);
        const raw = paragraphs.join('\n\n');
        const split = splitPages(raw);
        expect(split.method).toBe('fixed-size');
        expect(split.pages.length).toBeGreaterThan(3);
        for (const page of split.pages) expect(page.text.length).toBeLessThanOrEqual(PART_CHARS + 500);
        expect(
            split.pages
                .map((page) => page.text)
                .join('\n')
                .replace(/\s+/g, ' '),
        ).toBe(raw.replace(/\s+/g, ' '));
    });

    it('cuts a single very long line at spaces', () => {
        const raw = 'x'.repeat(10) + ' ' + 'word '.repeat(3_000);
        const split = splitPages(raw);
        expect(split.method).toBe('fixed-size');
        expect(Math.max(...split.pages.map((page) => page.text.length))).toBeLessThanOrEqual(PART_CHARS);
        expect(
            split.pages
                .map((page) => page.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim(),
        ).toBe(raw.trim());
    });

    it('handles Windows line endings and a single page line', () => {
        expect(splitPages('One\r\n-1-\r\nTwo').method).toBe('fixed-size');
        const split = splitPages('One\r\n-1-\r\nTwo\r\n-2-\r\n');
        expect(split.pages.map((page) => page.text)).toEqual(['One\n-1-', 'Two\n-2-']);
    });
});

describe('buildOutline', () => {
    it('lists the numbered headings of a recorded ICR with the pages they start on', () => {
        const outline = buildOutline(splitPages(ICR)).map(({ level, text: t, page }) => `${level} ${t} — ${page}`);
        expect(outline).toEqual([
            '1 I. PROJECT CONTEXT AND DEVELOPMENT OBJECTIVES — 12',
            '2 A. CONTEXT AT APPRAISAL — 12',
            '2 B. SIGNIFICANT CHANGES DURING IMPLEMENTATION — 14',
            '1 II. OUTCOME — 16',
            '2 A. RELEVANCE OF PDO — 16',
            '2 B. ACHIEVEMENT OF PDOs (EFFICACY) — 16',
            '2 C. EFFICIENCY — 21',
            '2 D. JUSTIFICATION OF OVERALL OUTCOME RATING — 23',
            '2 E. OTHER OUTCOMES AND IMPACTS — 24',
            '2 F. OTHER UNINTENDED OUTCOMES AND IMPACTS — 25',
            '1 III. KEY FACTORS AFFECTED IMPLEMENTATION AND OUTCOME — 25',
            '2 A. KEY FACTORS DURING PREPARATION — 25',
            '2 B. KEY FACTORS DURING IMPLEMENTATION — 26',
            '1 IV. BANK PERFORMANCE, COMPLIANCE ISSUES, AND RISK TO DEVELOPMENT OUTCOME — 28',
            '2 A. QUALITY OF MONITORING AND EVALUATION (M&E) — 28',
            '2 B. ENVIRONMENTAL, SOCIAL, AND FIDUCIARY COMPLIANCE — 29',
            '2 C. BANK PERFORMANCE — 30',
            '2 D. RISK TO DEVELOPMENT OUTCOME — 32',
            '1 V. LESSONS AND RECOMMENDATIONS — 33',
            '1 ANNEX 1. RESULTS FRAMEWORK AND KEY OUTPUTS — 34',
            '2 A. RESULTS FRAMEWORK — 34',
        ]);
    });

    it('lists the numbered headings of a recorded PAD with their printed pages', () => {
        const outline = buildOutline(splitPages(PAD)).map(({ text: t, page }) => `${t} — ${page}`);
        expect(outline).toEqual([
            'I. MPA PROGRAM STRATEGIC CONTEXT — 1',
            'II. MPA PROGRAM DESCRIPTION — 1',
            'A. Program Development Objective and Indicators — 1',
            'B. Program Theory of Change — 2',
            'C. Program Beneficiaries — 2',
            'D. Program Description — 2',
            'E. Program Framework — 3',
            'F. Learning Agenda — 4',
            'G. Program Implementation — 4',
            'H. Overall Program Risk — 4',
            'III. MPA OPERATIONS — 8',
            'I. STRATEGIC CONTEXT — 17',
            'A. Country Context — 17',
            'B. Sectoral and Institutional Context — 18',
            'C. Relevance to Higher Level Objectives — 21',
            'II. PROJECT DESCRIPTION — 22',
            'A. Project Development Objective (PDO) — 22',
            'B. Beneficiaries — 23',
            'C. Components — 23',
            'D. Rationale for Bank Involvement and Role of Partners — 26',
            'E. Lessons Learned Reflected in the Project Design — 27',
            'III. PROJECT IMPLEMENTATION — 28',
            'A. Institutional and Implementation Arrangements — 28',
            'B. Results Monitoring, Evaluation, and Verification Arrangements — 29',
            'C. Sustainability — 29',
            'IV. PROJECT APPRAISAL SUMMARY — 30',
            'A. Technical, Economic and Financial Analysis — 30',
        ]);
    });

    it('skips table-of-contents pages, paragraphs, footnotes and table rows, and joins a wrapped heading', () => {
        const split = splitPages(
            [
                'CONTENTS\nI. CONTEXT ........ 1\nII. OUTCOME ........ 4\nIII. LESSONS ........ 9',
                [
                    'I. PROJECT CONTEXT AND DEVELOPMENT',
                    'OBJECTIVES',
                    '1.      Country context. Kenya emerged from a decade of uneven growth',
                    '2. The Accelerating Access to Water Supply in the Region',
                    '38 PASEA (P178389), AGREE (P173506), and KINELENDA (P171141)',
                    '1. Political and Governance     Substantial',
                    'A. The Recipient shall maintain the project implementation unit',
                    'b. lower case label',
                    '2.1 RESULTS MONITORING',
                    'Annex 2: Detailed Project Description',
                    'Schedule 2 and the Project',
                ].join('\n'),
            ].join('\f'),
        );
        expect(buildOutline(split)).toEqual([
            { level: 1, text: 'I. PROJECT CONTEXT AND DEVELOPMENT OBJECTIVES', page: 2 },
            { level: 2, text: '2.1 RESULTS MONITORING', page: 2 },
            { level: 1, text: 'Annex 2: Detailed Project Description', page: 2 },
        ]);
    });
});

describe('matching', () => {
    it('builds phrases from the question and its quoted variants before single words', () => {
        const terms = termsOf('How was operation and maintenance of the scheme funded?', [
            '"road fund" maintenance',
            'O&M financing',
        ]).map((term) => term.text);
        expect(terms.slice(0, 3)).toEqual(['road fund', 'operation and maintenance', 'scheme funded']);
        expect(terms).toEqual(expect.arrayContaining(['operation', 'maintenance', 'O&M', 'financing']));
        expect(terms).not.toContain('of');
    });

    it('builds no phrases from words that only a stopword run separates', () => {
        expect(termsOf('maintenance of the roads', []).map((term) => term.text)).toEqual(['maintenance', 'roads']);
    });

    it('matches whole words, plurals and phrases across line breaks', () => {
        expect('Road funds and the road\nfund'.match(termOf('road fund').pattern)).toEqual([
            'Road funds',
            'road\nfund',
        ]);
        expect('broadroad'.match(termOf('road').pattern)).toBeNull();
    });

    it('ranks pages with the phrase and more of the terms first, and leaves out pages without them', () => {
        const pages = pagesWith(
            'Maintenance was weak.',
            'The road fund paid for maintenance of the roads.',
            'Nothing relevant here.',
        );
        const matches = matchPages(pages, termsOf('road fund maintenance', []));
        expect(matches.map((match) => match.index)).toEqual([1, 0]);
        expect(matches[0].terms).toEqual(['road fund', 'road', 'fund', 'maintenance']);
    });

    it('ranks a table of contents or a list of abbreviations below a page of text with the same terms', () => {
        const body = 'The road fund paid for maintenance. Road maintenance and the fund.';
        const toc = 'CONTENTS\nroad fund ......\nmaintenance ......\nroad ......';
        const abbreviations = [
            'ABBREVIATIONS',
            'RF       Road Fund',
            'RMU      Road Maintenance Unit',
            ...Array.from({ length: 9 }, (_, i) => `AB${i}      Another Body ${i}`),
        ].join('\n');
        const matches = matchPages(pagesWith(toc, abbreviations, body), termsOf('road fund maintenance', []));
        expect(matches[0].index).toBe(2);
        expect(matches.map((match) => match.index).sort()).toEqual([0, 1, 2]);
    });
});

describe('page ranges', () => {
    it.each([
        ['40-46', [{ from: 40, to: 46 }]],
        [
            '3, 12-14',
            [
                { from: 3, to: 3 },
                { from: 12, to: 14 },
            ],
        ],
        [
            'pp. 5–7; 9 to 10',
            [
                { from: 5, to: 7 },
                { from: 9, to: 10 },
            ],
        ],
    ])('parses %s', (input, ranges) => {
        expect(parsePageRanges(input)).toEqual(ranges);
    });

    it.each([
        ['', 'Give pages as numbers'],
        ['abc', '"abc" is not a page'],
        ['9-3', 'ends before it starts'],
        ['1-61', 'at most 60 pages'],
    ])('refuses %j', (input, message) => {
        expect(parsePageRanges(input)).toEqual(expect.stringContaining(message));
    });

    it('formats page numbers as ranges', () => {
        expect(formatRanges([47, 12, 31, 32, 33, 12])).toBe('12, 31–33 and 47');
        expect(formatRanges([5])).toBe('5');
        expect(formatRanges([])).toBe('');
    });
});

describe('read_document', () => {
    it('is read-only, takes no URL and says pages are verbatim and need no re-reading', () => {
        expect(readDocument.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        expect(Object.keys(readDocument.inputSchema.shape)).toEqual([
            'document_id',
            'report_number',
            'question',
            'pages',
        ]);
        expect(readDocument.description).toMatch(/verbatim/);
        expect(readDocument.description).toMatch(/no need to re-read/);
        expect(readDocument.description.length).toBeLessThanOrEqual(1024);
        expect(readDocument.inputSchema.safeParse({ document_id: 'https://example.com/x.txt' }).success).toBe(false);
        expect(readDocument.inputSchema.safeParse({ report_number: 'ICR00185' }).success).toBe(true);
        expect(readDocument.inputSchema.safeParse({ report_number: 'ICR&fl=*' }).success).toBe(false);
    });

    it.each([[{}], [{ document_id: ICR_ID, report_number: 'ICR00185' }]])(
        'needs exactly one of document_id and report_number (%j)',
        async (args) => {
            const { read, fetch } = tool();
            const result = await read.handler(args, ctx);
            expect(result.isError).toBe(true);
            expect(text(result)).toMatch(/either document_id or report_number/);
            expect(fetch).not.toHaveBeenCalled();
        },
    );

    it('refuses malformed pages before sending anything', async () => {
        const { read, fetch } = tool();
        const result = await read.handler({ document_id: ICR_ID, pages: 'all of them' }, ctx);
        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(/not a page or a page range.*No request was sent/);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('returns the outline, the page count and the first pages, fetching the whole text from documents1 /txt/', async () => {
        const { read, fetch } = tool();
        const result = await read.handler({ document_id: ICR_ID }, ctx);
        expect(result.isError).toBeUndefined();
        const out = text(result);
        expect(out).toMatch(/^# Kenya - Kenya Water Security and Climate Resilience Project\n/);
        expect(out).toContain(
            'Document ID 40079232 · report number ICR00185 · Implementation Completion and Results Report',
        );
        expect(out).toContain(
            'Coverage: 36 pages (split at the page breaks in the text file, so page numbers match the PDF). Returned pages 1–5 (the first pages).',
        );
        expect(out).toContain('More is available: ask with pages 6–10 (the pages that follow).');
        expect(out).toContain('- I. PROJECT CONTEXT AND DEVELOPMENT OBJECTIVES — p. 12');
        expect(out).toContain('  - A. CONTEXT AT APPRAISAL — p. 12');
        expect(out).toContain(
            '### Page 1\nCite as: "Kenya - Kenya Water Security and Climate Resilience Project", Implementation Completion and Results Report (ICR00185), World Bank, 2025-12-19, https://documents.worldbank.org/curated/en/099122425102515384, p. 1.',
        );
        expect(out).toContain('IN THE AMOUNT OF SDR 103.4 MILLION');
        expect(out).not.toContain('### Page 6');
        const urls = fetch.mock.calls.map(([url]) => new URL(String(url)));
        expect(urls[0].searchParams.get('id')).toBe(ICR_ID);
        expect(urls[1].href).toBe(
            'https://documents1.worldbank.org/curated/en/099122425102515384/txt/BOSIB-24e62aba-6021-41bf-82e8-bc2d425ba9ef.txt',
        );
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('returns pages verbatim apart from compacted whitespace', async () => {
        const { read } = tool();
        const out = text(await read.handler({ document_id: ICR_ID, pages: '18' }, ctx));
        const page18 = splitPages(ICR).pages[17].text;
        const words = (s: string) => s.replace(/\s+/g, ' ').trim();
        const returned = out.split('### Page 18\n')[1].split('\n').slice(2).join('\n');
        expect(words(returned)).toBe(words(page18));
    });

    it('with a question, returns the outline and the best keyword-matching pages, with the reformulated terms', async () => {
        bedrock.resolves(
            toolAnswer('keyword_variants', {
                variants: ['"operation and maintenance" irrigation', '"O&M" Lower Nzoia funding'],
            }),
        );
        const { read } = tool();
        const out = text(
            await read.handler(
                { document_id: ICR_ID, question: 'How was maintenance of the irrigation scheme funded?' },
                ctx,
            ),
        );
        expect(out).toMatch(/Returned pages [\d–, and]+, which best match '/);
        expect(out).toContain("Searched for 'operation and maintenance', 'irrigation scheme'");
        expect(out).toContain("'O&M'");
        // The list of abbreviations (pages 3 and 4) mentions every term but answers nothing.
        expect(out).not.toContain('### Page 3\n');
        expect(out).toContain('(from the question and its keyword variants)');
        expect(out).toContain('## Outline');
        expect(out).toMatch(/### Page \d+\nCite as: /);
        expect((out.match(/### Page /g) ?? []).length).toBeLessThanOrEqual(8);
        expect(out).toContain('(also matching, less closely)');
        // One Haiku call, for the reformulation only: no re-ranking, and no document text is sent to Haiku.
        expect(haikuCalls()).toHaveLength(1);
        expect(lastPrompt()).toBe('<request>How was maintenance of the irrigation scheme funded?</request>');
    });

    it('falls back to the question keywords when Haiku fails', async () => {
        bedrock.rejects(awsError('ThrottlingException'));
        const { read } = tool();
        const out = text(await read.handler({ document_id: ICR_ID, question: 'Lower Nzoia irrigation scheme' }, ctx));
        expect(out).toContain("Searched for 'Lower Nzoia', 'Nzoia irrigation', 'irrigation scheme', 'Lower'");
        expect(out).not.toContain('keyword variants');
        expect(out).toMatch(/Returned pages .*, which best match/);
    });

    it('says so when nothing matches the question', async () => {
        bedrock.rejects(awsError('ThrottlingException'));
        const { read } = tool();
        const out = text(await read.handler({ document_id: ICR_ID, question: 'zebra quagga' }, ctx));
        expect(out).toContain('No page matched the question.');
        expect(out).toContain('Choose pages from the outline, or ask with other words.');
        expect(out).not.toContain('### Page');
    });

    it('with pages, returns exactly those pages and names pages the document lacks', async () => {
        const { read } = tool();
        const out = text(await read.handler({ document_id: PAD_ID, pages: '17-18, 90', question: 'ignored' }, ctx));
        expect(out.match(/### Page \d+/g)).toEqual(['### Page 17', '### Page 18']);
        expect(out).toContain(
            "Coverage: printed pages 1–31 and front matter, in 32 parts (split at the printed page-number lines ('Page N' or '-N-')",
        );
        expect(out).toContain('Returned pages 17–18.');
        expect(out).toContain('The question was not used to choose pages, because pages were given.');
        expect(out).toContain('Not in this document: page 90 (it ends at 31).');
        expect(out).toContain('More is available: ask with pages 19–23 (the pages that follow).');
        expect(out).toContain(
            ', Project Appraisal Document (PADMP00270), World Bank, 2026-10-20, https://documents.worldbank.org/curated/en/099102726092029744, p. 17.',
        );
        expect(haikuCalls()).toHaveLength(0);
    });

    it('stays within the output budget and names the pages it left out', async () => {
        const { read } = tool();
        const out = text(await read.handler({ document_id: ICR_ID, pages: '1-36' }, ctx));
        expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
        // In order, without gaps, then the rest as one range.
        const [, last] = /Returned pages 1–(\d+)\./.exec(out)!;
        expect(out).toContain(
            `More is available: ask with pages ${Number(last) + 1}–36 (left out to stay within the output limit).`,
        );
        expect(out).not.toContain('the pages that follow');
    });

    it('cuts a page longer than the page limit and says so', async () => {
        const long = `Short first page\f${'A long table row with many words. '.repeat(1_000)}`;
        const { read } = tool({ '9001': long });
        const out = text(await read.handler({ document_id: '9001', pages: '2' }, ctx));
        expect(out).toMatch(/more characters of this page left out: the text file has no finer page breaks here/);
        expect(out.split('### Page 2\n')[1].length).toBeLessThan(MAX_PAGE_CHARS + 1_000);
    });

    it('labels fixed-size parts and the front matter', async () => {
        const raw = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${'text '.repeat(150)}`).join('\n\n');
        const { read } = tool({ '9002': raw, '9003': 'Cover\nReport title\nPage 1\nOne\nReport title\nPage 2\nTwo' });
        const parts = text(await read.handler({ document_id: '9002' }, ctx));
        expect(parts).toMatch(/Coverage: \d+ parts \(the text file has no page breaks or page numbers/);
        expect(parts).toContain('### Part 1 of ');
        expect(parts).toMatch(/Cite as: .*, part 1 of \d+\./);
        expect(parts).toContain('No numbered headings were found in the text.');
        const front = text(await read.handler({ document_id: '9003', pages: '0-1' }, ctx));
        expect(front).toContain('Returned the front matter and page 1.');
        expect(front).toContain('### Front matter (before page 1)');
    });

    it('looks a document up by report number', async () => {
        const { read, fetch } = tool();
        const out = text(await read.handler({ report_number: 'icr-00185' }, ctx));
        expect(out).toContain('Document ID 40079232');
        const query = new URL(String(fetch.mock.calls[0][0])).searchParams;
        expect(query.get('repnb')).toBe('icr-00185');
        expect(query.get('srt')).toBe('docdt');
    });

    it('names other documents with the same report number', async () => {
        const twin = JSON.parse(fixture('wds-id-40079232.json'));
        twin.documents.D1 = { ...twin.documents.D40079232, id: '1', txturl: undefined, docdt: '2025-12-01T00:00:00Z' };
        const { upstream } = testUpstream((url) => (url.host === 'documents1.worldbank.org' ? plain(ICR) : json(twin)));
        const out = text(
            await readDocumentWith({ upstream: () => upstream }).handler({ report_number: 'ICR00185' }, ctx),
        );
        expect(out).toContain('Document ID 40079232');
        expect(out).toContain(
            'Other documents with this report number: 1 (2025-12-01); read one with its document_id.',
        );
    });

    it.each([
        [{ document_id: '123' }, 'No public document with ID 123 was found'],
        [{ report_number: 'PAD999' }, 'No public document with report number PAD999 was found'],
    ])('says plainly when there is no such document (%j)', async (args, message) => {
        const { read } = tool();
        const result = await read.handler(args, ctx);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(message);
    });

    it('says plainly that the text is unavailable when there is no text file', async () => {
        const noLink = wdsRecord('9004', { txturl: undefined });
        const { upstream } = testUpstream(() => json(noLink));
        const result = await readDocumentWith({ upstream: () => upstream }).handler({ document_id: '9004' }, ctx);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(
            'The text of this document is unavailable: no plain-text file is available for it.',
        );
        expect(text(result)).toContain(
            'cannot extract text from a PDF, so nothing from the document itself is quoted here',
        );
        expect(text(result)).toContain(
            'The user can open the record (https://documents.worldbank.org/curated/en/09919004) or the PDF',
        );
    });

    it('treats a missing (404) or empty text file as unavailable', async () => {
        const { upstream } = testUpstream((url) =>
            url.host === 'documents1.worldbank.org' ? { status: 404 } : json(wdsRecord('9005')),
        );
        const missing = await readDocumentWith({ upstream: () => upstream }).handler({ document_id: '9005' }, ctx);
        expect(text(missing)).toContain('no plain-text file is available for it.');
        const { read } = tool({ '9006': '  \n' });
        expect(text(await read.handler({ document_id: '9006' }, ctx))).toContain('its plain-text file is empty.');
    });

    it('turns an upstream failure into a plain message', async () => {
        const { read } = tool({ '9007': { status: 403 } });
        const result = await read.handler({ document_id: '9007' }, ctx);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
            'The World Bank documents site (documents1.worldbank.org) refused the request (HTTP 403). Its access rules may have changed.',
        );
    });

    it('logs an unexpected failure and returns a generic message', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const read = readDocumentWith({
            upstream: () => {
                throw new Error('boom');
            },
        });
        const result = await read.handler({ document_id: ICR_ID }, ctx);
        expect(text(result)).toBe('read_document failed unexpectedly. Try again shortly.');
        expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({ message: 'read_document failed', error: 'boom' });
        error.mockRestore();
    });

    it('sends progress notifications on a long read when the client asks for them', async () => {
        const { read } = tool();
        const { ctx: withToken, notify } = contextWith('read-1');
        await read.handler({ document_id: ICR_ID }, withToken);
        expect(notify.mock.calls.map(([n]) => (n as { params: { progress: number; message: string } }).params)).toEqual(
            [
                { progressToken: 'read-1', progress: 0, total: 4, message: 'looking up the document' },
                {
                    progressToken: 'read-1',
                    progress: 1,
                    total: 4,
                    message: `fetched the document text (${ICR.length.toLocaleString('en-US')} characters)`,
                },
                { progressToken: 'read-1', progress: 2, total: 4, message: '36 pages and 21 headings; choosing pages' },
                { progressToken: 'read-1', progress: 3, total: 4, message: `returning ${FIRST_PAGES} pages` },
            ],
        );
    });

    it('sends no progress without a token, and a failed notification does not stop the read', async () => {
        const { read } = tool();
        const { ctx: noToken, notify } = contextWith();
        await read.handler({ document_id: ICR_ID }, noToken);
        expect(notify).not.toHaveBeenCalled();
        const failing = jest.fn(async (n: unknown) => {
            void n;
            throw new Error('stream closed');
        });
        const { ctx: broken } = contextWith('read-2', failing);
        const result = await read.handler({ document_id: ICR_ID }, broken);
        expect(result.isError).toBeUndefined();
        expect(failing).toHaveBeenCalled();
    });
});
