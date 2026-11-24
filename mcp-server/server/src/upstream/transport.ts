import { UpstreamError } from './errors';

// Design §5, "Upstream access": one transport per host, and no query logic here.
export const SEARCH_HOST = 'search.worldbank.org';
export const DOCUMENTS_HOST = 'documents1.worldbank.org';
export type Host = typeof SEARCH_HOST | typeof DOCUMENTS_HOST;

const HOST_LABELS: Record<Host, string> = {
    [SEARCH_HOST]: 'The World Bank search API (search.worldbank.org)',
    [DOCUMENTS_HOST]: 'The World Bank documents site (documents1.worldbank.org)',
};

export const USER_AGENT =
    'wbank-docs-reports-mcp/0.1 (unofficial MCP server, not affiliated with the World Bank; +https://github.com/Manzia/wbank-documents-reports-mcp)';
export const TIMEOUT_MS = 10_000;
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 5_000;
export const MAX_PARALLEL = 3;
export const MAX_REDIRECTS = 2;
// The largest full-text file seen is about 470,000 characters (MCP-102); anything far larger is refused.
export const MAX_BODY_CHARS = 8_000_000;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Responses kept while the function stays warm (design §5; a persistent cache is A2, on hold).
export class ResponseCache {
    private readonly entries = new Map<string, string>();
    private chars = 0;

    constructor(
        readonly maxEntries = 500,
        readonly maxChars = 48_000_000,
    ) {}

    get(key: string): string | undefined {
        const value = this.entries.get(key);
        if (value !== undefined) {
            this.entries.delete(key);
            this.entries.set(key, value);
        }
        return value;
    }

    set(key: string, value: string): void {
        if (value.length > this.maxChars) return;
        this.delete(key);
        this.entries.set(key, value);
        this.chars += value.length;
        for (const [oldest] of this.entries) {
            if (this.entries.size <= this.maxEntries && this.chars <= this.maxChars) break;
            this.delete(oldest);
        }
    }

    clear(): void {
        this.entries.clear();
        this.chars = 0;
    }

    get size(): number {
        return this.entries.size;
    }

    private delete(key: string): void {
        const value = this.entries.get(key);
        if (value === undefined) return;
        this.entries.delete(key);
        this.chars -= value.length;
    }
}

export const sharedCache = new ResponseCache();

// Caps the requests in flight for one tool call (design §5: at most 3 in parallel).
export class Limiter {
    private active = 0;
    private readonly queue: (() => void)[] = [];

    constructor(readonly max = MAX_PARALLEL) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            this.queue.shift()?.();
        }
    }
}

export interface TransportConfig {
    fetch: typeof fetch;
    timeoutMs: number;
    retryDelayMs: number;
    userAgent: string;
    maxBodyChars: number;
    cache: ResponseCache;
    sleep: (ms: number) => Promise<void>;
}

export interface RequestOptions {
    // false skips the in-memory cache (used by the vocabulary fetch, whose answers are kept elsewhere).
    cache?: boolean;
    // Content types that are refused even with HTTP 200, e.g. a web page where a text file was expected.
    refuseContentTypes?: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultConfig = (): TransportConfig => ({
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: TIMEOUT_MS,
    retryDelayMs: RETRY_DELAY_MS,
    userAgent: USER_AGENT,
    maxBodyChars: MAX_BODY_CHARS,
    cache: sharedCache,
    sleep: defaultSleep,
});

type Attempt = { ok: true; body: string } | { ok: false; retry: boolean; error: UpstreamError; retryAfterMs?: number };

const retryAfterMs = (header: string | null): number | undefined => {
    const seconds = Number(header);
    return header !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

const httpMessage = (label: string, status: number): string => {
    if (status === 400) return `${label} rejected the request as invalid (HTTP 400).`;
    if (status === 403) return `${label} refused the request (HTTP 403). Its access rules may have changed.`;
    if (status === 404) return `${label} has no such record or file (HTTP 404).`;
    if (status === 429 || status === 503)
        return `${label} is busy (HTTP ${status}) and still was after a retry. Wait a minute and try again.`;
    if (status >= 500) return `${label} had an internal error (HTTP ${status}). Try again later.`;
    return `${label} answered with an unexpected HTTP ${status}.`;
};

export class Transport {
    private readonly label: string;

    constructor(
        readonly host: Host,
        private readonly limiter: Limiter,
        private readonly config: TransportConfig,
        private readonly inFlight = new Map<string, Promise<string>>(),
    ) {
        this.label = HOST_LABELS[host];
    }

    async getJson<T = unknown>(url: URL | string, options: RequestOptions = {}): Promise<T> {
        const body = await this.getText(url, options);
        try {
            return JSON.parse(body) as T;
        } catch {
            throw new UpstreamError('invalid-response', `${this.label} returned a response that could not be read.`);
        }
    }

    async getText(url: URL | string, options: RequestOptions = {}): Promise<string> {
        const target = this.check(url);
        const key = target.href;
        const useCache = options.cache !== false;
        if (useCache) {
            const cached = this.config.cache.get(key);
            if (cached !== undefined) return cached;
            const pending = this.inFlight.get(key);
            if (pending) return pending;
        }
        const request = this.fetchWithRetry(target, options).then((body) => {
            if (useCache) this.config.cache.set(key, body);
            return body;
        });
        if (!useCache) return request;
        this.inFlight.set(key, request);
        try {
            return await request;
        } finally {
            this.inFlight.delete(key);
        }
    }

    private check(url: URL | string): URL {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new UpstreamError('refused-host', 'Refused a request to an address that is not a valid URL.');
        }
        if (
            parsed.protocol !== 'https:' ||
            parsed.hostname !== this.host ||
            parsed.port ||
            parsed.username ||
            parsed.password
        ) {
            throw new UpstreamError(
                'refused-host',
                `Refused a request to ${parsed.host || 'an unknown host'}: this transport only contacts https://${this.host}.`,
            );
        }
        return parsed;
    }

    private async fetchWithRetry(url: URL, options: RequestOptions): Promise<string> {
        const first = await this.limiter.run(() => this.attempt(url, options));
        if (first.ok) return first.body;
        if (!first.retry) throw first.error;
        const backoff = this.config.retryDelayMs * (1 + Math.random());
        await this.config.sleep(Math.max(backoff, Math.min(first.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)));
        const second = await this.limiter.run(() => this.attempt(url, options));
        if (second.ok) return second.body;
        throw second.error;
    }

    private async attempt(url: URL, options: RequestOptions): Promise<Attempt> {
        const signal = AbortSignal.timeout(this.config.timeoutMs);
        let current = url;
        try {
            for (let redirects = 0; ; redirects += 1) {
                const response = await this.config.fetch(current, {
                    method: 'GET',
                    redirect: 'manual',
                    headers: { 'user-agent': this.config.userAgent, accept: 'application/json, text/plain;q=0.9' },
                    signal,
                });
                if (REDIRECT_STATUSES.has(response.status)) {
                    await response.body?.cancel();
                    const location = response.headers.get('location');
                    if (!location || redirects >= MAX_REDIRECTS) {
                        return this.fail('invalid-response', `${this.label} redirected the request too often.`);
                    }
                    // A redirect may stay on this host only; check() throws for any other.
                    current = this.check(new URL(location, current));
                    continue;
                }
                if (response.status !== 200) {
                    await response.body?.cancel();
                    return {
                        ok: false,
                        retry: RETRY_STATUSES.has(response.status),
                        error: new UpstreamError('http', httpMessage(this.label, response.status), response.status),
                        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
                    };
                }
                const type = response.headers.get('content-type') ?? '';
                if (options.refuseContentTypes?.some((refused) => type.toLowerCase().startsWith(refused))) {
                    await response.body?.cancel();
                    return this.fail(
                        'invalid-response',
                        `${this.label} returned a web page instead of the expected file.`,
                    );
                }
                const length = Number(response.headers.get('content-length'));
                if (Number.isFinite(length) && length > this.config.maxBodyChars * 4) {
                    await response.body?.cancel();
                    return this.fail('too-large', `${this.label} returned a file too large to read here.`);
                }
                const body = await response.text();
                if (body.length > this.config.maxBodyChars) {
                    return this.fail('too-large', `${this.label} returned a file too large to read here.`);
                }
                return { ok: true, body };
            }
        } catch (error) {
            if (error instanceof UpstreamError) throw error;
            if (signal.aborted) {
                return {
                    ok: false,
                    retry: true,
                    error: new UpstreamError(
                        'timeout',
                        `${this.label} did not answer within ${this.config.timeoutMs / 1000} seconds, twice. Try again shortly.`,
                    ),
                };
            }
            return {
                ok: false,
                retry: true,
                error: new UpstreamError('network', `Could not reach ${this.label}. Try again shortly.`),
            };
        }
    }

    private fail(kind: 'invalid-response' | 'too-large', message: string): Attempt {
        return { ok: false, retry: false, error: new UpstreamError(kind, message) };
    }
}

export interface Upstream {
    search: Transport;
    documents: Transport;
}

// One per tool call: both transports share the call's limit of parallel requests and the warm cache.
export const openUpstream = (overrides: Partial<TransportConfig> = {}): Upstream => {
    const config = { ...defaultConfig(), ...overrides };
    const limiter = new Limiter(MAX_PARALLEL);
    return {
        search: new Transport(SEARCH_HOST, limiter, config),
        documents: new Transport(DOCUMENTS_HOST, limiter, config),
    };
};

export interface Page<T> {
    items: T[];
    total: number;
}

// Fetches `limit` items from `offset` in pages of at most `pageSize`: the first page, then the rest at once
// (the limiter keeps it to MAX_PARALLEL). Stops at the reported total.
export const collectPages = async <T>(
    fetchPage: (offset: number, rows: number) => Promise<Page<T>>,
    { offset, limit, pageSize }: { offset: number; limit: number; pageSize: number },
): Promise<Page<T>> => {
    const first = await fetchPage(offset, Math.min(limit, pageSize));
    const wanted = Math.max(0, Math.min(limit, first.total - offset));
    if (first.items.length >= wanted || first.items.length < Math.min(limit, pageSize)) {
        return { items: first.items.slice(0, limit), total: first.total };
    }
    const starts: number[] = [];
    for (let start = offset + first.items.length; start < offset + wanted; start += pageSize) starts.push(start);
    const rest = await Promise.all(
        starts.map((start) => fetchPage(start, Math.min(pageSize, offset + wanted - start))),
    );
    return { items: [first.items, ...rest.map((page) => page.items)].flat().slice(0, limit), total: first.total };
};
