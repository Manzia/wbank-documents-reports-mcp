import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResponseCache, openUpstream, type TransportConfig, type Upstream } from '../../../src/upstream/transport';

// Unit tests never reach the network (plan D8): every transport gets a fake fetch, and the global one throws.
export const blockNetwork = (): void => {
    globalThis.fetch = (() => {
        throw new Error('unit tests must not call the network');
    }) as typeof fetch;
};

export const fixture = (name: string): string => readFileSync(join(__dirname, '..', '..', 'fixtures', name), 'utf8');

export interface Reply {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
}

export type Route = (url: URL, init: RequestInit) => Reply | Promise<Reply>;

export const json = (body: unknown, status = 200): Reply => ({
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json; charset=utf-8' },
});

export const fakeFetch = (route: Route) =>
    jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const reply = await route(url, init ?? {});
        return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers });
    });

export const testUpstream = (
    route: Route,
    overrides: Partial<TransportConfig> = {},
): { upstream: Upstream; fetch: ReturnType<typeof fakeFetch>; sleep: jest.Mock<(ms: number) => Promise<void>> } => {
    const fetch = fakeFetch(route);
    const sleep = jest.fn(async (ms: number) => {
        void ms;
    });
    const upstream = openUpstream({
        fetch: fetch as unknown as typeof globalThis.fetch,
        sleep,
        cache: new ResponseCache(),
        ...overrides,
    });
    return { upstream, fetch, sleep };
};
