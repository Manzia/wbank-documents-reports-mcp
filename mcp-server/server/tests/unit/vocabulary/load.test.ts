import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { FetchVocabularyOptions } from '../../../src/vocabulary/fetch';
import type { Vocabulary } from '../../../src/vocabulary/format';
import {
    AGE_METRIC,
    AGE_NAMESPACE,
    BUCKET_ENV,
    LIVE_FETCH_OPTIONS,
    forgetVocabulary,
    loadVocabulary,
} from '../../../src/vocabulary/load';
import { silenceWarnings, warnings } from '../haiku/fake-bedrock';
import { sampleVocabulary } from './sample-vocabulary';

const s3 = mockClient(S3Client);
const body = (text: string) => ({ Body: { transformToString: async () => text } }) as never;
const snapshot = sampleVocabulary('2026-11-01T00:00:00.000Z');
const live = sampleVocabulary('2026-11-24T08:00:00.000Z');

let warn: ReturnType<typeof silenceWarnings>;
let stdout: jest.SpiedFunction<typeof process.stdout.write>;
let fetch: jest.Mock<(options: FetchVocabularyOptions) => Promise<Vocabulary>>;
beforeEach(() => {
    s3.reset();
    forgetVocabulary();
    delete process.env[BUCKET_ENV];
    warn = silenceWarnings();
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetch = jest.fn(async () => live);
});
afterEach(() => {
    jest.restoreAllMocks();
});

const written = () => stdout.mock.calls.map(([chunk]) => String(chunk));

describe('loadVocabulary', () => {
    it('reads the snapshot from the vocabulary bucket once and keeps it in memory', async () => {
        process.env[BUCKET_ENV] = 'vocabulary-bucket';
        s3.on(GetObjectCommand).resolves(body(JSON.stringify(snapshot)));
        const [first, second] = await Promise.all([loadVocabulary({ fetch }), loadVocabulary({ fetch })]);
        expect(first).toEqual(snapshot);
        expect(await loadVocabulary({ fetch })).toBe(first);
        expect(second).toBe(first);
        expect(s3.commandCalls(GetObjectCommand).map((c) => c.args[0].input)).toEqual([
            { Bucket: 'vocabulary-bucket', Key: 'vocabulary.json' },
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('records the snapshot age in days as an EMF metric once per load, and nothing of its content', async () => {
        const now = Date.parse('2026-11-24T12:00:00.000Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        s3.on(GetObjectCommand).resolves(body(JSON.stringify(snapshot)));
        await loadVocabulary({ bucket: 'vocabulary-bucket', fetch });
        await loadVocabulary({ bucket: 'vocabulary-bucket', fetch });
        const lines = written();
        expect(lines).toHaveLength(1);
        expect(lines[0].endsWith('}\n')).toBe(true);
        expect(JSON.parse(lines[0])).toEqual({
            _aws: {
                Timestamp: now,
                CloudWatchMetrics: [
                    { Namespace: AGE_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: AGE_METRIC, Unit: 'None' }] },
                ],
            },
            message: 'vocabulary snapshot loaded',
            [AGE_METRIC]: 23.5,
        });
        expect(AGE_METRIC).toBe('VocabularySnapshotAgeDays');
        expect(AGE_NAMESPACE).toBe('WorldBankMcp');
    });

    it('records no age for lists fetched live', async () => {
        s3.on(GetObjectCommand).resolves(body('{not json'));
        await loadVocabulary({ bucket: 'vocabulary-bucket', fetch });
        forgetVocabulary();
        await loadVocabulary({ fetch });
        expect(written()).toEqual([]);
    });

    it('takes the bucket and client from the options', async () => {
        s3.on(GetObjectCommand).resolves(body(JSON.stringify(snapshot)));
        expect(await loadVocabulary({ bucket: 'other', s3: new S3Client({}), fetch })).toEqual(snapshot);
        expect(s3.commandCalls(GetObjectCommand)[0].args[0].input.Bucket).toBe('other');
    });

    it('fetches the lists live and keeps them when no bucket is configured', async () => {
        expect(await loadVocabulary({ fetch })).toBe(live);
        expect(await loadVocabulary({ fetch })).toBe(live);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(LIVE_FETCH_OPTIONS);
        expect(LIVE_FETCH_OPTIONS).toEqual({ maxRequestsPerList: 1 });
        expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
        expect(warnings(warn)).toEqual([{ message: 'no vocabulary bucket configured, fetching live' }]);
    });

    it.each([
        [
            'no snapshot in the bucket',
            () => s3.on(GetObjectCommand).rejects(Object.assign(new Error('gone'), { name: 'NoSuchKey' })),
            'NoSuchKey',
        ],
        ['an empty object', () => s3.on(GetObjectCommand).resolves(body('')), 'Error'],
        ['an object without a body', () => s3.on(GetObjectCommand).resolves({}), 'Error'],
        ['an unreadable object', () => s3.on(GetObjectCommand).resolves(body('{not json')), 'SyntaxError'],
        ['an object in another format', () => s3.on(GetObjectCommand).resolves(body('{"version":2}')), 'ZodError'],
    ])('fetches the lists live on %s', async (_, setUp, reason) => {
        setUp();
        expect(await loadVocabulary({ bucket: 'vocabulary-bucket', fetch })).toBe(live);
        expect(fetch).toHaveBeenCalledWith(LIVE_FETCH_OPTIONS);
        expect(warnings(warn)).toEqual([{ message: 'vocabulary snapshot unreadable, fetching live', reason }]);
    });

    it('logs a thrown non-error as unknown', async () => {
        s3.on(GetObjectCommand).callsFake(() => Promise.reject('boom'));
        expect(await loadVocabulary({ bucket: 'vocabulary-bucket', fetch })).toBe(live);
        expect(warnings(warn)[0].reason).toBe('unknown');
    });

    it('does not keep a failed live fetch, so the next call tries again', async () => {
        fetch.mockRejectedValueOnce(new Error('search.worldbank.org is busy'));
        await expect(loadVocabulary({ fetch })).rejects.toThrow('busy');
        expect(await loadVocabulary({ fetch })).toBe(live);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
