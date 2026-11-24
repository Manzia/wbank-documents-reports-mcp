import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';
import type { Context } from 'aws-lambda';
import { createApp, lambdaHandler } from '../../../src/handlers/mcp';
import type { HttpResponseMetadata } from '../../setup/awslambda';
import { LEGACY_PROTOCOL_VERSION, initializeParams, jsonRpc, mcpPost, messagesIn } from '../helpers';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'unit-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
};
const modernHeaders = (method: string, name?: string): Record<string, string> => ({
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
});

const functionUrlEvent = (body: unknown, method = 'POST', path = '/mcp') => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
        host: 'abc123.lambda-url.us-east-1.on.aws',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    },
    requestContext: {
        accountId: 'anonymous',
        apiId: 'abc123',
        domainName: 'abc123.lambda-url.us-east-1.on.aws',
        domainPrefix: 'abc123',
        http: { method, path, protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'unit-test' },
        requestId: 'request-1',
        routeKey: '$default',
        stage: '$default',
        time: '23/Nov/2026:12:00:00 +0000',
        timeEpoch: 1795435200000,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
});

type StreamingHandler = (event: unknown, stream: PassThrough, context: Context) => Promise<void>;

const invokeLambda = async (event: unknown) => {
    const stream = new PassThrough() as PassThrough & { metadata?: HttpResponseMetadata };
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    await (lambdaHandler as unknown as StreamingHandler)(event, stream, {} as Context);
    return { metadata: stream.metadata, body: Buffer.concat(chunks).toString('utf8') };
};

describe('MCP handler (stateless, legacy 2025 fallback)', () => {
    const app = createApp();

    it('answers initialize with the server info and tools capability', async () => {
        const res = await app.fetch(mcpPost(jsonRpc(1, 'initialize', initializeParams)));
        expect(res.status).toBe(200);
        const [message] = messagesIn(await res.text());
        expect(message.id).toBe(1);
        expect(message.result.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
        expect(message.result.serverInfo.name).toBe('wbank-documents-reports-mcp');
        expect(message.result.serverInfo.description).toMatch(/not affiliated with the World Bank/i);
        expect(message.result.capabilities.tools).toBeDefined();
    });

    it('answers tools/list with the six tools', async () => {
        const res = await app.fetch(
            mcpPost(jsonRpc(2, 'tools/list'), { 'mcp-protocol-version': LEGACY_PROTOCOL_VERSION }),
        );
        expect(res.status).toBe(200);
        const [message] = messagesIn(await res.text());
        expect(message.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
            'search_documents',
            'search_projects',
            'get_project',
            'read_document',
            'retrieve_skill',
            'diagnostic',
        ]);
    });

    it('answers a stub tool call with a "not available yet" error', async () => {
        const res = await app.fetch(
            mcpPost(jsonRpc(3, 'tools/call', { name: 'get_project', arguments: { project_id: 'P117635' } })),
        );
        const [message] = messagesIn(await res.text());
        expect(message.result.isError).toBe(true);
        expect(message.result.content[0].text).toMatch(/not available yet/);
    });

    it('refuses GET (no sessions) and unknown paths', async () => {
        expect((await app.fetch(new Request('https://function-url.example/mcp'))).status).toBe(405);
        expect((await app.fetch(new Request('https://function-url.example/other'))).status).toBe(404);
    });
});

describe('MCP handler (2026-07-28 revision)', () => {
    const app = createApp();

    it('answers tools/list', async () => {
        const res = await app.fetch(
            mcpPost(jsonRpc(4, 'tools/list', { _meta: modernMeta }), modernHeaders('tools/list')),
        );
        expect(res.status).toBe(200);
        const [message] = messagesIn(await res.text());
        expect(message.result.tools).toHaveLength(6);
    });

    it('streams progress and the result of a diagnostic call', async () => {
        const res = await app.fetch(
            mcpPost(
                jsonRpc(5, 'tools/call', {
                    name: 'diagnostic',
                    arguments: { seconds: 0 },
                    _meta: { ...modernMeta, progressToken: 'p1' },
                }),
                modernHeaders('tools/call', 'diagnostic'),
            ),
        );
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const messages = messagesIn(await res.text());
        expect(messages.at(-1).id).toBe(5);
        expect(messages.at(-1).result.content[0].text).toMatch(/Waited 0 seconds/);
    });
});

describe('SSE keep-alive', () => {
    it('sends keep-alive comment frames while a tool call is running', async () => {
        const app = createApp({ keepAliveMs: 50 });
        const res = await app.fetch(
            mcpPost(jsonRpc(6, 'tools/call', { name: 'diagnostic', arguments: { seconds: 1 } })),
        );
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const body = await res.text();
        expect((body.match(/^: keepalive$/gm) ?? []).length).toBeGreaterThanOrEqual(5);
        expect(messagesIn(body).at(-1).result.content[0].text).toMatch(/Waited 1 seconds/);
    });
});

describe('Lambda response streaming bridge', () => {
    it('streams an initialize response through the function URL handler', async () => {
        const { metadata, body } = await invokeLambda(functionUrlEvent(jsonRpc(1, 'initialize', initializeParams)));
        expect(metadata?.statusCode).toBe(200);
        expect(metadata?.headers['content-type']).toBe('text/event-stream');
        const [message] = messagesIn(body);
        expect(message.result.serverInfo.name).toBe('wbank-documents-reports-mcp');
    });

    it('streams a tools/list response through the function URL handler', async () => {
        const { metadata, body } = await invokeLambda(functionUrlEvent(jsonRpc(2, 'tools/list')));
        expect(metadata?.statusCode).toBe(200);
        expect(messagesIn(body)[0].result.tools).toHaveLength(6);
    });

    it('answers the sample event in mcp-server/events/', async () => {
        const event = JSON.parse(readFileSync(join(__dirname, '../../../../events/initialize.json'), 'utf8'));
        const { metadata, body } = await invokeLambda(event);
        expect(metadata?.statusCode).toBe(200);
        expect(messagesIn(body)[0].result.serverInfo.name).toBe('wbank-documents-reports-mcp');
    });

    it('answers 404 for other paths', async () => {
        const { metadata } = await invokeLambda(functionUrlEvent(undefined, 'GET', '/'));
        expect(metadata?.statusCode).toBe(404);
    });

    it('reports handler errors without the request body', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const app = createApp();
        const res = await app.fetch(
            mcpPost(jsonRpc(7, 'tools/list', { _meta: modernMeta }), {
                'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
            }),
        );
        expect(res.status).toBe(400);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('mcp handler error'));
    });
});
