export const MCP_URL = 'https://function-url.example/mcp';

export const LEGACY_PROTOCOL_VERSION = '2025-06-18';

export const jsonRpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id,
    method,
    params,
});

export const initializeParams = {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '1.0.0' },
};

export const mcpPost = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request(MCP_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
        },
        body: JSON.stringify(body),
    });

// Returns every JSON-RPC message in a response body, whether it is plain JSON or an SSE stream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const messagesIn = (body: string): any[] => {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [JSON.parse(trimmed)].flat();
    return trimmed
        .split(/\n\n+/)
        .map((event) =>
            event
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n'),
        )
        .filter((data) => data.length > 0)
        .map((data) => JSON.parse(data));
};
