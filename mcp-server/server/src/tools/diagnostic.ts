import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// Test tool for the walking skeleton (MCP-115); removed in MCP-170.
export const PROGRESS_INTERVAL_SECONDS = 10;

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
    });

export const diagnostic = defineTool({
    name: 'diagnostic',
    title: 'Diagnostic (test only)',
    description:
        'Test tool: waits the given number of seconds, sending a progress notification every 10 seconds, then returns. Does not contact the World Bank.',
    inputSchema: z.object({
        seconds: z.number().int().min(0).max(120).describe('How long to wait, 0 to 120 seconds'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async ({ seconds }, ctx) => {
        const { signal, notify, _meta } = ctx.mcpReq;
        const progressToken = _meta?.progressToken;
        let sent = 0;
        for (let elapsed = 0; elapsed < seconds && !signal.aborted; elapsed += PROGRESS_INTERVAL_SECONDS) {
            if (progressToken !== undefined) {
                await notify({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress: elapsed,
                        total: seconds,
                        message: `waited ${elapsed} of ${seconds} seconds`,
                    },
                });
                sent += 1;
            }
            await wait(Math.min(PROGRESS_INTERVAL_SECONDS, seconds - elapsed) * 1000, signal);
        }
        const text = signal.aborted
            ? `Cancelled before ${seconds} seconds; sent ${sent} progress notifications.`
            : `Waited ${seconds} seconds; sent ${sent} progress notifications.`;
        return { content: [{ type: 'text', text }] };
    },
});
