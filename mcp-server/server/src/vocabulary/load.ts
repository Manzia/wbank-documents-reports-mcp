import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fetchVocabulary, type FetchVocabularyOptions } from './fetch';
import { VOCABULARY_FILE, parseVocabulary, type Vocabulary } from './format';

// Design §7.2: the snapshot is read once per instance and kept in memory. The bucket name comes from the
// function's environment (set by MCP-135). With no readable snapshot, the lists are fetched live, one request
// per list (9 paced requests), and kept in memory the same way; such lists say they are best-effort.
export const BUCKET_ENV = 'VOCABULARY_BUCKET';
export const LIVE_FETCH_OPTIONS: FetchVocabularyOptions = { maxRequestsPerList: 1 };

export interface LoadOptions {
    bucket?: string;
    s3?: S3Client;
    fetch?: (options: FetchVocabularyOptions) => Promise<Vocabulary>;
}

let loaded: Promise<Vocabulary> | undefined;

const log = (message: string, reason?: string): void =>
    console.warn(JSON.stringify({ message, ...(reason ? { reason } : {}) }));

// Design §11: the age of each snapshot read, in days since its fetchedAt, as an Embedded Metric Format metric that
// the template's alarm watches (no dimensions). Written to stdout: with the JSON log format, Lambda wraps
// console output and CloudWatch no longer extracts the metric. Nothing from the snapshot's content is logged.
export const AGE_NAMESPACE = 'WorldBankMcp';
export const AGE_METRIC = 'VocabularySnapshotAgeDays';
const DAY_MS = 86_400_000;

const recordAge = (vocabulary: Vocabulary): void => {
    const now = Date.now();
    const days = Math.round(((now - Date.parse(vocabulary.fetchedAt)) / DAY_MS) * 100) / 100;
    const document = {
        _aws: {
            Timestamp: now,
            CloudWatchMetrics: [
                { Namespace: AGE_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: AGE_METRIC, Unit: 'None' }] },
            ],
        },
        message: 'vocabulary snapshot loaded',
        [AGE_METRIC]: days,
    };
    process.stdout.write(`${JSON.stringify(document)}\n`);
};

const readSnapshot = async (bucket: string, s3: S3Client): Promise<Vocabulary> => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: VOCABULARY_FILE }));
    const body = await object.Body?.transformToString('utf-8');
    if (!body) throw new Error('empty snapshot');
    return parseVocabulary(JSON.parse(body));
};

const load = async (options: LoadOptions): Promise<Vocabulary> => {
    const bucket = options.bucket ?? process.env[BUCKET_ENV];
    if (bucket) {
        try {
            const snapshot = await readSnapshot(bucket, options.s3 ?? new S3Client({ region: process.env.AWS_REGION }));
            recordAge(snapshot);
            return snapshot;
        } catch (error) {
            log('vocabulary snapshot unreadable, fetching live', error instanceof Error ? error.name : 'unknown');
        }
    } else {
        log('no vocabulary bucket configured, fetching live');
    }
    return (options.fetch ?? fetchVocabulary)(LIVE_FETCH_OPTIONS);
};

// Concurrent callers share one load. A failed live fetch is not kept, so the next call tries again.
export const loadVocabulary = (options: LoadOptions = {}): Promise<Vocabulary> => {
    if (!loaded) {
        const attempt = load(options);
        loaded = attempt;
        attempt.catch(() => {
            if (loaded === attempt) loaded = undefined;
        });
    }
    return loaded;
};

export const forgetVocabulary = (): void => {
    loaded = undefined;
};
