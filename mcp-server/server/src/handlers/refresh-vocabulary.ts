import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fetchVocabulary, type FetchVocabularyOptions } from '../vocabulary/fetch';
import { VOCABULARY_FILE, serialiseVocabulary, type Vocabulary } from '../vocabulary/format';
import { BUCKET_ENV } from '../vocabulary/load';

// Design §7.2: started every 30 days by EventBridge Scheduler and once by deploy.yml after each deploy. The
// snapshot is written only when every list was fetched; on any failure nothing is written, so the previous
// snapshot (a version in the bucket) stays, and the error fails the invocation, which the alarm reports.

export interface RefreshOptions {
    bucket?: string;
    s3?: S3Client;
    fetch?: (options: FetchVocabularyOptions) => Promise<Vocabulary>;
    fetchOptions?: FetchVocabularyOptions;
}

export interface RefreshSummary {
    bucket: string;
    key: string;
    fetchedAt: string;
    versionId?: string;
    lists: Record<string, { values: number; complete: boolean; requests: number }>;
}

const log = (message: string, fields: Record<string, unknown> = {}): void =>
    console.log(JSON.stringify({ message, ...fields }));

const summarise = (vocabulary: Vocabulary): RefreshSummary['lists'] =>
    Object.fromEntries(
        Object.entries(vocabulary.lists).flatMap(([api, lists]) =>
            Object.entries(lists).map(([name, list]) => [
                `${api}.${name}`,
                { values: list.values.length, complete: list.complete, requests: list.requests },
            ]),
        ),
    );

export const refreshVocabulary = async (options: RefreshOptions = {}): Promise<RefreshSummary> => {
    const bucket = options.bucket ?? process.env[BUCKET_ENV];
    if (!bucket) throw new Error(`${BUCKET_ENV} is not set`);
    const started = Date.now();
    const vocabulary = await (options.fetch ?? fetchVocabulary)(options.fetchOptions ?? {});
    // Validates the whole snapshot against the format before anything is written.
    const body = serialiseVocabulary(vocabulary);
    const lists = summarise(vocabulary);
    const empty = Object.entries(lists)
        .filter(([, list]) => list.values === 0)
        .map(([name]) => name);
    if (empty.length) throw new Error(`no values fetched for ${empty.join(', ')}; snapshot not written`);
    const s3 = options.s3 ?? new S3Client({ region: process.env.AWS_REGION });
    const put = await s3.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: VOCABULARY_FILE,
            Body: body,
            ContentType: 'application/json; charset=utf-8',
        }),
    );
    const summary: RefreshSummary = {
        bucket,
        key: VOCABULARY_FILE,
        fetchedAt: vocabulary.fetchedAt,
        versionId: put.VersionId,
        lists,
    };
    log('vocabulary snapshot written', { ...summary, seconds: Math.round((Date.now() - started) / 1000) });
    return summary;
};

export const lambdaHandler = async (): Promise<RefreshSummary> => {
    try {
        return await refreshVocabulary();
    } catch (error) {
        log('vocabulary refresh failed, snapshot not written', {
            error: error instanceof Error ? error.name : 'unknown',
            reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
};
