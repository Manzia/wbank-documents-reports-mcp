import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { diagnostic } from '../../../src/tools/diagnostic';

const contextWith = (progressToken?: string, controller = new AbortController()) => {
    const notify = jest.fn(async (notification: { method: string; params: Record<string, unknown> }) => {
        void notification;
    });
    const ctx = {
        mcpReq: { signal: controller.signal, notify, _meta: progressToken ? { progressToken } : undefined },
    } as unknown as ServerContext;
    return { ctx, notify, controller };
};

describe('diagnostic', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('accepts 0 to 120 seconds only', () => {
        expect(diagnostic.inputSchema.safeParse({ seconds: 0 }).success).toBe(true);
        expect(diagnostic.inputSchema.safeParse({ seconds: 120 }).success).toBe(true);
        expect(diagnostic.inputSchema.safeParse({ seconds: 121 }).success).toBe(false);
        expect(diagnostic.inputSchema.safeParse({ seconds: -1 }).success).toBe(false);
        expect(diagnostic.inputSchema.safeParse({ seconds: 1.5 }).success).toBe(false);
    });

    it('sends a progress notification every 10 seconds, then returns', async () => {
        const { ctx, notify } = contextWith('token-1');
        const call = diagnostic.handler({ seconds: 25 }, ctx);
        await jest.advanceTimersByTimeAsync(9_999);
        expect(notify).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(notify).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(15_000);
        const result = await call;
        expect(notify.mock.calls.map(([notification]) => notification.params.progress)).toEqual([0, 10, 20]);
        expect(notify).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: { progressToken: 'token-1', progress: 20, total: 25, message: 'waited 20 of 25 seconds' },
        });
        expect(result.content[0]).toEqual({ type: 'text', text: 'Waited 25 seconds; sent 3 progress notifications.' });
    });

    it('sends no progress notifications without a progress token', async () => {
        const { ctx, notify } = contextWith();
        const call = diagnostic.handler({ seconds: 20 }, ctx);
        await jest.advanceTimersByTimeAsync(20_000);
        await expect(call).resolves.toEqual({
            content: [{ type: 'text', text: 'Waited 20 seconds; sent 0 progress notifications.' }],
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it('stops waiting when the request is cancelled', async () => {
        const { ctx, controller } = contextWith('token-2');
        const call = diagnostic.handler({ seconds: 120 }, ctx);
        await jest.advanceTimersByTimeAsync(15_000);
        controller.abort();
        const result = await call;
        expect(result.content[0]).toEqual({
            type: 'text',
            text: 'Cancelled before 120 seconds; sent 2 progress notifications.',
        });
    });

    it('returns at once when already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const { ctx, notify } = contextWith('token-3', controller);
        const result = await diagnostic.handler({ seconds: 30 }, ctx);
        expect(notify).not.toHaveBeenCalled();
        expect(result.content[0]).toEqual({
            type: 'text',
            text: 'Cancelled before 30 seconds; sent 0 progress notifications.',
        });
    });
});
