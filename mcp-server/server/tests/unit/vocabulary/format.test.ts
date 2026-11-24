import { describe, expect, it } from '@jest/globals';
import {
    VOCABULARY_FILE,
    VOCABULARY_LISTS,
    VOCABULARY_VERSION,
    parseVocabulary,
    serialiseVocabulary,
    type Vocabulary,
    type VocabularyList,
} from '../../../src/vocabulary/format';

const list = (api: 'wds' | 'projects', parameter: string): VocabularyList => ({
    api,
    parameter,
    complete: true,
    notes: [],
    requests: 1,
    values: [{ value: 'Kenya', count: 9743 }],
});

const snapshot = (): Vocabulary => ({
    version: VOCABULARY_VERSION,
    fetchedAt: '2026-11-23T12:00:00.000Z',
    lists: {
        wds: Object.fromEntries(
            Object.entries(VOCABULARY_LISTS.wds).map(([n, p]) => [n, list('wds', p)]),
        ) as Vocabulary['lists']['wds'],
        projects: Object.fromEntries(
            Object.entries(VOCABULARY_LISTS.projects).map(([n, p]) => [n, list('projects', p)]),
        ) as Vocabulary['lists']['projects'],
    },
});

describe('vocabulary.json', () => {
    it('names the lists of design §7.2 and the facet each comes from', () => {
        expect(VOCABULARY_FILE).toBe('vocabulary.json');
        expect(VOCABULARY_LISTS).toEqual({
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
        });
    });

    it('round-trips through its JSON form', () => {
        const text = serialiseVocabulary(snapshot());
        expect(text.endsWith('}\n')).toBe(true);
        expect(parseVocabulary(JSON.parse(text))).toEqual(snapshot());
    });

    it.each([
        ['another version', { ...snapshot(), version: 2 }],
        ['no date', { ...snapshot(), fetchedAt: 'yesterday' }],
        [
            'a missing list',
            {
                ...snapshot(),
                lists: { ...snapshot().lists, projects: { ...snapshot().lists.projects, themes: undefined } },
            },
        ],
        [
            'an empty value',
            {
                ...snapshot(),
                lists: {
                    ...snapshot().lists,
                    wds: {
                        ...snapshot().lists.wds,
                        regions: { ...list('wds', 'x'), values: [{ value: '', count: 1 }] },
                    },
                },
            },
        ],
        ['not an object', 'vocabulary'],
    ])('rejects a snapshot with %s', (_, input) => {
        expect(() => parseVocabulary(input)).toThrow();
    });
});
