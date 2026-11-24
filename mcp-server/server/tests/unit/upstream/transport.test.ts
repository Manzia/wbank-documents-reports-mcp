import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { UpstreamError } from '../../../src/upstream/errors';
import {
    DOCUMENTS_HOST,
    Limiter,
    MAX_PARALLEL,
    ResponseCache,
    SEARCH_HOST,
    TIMEOUT_MS,
    USER_AGENT,
    collectPages,
    defaultConfig,
    openUpstream,
    sharedCache,
} from '../../../src/upstream/transport';
import { blockNetwork, fixture, json, testUpstream } from './fake-fetch';

const WDS = 'https://search.worldbank.org/api/v3/wds?format=json&rows=1';
const TEXT = 'https://documents1.worldbank.org/curated/en/099111526065514117/txt/P513349.txt';

const rejection = async (promise: Promise<unknown>): Promise<UpstreamError> => {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        return error as UpstreamError;
    }
    throw new Error('expected a rejection');
};

beforeAll(blockNetwork);

describe('hosts', () => {
    it.each([
        ['another host', 'https://example.com/api'],
        ['a look-alike host', 'https://search.worldbank.org.example.com/api'],
        ['the other World Bank host', TEXT],
        ['plain http', 'http://search.worldbank.org/api/v3/wds'],
        ['a port', 'https://search.worldbank.org:8443/api/v3/wds'],
        ['credentials', 'https://user:pass@search.worldbank.org/api/v3/wds'],
        ['not a URL', 'search.worldbank.org/api'],
    ])('the search transport refuses %s without sending anything', async (_, url) => {
        const { upstream, fetch } = testUpstream(() => json({}));
        const error = await rejection(upstream.search.getText(url));
        expect(error.kind).toBe('refused-host');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('the documents transport refuses the search host', async () => {
        const { upstream, fetch } = testUpstream(() => json({}));
        expect((await rejection(upstream.documents.getText(WDS))).kind).toBe('refused-host');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('each transport is bound to one host', () => {
        const { upstream } = testUpstream(() => json({}));
        expect(upstream.search.host).toBe(SEARCH_HOST);
        expect(upstream.documents.host).toBe(DOCUMENTS_HOST);
    });

    it('follows a redirect on the same host only', async () => {
        const { upstream, fetch } = testUpstream((url) =>
            url.pathname.includes('/text/')
                ? { status: 301, headers: { location: url.pathname.replace('/text/', '/txt/') } }
                : { body: 'the text' },
        );
        expect(await upstream.documents.getText(TEXT.replace('/txt/', '/text/'))).toBe('the text');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[1][0])).toBe(TEXT);
    });

    it('refuses a redirect to another host', async () => {
        const { upstream, fetch } = testUpstream(() => ({
            status: 302,
            headers: { location: 'https://example.com/x' },
        }));
        expect((await rejection(upstream.search.getText(WDS))).kind).toBe('refused-host');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('stops after too many redirects, or one without a location', async () => {
        const loop = testUpstream((url) => ({ status: 301, headers: { location: `${url.pathname}x` } }));
        expect((await rejection(loop.upstream.search.getText(WDS))).kind).toBe('invalid-response');
        const bare = testUpstream(() => ({ status: 301 }));
        expect((await rejection(bare.upstream.search.getText(WDS))).kind).toBe('invalid-response');
        expect(bare.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('requests', () => {
    it('sends a GET with the descriptive User-Agent and handles redirects itself', async () => {
        const { upstream, fetch } = testUpstream(() => json({ ok: true }));
        expect(await upstream.search.getJson(WDS)).toEqual({ ok: true });
        const init = fetch.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('manual');
        expect((init.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT);
        expect(USER_AGENT).toMatch(/unofficial.*github\.com\/Manzia\/wbank-documents-reports-mcp/);
    });

    it('defaults to a 10-second timeout and one shared cache', () => {
        const config = defaultConfig();
        expect(config.timeoutMs).toBe(TIMEOUT_MS);
        expect(TIMEOUT_MS).toBe(10_000);
        expect(config.cache).toBe(sharedCache);
    });

    it('times out, retries once, then reports a plain message', async () => {
        const { upstream, fetch, sleep } = testUpstream(
            (_, init) =>
                new Promise((_resolve, reject) =>
                    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError'))),
                ),
            { timeoutMs: 20 },
        );
        const error = await rejection(upstream.search.getJson(WDS));
        expect(error.kind).toBe('timeout');
        expect(error.message).toBe(
            'The World Bank search API (search.worldbank.org) did not answer within 0.02 seconds, even after a retry. Try again shortly.',
        );
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('retries a 503 once with backoff and returns the second answer', async () => {
        let calls = 0;
        const { upstream, fetch, sleep } = testUpstream(() => (++calls === 1 ? { status: 503 } : json({ total: 1 })));
        expect(await upstream.search.getJson(WDS)).toEqual({ total: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
        const delay = sleep.mock.calls[0][0];
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThan(2000);
    });

    it('waits for Retry-After, up to 5 seconds', async () => {
        let calls = 0;
        const slow = testUpstream(() => (++calls === 1 ? { status: 429, headers: { 'retry-after': '3' } } : json({})));
        await slow.upstream.search.getJson(WDS);
        expect(slow.sleep.mock.calls[0][0]).toBe(3000);
        calls = 0;
        const slower = testUpstream(() =>
            ++calls === 1 ? { status: 429, headers: { 'retry-after': '60' } } : json({}),
        );
        await slower.upstream.search.getJson(WDS);
        expect(slower.sleep.mock.calls[0][0]).toBe(5000);
    });

    it('reports a 503 that persists after the retry as busy', async () => {
        const { upstream, fetch } = testUpstream(() => ({
            status: 503,
            body: 'exceeded the limits of its provisioned capacity',
        }));
        const error = await rejection(upstream.search.getJson(WDS));
        expect(error).toMatchObject({ kind: 'http', status: 503 });
        expect(error.message).toBe(
            'The World Bank search API (search.worldbank.org) is busy (HTTP 503) and still was after a retry. Wait a minute and try again.',
        );
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 403 and says so plainly', async () => {
        const { upstream, fetch } = testUpstream(() => ({
            status: 403,
            body: '<html>Attention Required! | Cloudflare</html>',
        }));
        const error = await rejection(upstream.documents.getText(TEXT));
        expect(error).toMatchObject({ kind: 'http', status: 403 });
        expect(error.message).toBe(
            'The World Bank documents site (documents1.worldbank.org) refused the request (HTTP 403). Its access rules may have changed.',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('never passes the upstream error body on', async () => {
        const { upstream } = testUpstream(() => json(fixture('wds-error-400.json'), 400));
        const error = await rejection(upstream.search.getJson(WDS));
        expect(error.message).toBe(
            'The World Bank search API (search.worldbank.org) rejected the request as invalid (HTTP 400).',
        );
        expect(error.message).not.toMatch(/Edm|Debug|RequestUrl/);
    });

    it.each([
        [404, 'has no such record or file (HTTP 404).'],
        [500, 'had an internal error (HTTP 500). Try again later.'],
        [418, 'answered with an unexpected HTTP 418.'],
    ])('turns HTTP %i into a plain message', async (status, text) => {
        const { upstream } = testUpstream(() => ({ status }));
        expect((await rejection(upstream.search.getText(WDS))).message).toBe(
            `The World Bank search API (search.worldbank.org) ${text}`,
        );
    });

    it('retries a network failure once', async () => {
        const { upstream, fetch } = testUpstream(() => {
            throw new TypeError('fetch failed');
        });
        const error = await rejection(upstream.search.getText(WDS));
        expect(error.kind).toBe('network');
        expect(error.message).toBe(
            'Could not reach The World Bank search API (search.worldbank.org). Try again shortly.',
        );
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('refuses a web page where a text file was expected', async () => {
        const { upstream } = testUpstream(() => ({ body: '<html></html>', headers: { 'content-type': 'text/html' } }));
        const error = await rejection(upstream.documents.getText(TEXT, { refuseContentTypes: ['text/html'] }));
        expect(error.kind).toBe('invalid-response');
    });

    it('refuses an answer that is too large', async () => {
        const big = testUpstream(() => ({ body: 'x'.repeat(50) }), { maxBodyChars: 10 });
        expect((await rejection(big.upstream.documents.getText(TEXT))).kind).toBe('too-large');
        const declared = testUpstream(() => ({ body: 'x', headers: { 'content-length': '1000' } }), {
            maxBodyChars: 10,
        });
        expect((await rejection(declared.upstream.documents.getText(TEXT))).kind).toBe('too-large');
    });

    it('reports JSON it cannot read', async () => {
        const { upstream } = testUpstream(() => ({ body: '<html>' }));
        const error = await rejection(upstream.search.getJson(WDS));
        expect(error).toMatchObject({ kind: 'invalid-response' });
        expect(error.message).toBe(
            'The World Bank search API (search.worldbank.org) returned a response that could not be read.',
        );
    });
});

describe('cache', () => {
    it('answers a repeated request from memory', async () => {
        const cache = new ResponseCache();
        const first = testUpstream(() => json({ n: 1 }), { cache });
        await first.upstream.search.getJson(WDS);
        const second = testUpstream(() => json({ n: 2 }), { cache });
        expect(await second.upstream.search.getJson(WDS)).toEqual({ n: 1 });
        expect(second.fetch).not.toHaveBeenCalled();
    });

    it('can be skipped, and keeps no failures', async () => {
        let n = 0;
        const { upstream, fetch } = testUpstream(() => (++n <= 2 ? { status: 503 } : json({ n })));
        await rejection(upstream.search.getJson(WDS));
        expect(await upstream.search.getJson(WDS, { cache: false })).toEqual({ n: 3 });
        expect(await upstream.search.getJson(WDS)).toEqual({ n: 4 });
        expect(await upstream.search.getJson(WDS)).toEqual({ n: 4 });
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('sends one request for the same URL asked twice at once', async () => {
        const { upstream, fetch } = testUpstream(() => json({ ok: true }));
        await Promise.all([upstream.search.getJson(WDS), upstream.search.getJson(WDS)]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('evicts the least recently used entries by count and by size', () => {
        const byCount = new ResponseCache(2, 100);
        byCount.set('a', '1');
        byCount.set('b', '2');
        byCount.get('a');
        byCount.set('c', '3');
        expect([byCount.get('a'), byCount.get('b'), byCount.get('c')]).toEqual(['1', undefined, '3']);
        const bySize = new ResponseCache(10, 5);
        bySize.set('a', 'xxx');
        bySize.set('a', 'xx');
        bySize.set('b', 'xxx');
        expect(bySize.size).toBe(2);
        bySize.set('c', 'xx');
        expect(bySize.get('a')).toBeUndefined();
        bySize.set('huge', 'xxxxxx');
        expect(bySize.get('huge')).toBeUndefined();
        bySize.clear();
        expect(bySize.size).toBe(0);
    });
});

describe('parallel requests', () => {
    it('allows at most 3 at once per tool call, across both hosts', async () => {
        let active = 0;
        let peak = 0;
        const { upstream } = testUpstream(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { body: 'ok' };
        });
        await Promise.all([
            ...[1, 2, 3, 4].map((n) => upstream.search.getText(`${WDS}&os=${n}`)),
            ...[1, 2, 3].map((n) => upstream.documents.getText(`${TEXT}?n=${n}`)),
        ]);
        expect(MAX_PARALLEL).toBe(3);
        expect(peak).toBe(3);
    });

    it('gives each tool call its own limit', async () => {
        const limiter = new Limiter(1);
        const order: string[] = [];
        await Promise.all([limiter.run(async () => order.push('a')), limiter.run(async () => order.push('b'))]);
        expect(order).toEqual(['a', 'b']);
        expect(openUpstream().search).not.toBe(openUpstream().search);
    });
});

describe('collectPages', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const pages = jest.fn(async (offset: number, rows: number) => ({
        items: items.slice(offset, offset + rows),
        total: 250,
    }));

    it('fetches a large limit in pages up to the total', async () => {
        const result = await collectPages(pages, { offset: 20, limit: 300, pageSize: 100 });
        expect(result.total).toBe(250);
        expect(result.items).toEqual(items.slice(20));
        expect(pages.mock.calls).toEqual([
            [20, 100],
            [120, 100],
            [220, 30],
        ]);
    });

    it('stops when the first page is all there is', async () => {
        const short = jest.fn(async () => ({ items: [1, 2], total: 1000 }));
        expect(await collectPages(short, { offset: 0, limit: 300, pageSize: 100 })).toEqual({
            items: [1, 2],
            total: 1000,
        });
        expect(short).toHaveBeenCalledTimes(1);
    });
});
