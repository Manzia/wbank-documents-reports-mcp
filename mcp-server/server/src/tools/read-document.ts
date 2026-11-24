import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { HaikuOptions } from '../haiku/client';
import { extractKeywords, reformulateQuery } from '../haiku/reformulate';
import {
    fetchDocumentText,
    isUpstreamError,
    openUpstream,
    searchWds,
    type DocumentRecord,
    type Upstream,
} from '../upstream';
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// Design §5.4: one document, read in parts. The tool finds and returns verbatim text; the client's model reads it
// and decides what to read next. No Haiku re-ranking: pages are chosen by keyword only.

// About 20,000 tokens per result (design §5, "Output budget").
export const MAX_RESULT_CHARS = 60_000;
export const MAX_OUTLINE_ENTRIES = 80;
export const MAX_PAGE_CHARS = 15_000;
export const FIRST_PAGES = 5;
export const MAX_MATCHED_PAGES = 8;
export const MAX_TERMS = 16;
export const PART_CHARS = 4_000;
export const MAX_REQUESTED_PAGES = 60;

const WDS_FIELDS = 'id,docdt,disclosure_date,docty,repnb,display_title,txturl,pdfurl,url,projectid,lang';

// ---------- Pages ----------

export type SplitMethod = 'form-feeds' | 'page-lines' | 'fixed-size';

// A page covers pages `first` to `last` (a range when page-number lines are missing on some pages). Page 0 is
// front matter before printed page 1.
export interface Page {
    first: number;
    last: number;
    text: string;
}

export interface SplitText {
    method: SplitMethod;
    // page-lines only: whether the numbers are the printed ones (false when they don't run in order).
    printed: boolean;
    pages: Page[];
}

const STRICT_PAGE_LINE = /^\s*(?:-\s*(\d{1,4})\s*-|page\s+(\d{1,4})(?:\s+of\s+\d{1,4})?)\s*$/i;
// A "Page N" line that the text file joined with the first line of the page.
const JOINED_PAGE_LINE = /^\s*page\s+(\d{1,4})(?:\s+of\s+\d{1,4})?\s+\S/i;
const HEADER_WINDOW = 3;

const isBlank = (text: string): boolean => text.trim().length === 0;
const lineKey = (line: string): string => line.trim().replace(/\s+/g, ' ').toLowerCase();

interface Marker {
    index: number;
    number: number;
    strict: boolean;
}

interface Chunk {
    text: string;
    marker?: Marker;
}

// The non-empty lines just before line `index` and after line `stop`, nearest first.
const linesBefore = (lines: string[], index: number, count: number, stop = -1): number[] => {
    const found: number[] = [];
    for (let i = index - 1; i > stop && found.length < count; i -= 1) if (!isBlank(lines[i])) found.push(i);
    return found;
};

const numberPages = (markers: Marker[], chunks: Chunk[], header: boolean): SplitText => {
    const numbers = markers.map((marker) => marker.number);
    const printed = numbers.every((n, i) => i === 0 || n > numbers[i - 1]);
    if (!printed) {
        return {
            method: 'page-lines',
            printed,
            pages: chunks.map((chunk, i) => ({ first: i + 1, last: i + 1, text: chunk.text })),
        };
    }
    const final = numbers[numbers.length - 1];
    const pages = chunks.map((chunk): Page => {
        const at = chunk.marker ? markers.indexOf(chunk.marker) : -1;
        let range: [number, number];
        if (header) {
            // Front matter comes before the first page line; then each page line starts a page.
            if (at < 0) range = numbers[0] > 1 ? [1, numbers[0] - 1] : [0, 0];
            else range = [numbers[at], at + 1 < numbers.length ? numbers[at + 1] - 1 : numbers[at]];
        } else if (at < 0) {
            range = [final + 1, final + 1];
        } else {
            range = [at === 0 ? Math.min(1, numbers[0]) : numbers[at - 1] + 1, numbers[at]];
        }
        return { first: range[0], last: Math.max(range[0], range[1]), text: chunk.text };
    });
    return { method: 'page-lines', printed, pages };
};

// Page-number lines are footers ("-12-" at the end of a page) or, in many recent files, part of a running header
// ("The World Bank / <title> / Page 12" at the start of a page). Lines repeated just before most page-number lines
// are a running header.
const splitOnPageLines = (text: string): SplitText | null => {
    const lines = text.split('\n');
    const candidates: Marker[] = [];
    lines.forEach((line, index) => {
        const strict = STRICT_PAGE_LINE.exec(line);
        const match = strict ?? JOINED_PAGE_LINE.exec(line);
        if (match) candidates.push({ index, number: Number(match[1] ?? match[2]), strict: Boolean(strict) });
    });
    if (candidates.length < 2) return null;
    // The lines before each page line, back to the previous one: a line counts once, for the page line after it.
    const windows = candidates.map((candidate, i) =>
        linesBefore(lines, candidate.index, HEADER_WINDOW, i > 0 ? candidates[i - 1].index : -1),
    );
    const seen = new Map<string, number>();
    for (const window of windows) {
        for (const key of new Set(window.map((i) => lineKey(lines[i])))) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const needed = Math.max(2, Math.ceil(candidates.length / 2));
    const header = new Set([...seen].filter(([, count]) => count >= needed).map(([key]) => key));
    const headed = candidates.filter((_, i) => windows[i].length > 0 && header.has(lineKey(lines[windows[i][0]])));
    const chunks: Chunk[] = [];
    if (headed.length >= needed) {
        const starts = headed.map((marker) => {
            let start = marker.index;
            const at = candidates.indexOf(marker);
            for (const i of windows[at]) {
                if (!header.has(lineKey(lines[i]))) break;
                start = i;
            }
            return start;
        });
        const front = lines.slice(0, starts[0]).join('\n');
        if (!isBlank(front)) chunks.push({ text: front });
        headed.forEach((marker, i) =>
            chunks.push({ text: lines.slice(starts[i], starts[i + 1] ?? lines.length).join('\n'), marker }),
        );
        return numberPages(headed, chunks, true);
    }
    const footers = candidates.filter((candidate) => candidate.strict);
    if (footers.length < 2) return null;
    let from = 0;
    for (const marker of footers) {
        chunks.push({ text: lines.slice(from, marker.index + 1).join('\n'), marker });
        from = marker.index + 1;
    }
    const tail = lines.slice(from).join('\n');
    if (!isBlank(tail)) chunks.push({ text: tail });
    return numberPages(footers, chunks, false);
};

const splitFixed = (text: string): SplitText => {
    const pages: Page[] = [];
    let current: string[] = [];
    let length = 0;
    const flush = () => {
        if (!isBlank(current.join('\n'))) {
            const n = pages.length + 1;
            pages.push({ first: n, last: n, text: current.join('\n') });
        }
        current = [];
        length = 0;
    };
    for (let line of text.split('\n')) {
        while (line.length > PART_CHARS) {
            const cut = line.lastIndexOf(' ', PART_CHARS);
            const at = cut > PART_CHARS / 2 ? cut : PART_CHARS;
            flush();
            current.push(line.slice(0, at));
            flush();
            line = line.slice(at).trimStart();
        }
        if (length + line.length > PART_CHARS || (length > PART_CHARS * 0.6 && isBlank(line))) flush();
        current.push(line);
        length += line.length + 1;
    }
    flush();
    return { method: 'fixed-size', printed: false, pages };
};

// Design §5.4 and D6: form feeds, else page-number lines, else fixed-size parts.
export const splitPages = (raw: string): SplitText => {
    const text = raw.replace(/\r\n?/g, '\n');
    const sheets = text.split('\f');
    while (sheets.length > 1 && isBlank(sheets[sheets.length - 1])) sheets.pop();
    if (sheets.length > 1) {
        return {
            method: 'form-feeds',
            printed: true,
            pages: sheets.map((sheet, i) => ({ first: i + 1, last: i + 1, text: sheet })),
        };
    }
    const single = sheets[0];
    return splitOnPageLines(single) ?? splitFixed(single);
};

// ---------- Outline ----------

export interface Heading {
    level: number;
    text: string;
    page: number;
}

const LABELLED =
    /^\s{0,80}((?:annex|appendix|chapter|section|schedule)\s+[0-9IVX]{1,4}|[IVX]{1,5}|[A-H]|\d{1,2}(?:\.\d{1,2}){0,2})([.:)])?\s+(\S.*)$/i;
const TOC_LINE = /\.{5,}|…{2,}/;

const letters = (text: string): string[] => text.match(/\p{L}/gu) ?? [];
const isUpperCase = (text: string): boolean => {
    const all = letters(text);
    return all.length >= 3 && all.filter((c) => /\p{Lu}/u.test(c)).length / all.length >= 0.8;
};
const isTitleCase = (text: string): boolean => {
    const words = text.split(/\s+/).filter((word) => letters(word).length >= 4);
    return words.length > 0 && words.filter((word) => /^\P{L}*\p{Lu}/u.test(word)).length / words.length >= 0.75;
};

const isTocPage = (text: string): boolean => text.split('\n').filter((line) => TOC_LINE.test(line)).length >= 3;

// "KWSCRP    Kenya Water Security and Climate Resilience Project"
const ABBREVIATION_LINE = /^\s*[\p{Lu}\d][\p{L}\d&/.()-]{1,14}\s{2,}\p{Lu}/u;

// A table of contents or a list of abbreviations mentions every topic and answers none.
const isListPage = (text: string): boolean => {
    if (isTocPage(text)) return true;
    const lines = text.split('\n').filter((line) => !isBlank(line));
    return lines.length >= 10 && lines.filter((line) => ABBREVIATION_LINE.test(line)).length / lines.length >= 0.5;
};

type LabelKind = 'named' | 'roman' | 'letter' | 'decimal';

const kindOf = (label: string): LabelKind => {
    if (/^\d/.test(label)) return 'decimal';
    if (/^[a-z]{4,}/i.test(label)) return 'named';
    return /^[IVX]+$/i.test(label) ? 'roman' : 'letter';
};

const headingOf = (line: string): Omit<Heading, 'page'> | null => {
    const match = LABELLED.exec(line);
    if (!match) return null;
    const [, label, punctuation = '', rest] = match;
    const body = rest.trim();
    // Table rows (wide gaps between columns), table-of-contents lines and sentences are not headings.
    if (body.length < 3 || body.length > 120 || /\s{3,}/.test(body) || TOC_LINE.test(body)) return null;
    if (/[.;,]$/.test(body) || letters(body).length < 3 || !/^\P{L}*\p{Lu}/u.test(body)) return null;
    const kind = kindOf(label);
    const upper = isUpperCase(body);
    // "1." and "2.3" number headings; a bare "38" starts a footnote.
    if (kind === 'decimal' && (!upper || !(punctuation || label.includes('.')))) return null;
    if ((kind === 'roman' || kind === 'letter') && (label !== label.toUpperCase() || !punctuation)) return null;
    if (!upper && (!isTitleCase(body) || body.length > 80)) return null;
    const level = kind === 'named' || kind === 'roman' ? 1 : kind === 'letter' ? 2 : label.split('.').length;
    return { level, text: `${label.replace(/\s+/g, ' ')}${punctuation} ${body.replace(/\s+/g, ' ')}` };
};

// The document's numbered headings (ICRs and PADs have them) and the page each starts on.
export const buildOutline = (split: SplitText): Heading[] => {
    const outline: Heading[] = [];
    for (const page of split.pages) {
        if (isTocPage(page.text)) continue;
        const lines = page.text.split('\n');
        lines.forEach((line, i) => {
            const heading = headingOf(line);
            if (!heading) return;
            // A heading in capitals may wrap onto a second line.
            const more = lines[i + 1]?.trim() ?? '';
            if (isUpperCase(heading.text) && more.length > 0 && more.length <= 60 && isUpperCase(more)) {
                if (!headingOf(lines[i + 1]) && !/[.;,]$/.test(more) && !/\s{3,}/.test(more)) {
                    heading.text = `${heading.text} ${more.replace(/\s+/g, ' ')}`;
                }
            }
            if (outline[outline.length - 1]?.text === heading.text) return;
            outline.push({ ...heading, page: page.first });
        });
    }
    return outline;
};

// ---------- Matching ----------

export interface Term {
    text: string;
    pattern: RegExp;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const termOf = (text: string): Term => {
    const body = text.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
    return { text, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, 'giu') };
};

// Neighbouring keywords as written, at most one stopword apart: "operation and maintenance", "road fund".
const phrasesOf = (text: string): string[] => {
    const keywords = new Set(extractKeywords(text).map((keyword) => keyword.toLowerCase()));
    const words = text
        .replace(/"[^"]*"/g, ' | ')
        .split(/\s+/)
        .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    const isKeyword = (word: string | undefined) => Boolean(word && keywords.has(word.toLowerCase()));
    const phrases: string[] = [];
    words.forEach((word, i) => {
        if (!isKeyword(word)) return;
        if (isKeyword(words[i + 1])) phrases.push(`${word} ${words[i + 1]}`);
        else if (words[i + 1] && !isKeyword(words[i + 1]) && isKeyword(words[i + 2])) {
            phrases.push(`${word} ${words[i + 1]} ${words[i + 2]}`);
        }
    });
    return phrases;
};

// The keywords and phrases of the question and of its keyword variants (design §5.4: "with the terms from query
// reformulation"). Phrases come first: quoted ones, then neighbouring words of the question as written.
export const termsOf = (question: string, variants: readonly string[]): Term[] => {
    const seen = new Set<string>();
    const terms: Term[] = [];
    const keywords = [question, ...variants].flatMap(extractKeywords);
    const quotedPhrases = keywords.filter((keyword) => /\s/.test(keyword));
    for (const keyword of [...quotedPhrases, ...phrasesOf(question), ...keywords]) {
        const key = keyword.toLowerCase();
        if (seen.has(key) || (keyword.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
        seen.add(key);
        terms.push(termOf(keyword));
        if (terms.length >= MAX_TERMS) break;
    }
    return terms;
};

export interface Match {
    index: number;
    score: number;
    terms: string[];
}

// Pages ranked by keyword score: rarer terms weigh more, phrases twice as much, pages with more of the terms more,
// and a table of contents little.
export const matchPages = (pages: readonly Page[], terms: readonly Term[]): Match[] => {
    const counts = pages.map((page) => terms.map((term) => page.text.match(term.pattern)?.length ?? 0));
    const documentFrequency = terms.map((_, t) => counts.filter((row) => row[t] > 0).length);
    const matches: Match[] = [];
    counts.forEach((row, index) => {
        let score = 0;
        const found: string[] = [];
        row.forEach((count, t) => {
            if (!count) return;
            const weight = /\s/.test(terms[t].text) ? 2 : 1;
            score += weight * Math.log(1 + pages.length / documentFrequency[t]) * (1 + Math.log(count));
            found.push(terms[t].text);
        });
        if (score <= 0) return;
        score *= found.length / terms.length;
        matches.push({ index, score: isListPage(pages[index].text) ? score / 4 : score, terms: found });
    });
    return matches.sort((a, b) => b.score - a.score || a.index - b.index);
};

// ---------- Page ranges ----------

export interface PageRange {
    from: number;
    to: number;
}

// Returns the ranges, or a message saying what is wrong with the input.
export const parsePageRanges = (input: string): PageRange[] | string => {
    const parts = input
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (!parts.length) return 'Give pages as numbers or ranges, e.g. "40-46" or "3, 12-14".';
    const ranges: PageRange[] = [];
    for (const part of parts) {
        const match = /^(?:pp?\.?\s*)?(\d{1,4})(?:\s*(?:-|–|—|to)\s*(\d{1,4}))?$/i.exec(part);
        if (!match) return `"${part}" is not a page or a page range; give e.g. "40-46".`;
        const from = Number(match[1]);
        const to = Number(match[2] ?? match[1]);
        if (to < from) return `"${part}" ends before it starts.`;
        ranges.push({ from, to });
    }
    const count = new Set(ranges.flatMap(numbersIn)).size;
    if (count > MAX_REQUESTED_PAGES) {
        return `Ask for at most ${MAX_REQUESTED_PAGES} pages at a time (about 12 fit in one result).`;
    }
    return ranges;
};

const numbersIn = ({ from, to }: PageRange): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const formatRanges = (numbers: readonly number[]): string => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
        out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
        i = j;
    }
    return out.length <= 1 ? out.join('') : `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}`;
};

const numbersOf = (pages: readonly Page[]): number[] =>
    pages.flatMap((page) => numbersIn({ from: page.first, to: page.last }));

// ---------- Selection ----------

export interface Selection {
    reason: 'first' | 'question' | 'pages';
    pages: Page[];
    // Matching pages beyond the ones chosen (question), and pages asked for that the document doesn't have (pages).
    otherMatches: number[];
    missing: number[];
    // The terms that matched the chosen pages, and a note on what was searched for.
    terms: string[];
    note?: string;
}

export interface ReadRequest {
    question?: string;
    ranges?: PageRange[];
}

const quoted = (list: readonly string[]): string => list.map((term) => `'${term}'`).join(', ');

export const selectPages = async (split: SplitText, request: ReadRequest, haiku?: HaikuOptions): Promise<Selection> => {
    const { pages } = split;
    if (request.ranges) {
        const wanted = [...new Set(request.ranges.flatMap(numbersIn))];
        const chosen = pages.filter((page) => wanted.some((n) => n >= page.first && n <= page.last));
        const covered = new Set(numbersOf(chosen));
        return {
            reason: 'pages',
            pages: chosen,
            otherMatches: [],
            missing: wanted.filter((n) => !covered.has(n)),
            terms: [],
            note: request.question ? 'The question was not used to choose pages, because pages were given.' : undefined,
        };
    }
    if (request.question) {
        const reformulation = await reformulateQuery(request.question, haiku);
        const found = termsOf(request.question, reformulation.variants);
        const matches = matchPages(pages, found);
        const chosen = matches.slice(0, MAX_MATCHED_PAGES);
        const matched = [...new Set(chosen.flatMap((match) => match.terms))];
        const searched = found.map((term) => term.text);
        return {
            reason: 'question',
            pages: chosen.map((match) => pages[match.index]).sort((a, b) => a.first - b.first),
            otherMatches: matches.slice(MAX_MATCHED_PAGES).map((match) => pages[match.index].first),
            missing: [],
            terms: matched,
            note: searched.length
                ? `Searched for ${quoted(searched)}${reformulation.method === 'haiku' ? ' (from the question and its keyword variants)' : ''}.`
                : 'The question has no words to search for.',
        };
    }
    return { reason: 'first', pages: pages.slice(0, FIRST_PAGES), otherMatches: [], missing: [], terms: [] };
};

// ---------- Output ----------

const unitOf = (split: SplitText): string => (split.method === 'fixed-size' ? 'part' : 'page');
const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const pageLabel = (split: SplitText, page: Page): string => {
    if (split.method === 'fixed-size') return `part ${page.first} of ${split.pages.length}`;
    if (page.first === 0) return 'front matter (before page 1)';
    return page.last > page.first ? `pp. ${page.first}–${page.last}` : `p. ${page.first}`;
};

const countOf = (split: SplitText): string => {
    const { pages } = split;
    if (split.method === 'fixed-size') return `${pages.length} parts`;
    if (split.method === 'form-feeds' || !split.printed) return `${pages.length} pages`;
    const front = pages[0].first === 0;
    const first = front ? (pages[1]?.first ?? 1) : pages[0].first;
    return `printed pages ${first}–${pages[pages.length - 1].last}${front ? ' and front matter' : ''}, in ${pages.length} parts`;
};

const methodNote = (split: SplitText): string => {
    if (split.method === 'form-feeds')
        return 'split at the page breaks in the text file, so page numbers match the PDF';
    if (split.method === 'page-lines' && split.printed) {
        return "split at the printed page-number lines ('Page N' or '-N-'), so page numbers are the printed ones; a page whose number line is missing is joined to a neighbouring page, shown as a range";
    }
    if (split.method === 'page-lines') {
        return 'split at page-number lines that do not run in order, so pages are numbered in file order and may differ from the printed numbers';
    }
    return `the text file has no page breaks or page numbers, so it is split into parts of about ${PART_CHARS.toLocaleString('en-US')} characters; cite a part by its section heading, not as a page`;
};

// Whitespace is compacted (trailing spaces, long runs of spaces, blank lines); the words are verbatim.
const compact = (text: string): string =>
    text
        .split('\n')
        .map((line) => line.replace(/\s+$/, '').replace(/ {4,}/g, '   '))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const pageBlock = (split: SplitText, page: Page, citation: string): string => {
    let text = compact(page.text);
    let note = '';
    if (text.length > MAX_PAGE_CHARS) {
        const more = (text.length - MAX_PAGE_CHARS).toLocaleString('en-US');
        note = `\n[… ${more} more characters of this ${unitOf(split)} left out: the text file has no finer page breaks here.]`;
        text = text.slice(0, MAX_PAGE_CHARS);
    }
    return `### ${pageHeading(split, page)}\nCite as: ${citation}, ${pageLabel(split, page)}.\n\n${text || '[No text on this page.]'}${note}`;
};

const pageHeading = (split: SplitText, page: Page): string => {
    if (split.method === 'fixed-size' || page.first === 0) return capitalised(pageLabel(split, page));
    return page.last > page.first ? `Pages ${page.first}–${page.last}` : `Page ${page.first}`;
};

// "pages 12, 31–33 and 47"; page 0 is the front matter.
const describe = (unit: string, numbers: readonly number[]): string => {
    const numbered = numbers.filter((n) => n > 0);
    const parts = [
        numbers.includes(0) && 'the front matter',
        numbered.length > 0 && `${numbered.length === 1 ? unit : `${unit}s`} ${formatRanges(numbered)}`,
    ];
    return parts.filter(Boolean).join(' and ');
};

export const citationOf = (record: DocumentRecord): string => {
    const type = [record.documentType, record.reportNumber && `(${record.reportNumber})`].filter(Boolean).join(' ');
    return [`"${record.title}"`, type, `World Bank, ${record.documentDate ?? 'undated'}`, record.recordUrl]
        .filter(Boolean)
        .join(', ');
};

export const metadataOf = (record: DocumentRecord): string => {
    const facts = [
        record.documentId && `Document ID ${record.documentId}`,
        record.reportNumber && `report number ${record.reportNumber}`,
        record.documentType,
        record.documentDate && `dated ${record.documentDate}`,
        record.disclosureDate && `disclosed ${record.disclosureDate}`,
        record.projectId && `project ${record.projectId}`,
        typeof record.fields.lang === 'string' && record.fields.lang,
    ].filter(Boolean);
    const links = [record.recordUrl && `Record: ${record.recordUrl}`, record.fileUrl && `PDF: ${record.fileUrl}`];
    return [`# ${record.title}`, facts.join(' · '), links.filter(Boolean).join(' · ')].filter(Boolean).join('\n');
};

const outlineBlock = (outline: readonly Heading[], split: SplitText): string => {
    if (!outline.length) return '## Outline\nNo numbered headings were found in the text.';
    let shown = outline;
    for (let depth = 2; shown.length > MAX_OUTLINE_ENTRIES && depth >= 1; depth -= 1) {
        shown = outline.filter((heading) => heading.level <= depth);
    }
    shown = shown.slice(0, MAX_OUTLINE_ENTRIES);
    const note =
        shown.length < outline.length ? `\n(${outline.length - shown.length} lower-level headings left out.)` : '';
    const where = split.method === 'fixed-size' ? 'part' : 'p.';
    const lines = shown.map(
        (heading) => `${'  '.repeat(Math.min(heading.level, 3) - 1)}- ${heading.text} — ${where} ${heading.page}`,
    );
    return `## Outline (numbered headings and the ${unitOf(split)} each starts on)\n${lines.join('\n')}${note}`;
};

export interface Rendered {
    text: string;
    returned: Page[];
}

export const renderResult = (
    record: DocumentRecord,
    split: SplitText,
    outline: readonly Heading[],
    selection: Selection,
): Rendered => {
    const unit = unitOf(split);
    const citation = citationOf(record);
    const metadata = metadataOf(record);
    const outlineText = outlineBlock(outline, split);
    const blocks: string[] = [];
    const returned: Page[] = [];
    const leftOut: Page[] = [];
    // The coverage note and headings take at most a few thousand characters.
    let budget = MAX_RESULT_CHARS - metadata.length - outlineText.length - 4_000;
    // Pages asked for, and the first pages, are returned in order up to the budget; matching pages as many as fit.
    const inOrder = selection.reason !== 'question';
    for (const page of selection.pages) {
        const block = pageBlock(split, page, citation);
        if (returned.length > 0 && (block.length > budget || (inOrder && leftOut.length > 0))) {
            leftOut.push(page);
            continue;
        }
        budget -= block.length;
        blocks.push(block);
        returned.push(page);
    }
    const lastNumber = split.pages[split.pages.length - 1].last;
    const sentences = [`Coverage: ${countOf(split)} (${methodNote(split)}).`];
    const returnedText = returned.length ? describe(unit, numbersOf(returned)) : `no ${unit}s`;
    if (selection.reason === 'question') {
        sentences.push(
            returned.length
                ? `Returned ${returnedText}, which best match ${quoted(selection.terms)}.`
                : `No ${unit} matched the question.`,
        );
    } else {
        sentences.push(`Returned ${returnedText}${selection.reason === 'first' ? ` (the first ${unit}s)` : ''}.`);
    }
    if (selection.note) sentences.push(selection.note);
    if (selection.missing.length) {
        sentences.push(`Not in this document: ${describe(unit, selection.missing)} (it ends at ${lastNumber}).`);
    }
    const next: string[] = [];
    if (leftOut.length) next.push(`${formatRanges(numbersOf(leftOut))} (left out to stay within the output limit)`);
    if (selection.otherMatches.length) {
        next.push(`${formatRanges(selection.otherMatches.slice(0, 20))} (also matching, less closely)`);
    }
    const after = returned.length ? Math.max(...returned.map((page) => page.last)) : 0;
    if (inOrder && !leftOut.length && after < lastNumber) {
        next.push(`${after + 1}–${Math.min(lastNumber, after + FIRST_PAGES)} (the ${unit}s that follow)`);
    }
    if (next.length) sentences.push(`More is available: ask with pages ${next.join('; ')}.`);
    sentences.push(
        selection.reason === 'question' && !returned.length
            ? `Choose ${unit}s from the outline, or ask with other words.`
            : `Sections not returned may also be relevant: the outline shows where each starts.`,
    );
    const intro = `## ${capitalised(unit)}s (verbatim text from the World Bank's text file, whitespace compacted: quote them directly, with no need to re-read them to confirm)`;
    const text = [metadata, sentences.join(' '), outlineText, blocks.length ? [intro, ...blocks].join('\n\n') : '']
        .filter(Boolean)
        .join('\n\n');
    return { text, returned };
};

// ---------- Tool ----------

export interface ReadDocumentDeps {
    upstream?: () => Upstream;
    haiku?: HaikuOptions;
}

const STEPS = 4;

// Progress notifications for long reads (design §6.1), sent only when the client asked for them.
const progressOf = (ctx: ServerContext) => {
    const token = ctx.mcpReq?._meta?.progressToken;
    return async (progress: number, message: string): Promise<void> => {
        if (token === undefined) return;
        try {
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress, total: STEPS, message },
            });
        } catch {
            // Best effort: the result still goes out.
        }
    };
};

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

const reportKey = (value: string): string => value.toUpperCase().replace(/[\s_-]+/g, '');

export interface Found {
    record: DocumentRecord;
    // Other documents with the same report number.
    others: DocumentRecord[];
}

// Looks the document up through WDS. Returns a plain message when there is no such public document.
export const findDocument = async (
    upstream: Upstream,
    input: { document_id?: string; report_number?: string },
): Promise<Found | string> => {
    if (input.document_id) {
        const result = await searchWds(upstream, { id: input.document_id, fl: WDS_FIELDS, rows: 5 });
        const record = result.records.find((candidate) => candidate.documentId === input.document_id);
        return record
            ? { record, others: [] }
            : `No public document with ID ${input.document_id} was found in Documents & Reports. Check the ID, or find the document with search_documents.`;
    }
    const wanted = input.report_number ?? '';
    const result = await searchWds(upstream, { repnb: wanted, fl: WDS_FIELDS, rows: 20, srt: 'docdt', order: 'desc' });
    const exact = result.records.filter(
        (candidate) => candidate.reportNumber && reportKey(candidate.reportNumber) === reportKey(wanted),
    );
    if (!exact.length) {
        return `No public document with report number ${wanted} was found in Documents & Reports. Check the number, or find the document with search_documents.`;
    }
    const record = exact.find((candidate) => typeof candidate.fields.txturl === 'string') ?? exact[0];
    return { record, others: exact.filter((candidate) => candidate !== record) };
};

// Design §5.4 [Assumption]: without a text file, text could come from the PDF; this server has no PDF reader, so
// it says plainly that the text is unavailable.
const unavailable = (record: DocumentRecord, reason: string): CallToolResult => {
    const links = [
        record.recordUrl && `the record (${record.recordUrl})`,
        record.fileUrl && `the PDF (${record.fileUrl})`,
    ]
        .filter(Boolean)
        .join(' or ');
    return failure(
        `${metadataOf(record)}\n\nThe text of this document is unavailable: ${reason} This server reads only the World Bank's plain-text files and cannot extract text from a PDF, so nothing from the document itself is quoted here.${links ? ` The user can open ${links}.` : ''}`,
    );
};

const inputSchema = z.object({
    document_id: z
        .string()
        .regex(/^\d{1,12}$/, 'A document ID is a number, e.g. 40079232.')
        .optional()
        .describe('Documents & Reports document ID, e.g. 40079232 (the document ID in search_documents results)'),
    report_number: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,39}$/, 'A report number looks like ICR00185.')
        .optional()
        .describe('Report number, e.g. ICR00185, when no document ID is known'),
    question: z
        .string()
        .max(500)
        .optional()
        .describe('What to look for; returns the outline and the pages that best match it by keyword'),
    pages: z
        .string()
        .max(100)
        .optional()
        .describe(
            'Pages to return verbatim, e.g. "40-46" or "3, 12-14", numbered as in the outline and earlier results',
        ),
});

export const readDocumentWith = (deps: ReadDocumentDeps = {}) =>
    defineTool({
        name: 'read_document',
        title: 'Read a World Bank document',
        description:
            'Reads one public World Bank document in parts, given its document ID or report number (from search_documents); it takes no URLs. ' +
            'Without question or pages: the outline (numbered headings with their start pages), the page count and the first pages. ' +
            'With question: the outline and the pages that best match it by keyword. With pages (e.g. "40-46"): exactly those pages. ' +
            'Pages are verbatim, each with its page number and a ready-made citation: quote them directly, with no need to re-read them to confirm. ' +
            'Every result has a coverage note saying which pages were returned; state that coverage in the answer, and ask for the page ranges it names when the answer is not in the pages returned. ' +
            'For multi-step research (comparisons, lessons across projects), call retrieve_skill first.',
        inputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (args, ctx) => {
            if (Boolean(args.document_id) === Boolean(args.report_number)) {
                return failure('Give either document_id or report_number, not both. No request was sent.');
            }
            const ranges = args.pages === undefined ? undefined : parsePageRanges(args.pages);
            if (typeof ranges === 'string') return failure(`${ranges} No request was sent.`);
            const progress = progressOf(ctx);
            try {
                const upstream = (deps.upstream ?? openUpstream)();
                await progress(0, 'looking up the document');
                const found = await findDocument(upstream, args);
                if (typeof found === 'string') return failure(found);
                const { record } = found;
                let text: string;
                try {
                    text = await fetchDocumentText(upstream, record);
                } catch (error) {
                    if (isUpstreamError(error) && (error.kind === 'unavailable' || error.status === 404)) {
                        return unavailable(record, 'no plain-text file is available for it.');
                    }
                    throw error;
                }
                if (isBlank(text)) return unavailable(record, 'its plain-text file is empty.');
                await progress(1, `fetched the document text (${text.length.toLocaleString('en-US')} characters)`);
                const split = splitPages(text);
                const outline = buildOutline(split);
                const unit = unitOf(split);
                await progress(2, `${split.pages.length} ${unit}s and ${outline.length} headings; choosing ${unit}s`);
                const selection = await selectPages(split, { question: args.question, ranges }, deps.haiku);
                const rendered = renderResult(record, split, outline, selection);
                await progress(3, `returning ${rendered.returned.length} ${unit}s`);
                let output = rendered.text;
                if (found.others.length) {
                    const ids = found.others.map((other) => `${other.documentId} (${other.documentDate ?? 'undated'})`);
                    output += `\n\nOther documents with this report number: ${ids.join(', ')}; read one with its document_id.`;
                }
                return { content: [{ type: 'text', text: output }] };
            } catch (error) {
                if (isUpstreamError(error)) return failure(error.message);
                console.error(
                    JSON.stringify({
                        message: 'read_document failed',
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
                return failure('read_document failed unexpectedly. Try again shortly.');
            }
        },
    });

export const readDocument = readDocumentWith();
