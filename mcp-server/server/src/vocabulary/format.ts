import * as z from 'zod';
import type { Api } from '../upstream/params';

// vocabulary.json (design §7.2): each filter's valid values as the APIs list them (their facets), with the date
// fetched. Written by the refresh function (MCP-135), read at cold start (MCP-131).
export const VOCABULARY_VERSION = 1;
export const VOCABULARY_FILE = 'vocabulary.json';

// Each list and the facet it comes from. Values differ between the APIs (e.g. region names), so each API's
// filters resolve against that API's own lists.
export const VOCABULARY_LISTS = {
    wds: {
        countries: 'count_exact',
        regions: 'admreg_exact',
        documentTypes: 'docty_exact',
        languages: 'lang_exact',
    },
    projects: {
        countries: 'countryshortname_exact',
        regions: 'regionname_exact',
        sectors: 'sector_exact',
        themes: 'theme_exact',
        statuses: 'status_exact',
    },
} as const satisfies Record<Api, Record<string, string>>;

export type WdsListName = keyof typeof VOCABULARY_LISTS.wds;
export type ProjectsListName = keyof typeof VOCABULARY_LISTS.projects;

const valueSchema = z.object({
    value: z.string().min(1),
    // The number of matching records the facet reported (the largest seen when partitions were combined).
    count: z.number().int().nonnegative(),
});

const listSchema = z.object({
    api: z.enum(['wds', 'projects']),
    parameter: z.string().min(1),
    // false: a best-effort union of partitioned facet queries that can't be shown to hold every value (D7).
    complete: z.boolean(),
    // Why a list is best-effort, e.g. "request budget (60) reached".
    notes: z.array(z.string()),
    requests: z.number().int().nonnegative(),
    values: z.array(valueSchema),
});

const listsOf = <K extends string>(names: readonly K[]) =>
    z.object(Object.fromEntries(names.map((name) => [name, listSchema])) as Record<K, typeof listSchema>);

export const vocabularySchema = z.object({
    version: z.literal(VOCABULARY_VERSION),
    fetchedAt: z.iso.datetime(),
    lists: z.object({
        wds: listsOf(Object.keys(VOCABULARY_LISTS.wds) as WdsListName[]),
        projects: listsOf(Object.keys(VOCABULARY_LISTS.projects) as ProjectsListName[]),
    }),
});

export type VocabularyValue = z.infer<typeof valueSchema>;
export type VocabularyList = z.infer<typeof listSchema>;
export type Vocabulary = z.infer<typeof vocabularySchema>;

// Throws a ZodError when the input is not a valid snapshot.
export const parseVocabulary = (input: unknown): Vocabulary => vocabularySchema.parse(input);

export const serialiseVocabulary = (vocabulary: Vocabulary): string =>
    `${JSON.stringify(vocabularySchema.parse(vocabulary), null, 2)}\n`;
