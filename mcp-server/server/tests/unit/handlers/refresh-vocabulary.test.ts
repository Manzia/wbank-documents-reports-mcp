import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { lambdaHandler, refreshVocabulary } from '../../../src/handlers/refresh-vocabulary';
import * as fetchModule from '../../../src/vocabulary/fetch';
import { VOCABULARY_FILE, parseVocabulary, type Vocabulary } from '../../../src/vocabulary/format';
import { BUCKET_ENV } from '../../../src/vocabulary/load';
import { blockNetwork, json, testUpstream, type Reply } from '../upstream/fake-fetch';

const BUCKET = 'vocabulary-bucket';
const s3 = mockClient(S3Client);

// A fake facet API answering every facet with two values, unless `override` answers first.
const upstreamFor = (override: (field: string) => Reply | undefined = () => undefined) =>
    testUpstream((url) => {
        const field = url.searchParams.get('fct') ?? '';
        const special = override(field);
        if (special) return special;
        const facets = {
            [field]: {
                0: { name: `${field}-a`, label: `${field}-a`, count: 7 },
                1: { name: `${field}-b`, label: `${field}-b`, count: 3 },
            },
        };
        return url.pathname.endsWith('/wds')
            ? json({ total: 10, documents: { facets } })
            : json({ total: '10', projects: {}, facets });
    });

const refresh = (upstream: ReturnType<typeof upstreamFor>['upstream']) =>
    refreshVocabulary({
        bucket: BUCKET,
        s3: new S3Client({ region: 'us-east-1' }),
        fetchOptions: { upstream, sleep: async () => {}, now: () => new Date('2026-11-24T06:00:00Z') },
    });

const putBody = (): Vocabulary => {
    const [call] = s3.commandCalls(PutObjectCommand);
    return parseVocabulary(JSON.parse(String(call.args[0].input.Body)));
};

const logs: string[] = [];

beforeAll(blockNetwork);

beforeEach(() => {
    s3.reset();
    logs.length = 0;
    jest.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[BUCKET_ENV];
});

describe('refreshVocabulary', () => {
    it('writes vocabulary.json when every list was fetched', async () => {
        s3.on(PutObjectCommand).resolves({ VersionId: 'v2' });
        const { upstream, fetch } = upstreamFor();
        const summary = await refresh(upstream);

        expect(fetch).toHaveBeenCalledTimes(9);
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
        const input = s3.commandCalls(PutObjectCommand)[0].args[0].input;
        expect(input).toMatchObject({
            Bucket: BUCKET,
            Key: VOCABULARY_FILE,
            ContentType: 'application/json; charset=utf-8',
        });
        const written = putBody();
        expect(written.fetchedAt).toBe('2026-11-24T06:00:00.000Z');
        expect(written.lists.wds.documentTypes.values.map((v) => v.value)).toEqual(['docty_exact-a', 'docty_exact-b']);
        expect(summary).toMatchObject({ bucket: BUCKET, key: VOCABULARY_FILE, versionId: 'v2' });
        expect(Object.keys(summary.lists)).toHaveLength(9);
        expect(summary.lists['projects.statuses']).toEqual({ values: 2, complete: true, requests: 1 });
        expect(JSON.parse(logs[0])).toMatchObject({ message: 'vocabulary snapshot written', versionId: 'v2' });
    });

    it('writes nothing and fails when a list could not be fetched', async () => {
        const { upstream } = upstreamFor((field) => (field === 'sector_exact' ? { status: 403 } : undefined));
        await expect(refresh(upstream)).rejects.toMatchObject({ name: 'UpstreamError' });
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('writes nothing and fails when the API keeps failing', async () => {
        const { upstream } = upstreamFor((field) => (field === 'lang_exact' ? { status: 503 } : undefined));
        await expect(refresh(upstream)).rejects.toThrow();
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('writes nothing and fails when a list came back empty', async () => {
        const { upstream } = upstreamFor((field) =>
            field === 'theme_exact' ? json({ total: '0', projects: {}, facets: { theme_exact: {} } }) : undefined,
        );
        await expect(refresh(upstream)).rejects.toThrow('no values fetched for projects.themes; snapshot not written');
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('writes nothing and fails when the snapshot does not match the format', async () => {
        const broken = { version: 1, fetchedAt: 'yesterday', lists: {} } as unknown as Vocabulary;
        await expect(
            refreshVocabulary({ bucket: BUCKET, s3: new S3Client({}), fetch: async () => broken }),
        ).rejects.toMatchObject({ name: 'ZodError' });
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('fails when the write fails', async () => {
        s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));
        const { upstream } = upstreamFor();
        await expect(refresh(upstream)).rejects.toThrow('AccessDenied');
    });

    it('fails before fetching when no bucket is configured', async () => {
        const fetch = jest.fn(fetchModule.fetchVocabulary);
        await expect(refreshVocabulary({ fetch })).rejects.toThrow(`${BUCKET_ENV} is not set`);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('lambdaHandler', () => {
    it('refreshes into the bucket named in the environment with the default fetch options', async () => {
        process.env[BUCKET_ENV] = BUCKET;
        s3.on(PutObjectCommand).resolves({});
        const { upstream } = upstreamFor();
        const real = fetchModule.fetchVocabulary;
        const spy = jest
            .spyOn(fetchModule, 'fetchVocabulary')
            .mockImplementation((options) => real({ ...options, upstream, sleep: async () => {} }));
        const summary = await lambdaHandler();
        expect(spy).toHaveBeenCalledWith({});
        expect(summary.bucket).toBe(BUCKET);
        expect(s3.commandCalls(PutObjectCommand)[0].args[0].input.Bucket).toBe(BUCKET);
    });

    it('logs the reason and rethrows on failure', async () => {
        await expect(lambdaHandler()).rejects.toThrow(`${BUCKET_ENV} is not set`);
        expect(JSON.parse(logs[0])).toEqual({
            message: 'vocabulary refresh failed, snapshot not written',
            error: 'Error',
            reason: `${BUCKET_ENV} is not set`,
        });
    });

    it('logs a thrown non-error', async () => {
        process.env[BUCKET_ENV] = BUCKET;
        jest.spyOn(fetchModule, 'fetchVocabulary').mockRejectedValue('boom');
        await expect(lambdaHandler()).rejects.toBe('boom');
        expect(JSON.parse(logs[0])).toMatchObject({ error: 'unknown', reason: 'boom' });
    });
});
