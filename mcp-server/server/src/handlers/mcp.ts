import { streamHandle } from '@hono/aws-lambda';
import { createMcpHandler, type CreateMcpHandlerOptions } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { createServer } from '../tools/registry';

// Design §6.1: stateless MCP handler, one server instance per request, bridged to Lambda response streaming.
// Tool calls are always answered over SSE, so keep-alive pings (every 15 s by default) start at once and
// keep long calls inside CloudFront's 60-second idle limit even when a tool sends no progress.
export const createApp = (options: CreateMcpHandlerOptions = {}): Hono => {
    const mcp = createMcpHandler(createServer, {
        responseMode: 'sse',
        onerror: (error) => console.error(JSON.stringify({ message: 'mcp handler error', error: error.message })),
        ...options,
    });
    const app = new Hono();
    app.all('/mcp', (c) => mcp.fetch(c.req.raw));
    return app;
};

export const lambdaHandler = streamHandle(createApp());
