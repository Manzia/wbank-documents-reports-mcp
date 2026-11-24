import {
    VOCABULARY_LISTS,
    VOCABULARY_VERSION,
    type Vocabulary,
    type VocabularyList,
} from '../../../src/vocabulary/format';

// A small vocabulary in the snapshot format, with values as the APIs list them (MCP-102, check 3). Test data
// only: the resolver itself has no list of values.
const values: Record<string, Record<string, string[]>> = {
    wds: {
        countries: [
            'Kenya',
            'Tanzania',
            'Uganda',
            'Rwanda',
            'Ethiopia',
            'Burundi',
            'South Sudan',
            'Zambia',
            'Gambia, The',
            "Côte d'Ivoire",
            'Korea, Republic of',
            'Niger',
            'Nigeria',
            'Africa',
            'World',
        ],
        regions: [
            'Eastern and Southern Africa',
            'Western and Central Africa',
            'East Asia and Pacific',
            'Europe and Central Asia',
            'Latin America & Caribbean',
            'Middle East and North Africa',
            'South Asia',
        ],
        documentTypes: [
            'Project Appraisal Document',
            'Implementation Status and Results Report',
            'Implementation Completion and Results Report',
            'Procurement Plan',
            'Financing Agreement',
            'Loan Agreement',
            'Project Paper',
            'Program Document',
        ],
        languages: ['English', 'French', 'Spanish', 'Portuguese'],
    },
    projects: {
        countries: ['Kenya', 'Republic of Kenya', 'Tanzania'],
        regions: ['Eastern and Southern Africa', 'Western and Central Africa'],
        sectors: ['Health', 'Roads and highways', 'Irrigation and drainage'],
        themes: ['Rural services and infrastructure'],
        statuses: ['Active', 'Closed', 'Dropped', 'Pipeline'],
    },
};

const list = (api: 'wds' | 'projects', name: string, parameter: string): VocabularyList => ({
    api,
    parameter,
    complete: true,
    notes: [],
    requests: 1,
    values: (values[api][name] ?? []).map((value, i) => ({ value, count: 1000 - i })),
});

export const sampleVocabulary = (fetchedAt = '2026-11-23T12:00:00.000Z'): Vocabulary => ({
    version: VOCABULARY_VERSION,
    fetchedAt,
    lists: {
        wds: Object.fromEntries(
            Object.entries(VOCABULARY_LISTS.wds).map(([name, p]) => [name, list('wds', name, p)]),
        ) as Vocabulary['lists']['wds'],
        projects: Object.fromEntries(
            Object.entries(VOCABULARY_LISTS.projects).map(([name, p]) => [name, list('projects', name, p)]),
        ) as Vocabulary['lists']['projects'],
    },
});
