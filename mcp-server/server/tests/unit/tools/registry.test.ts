import { describe, expect, it } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { createApp } from '../../../src/handlers/mcp';
import { SERVER_INFO, TOOLS } from '../../../src/tools/registry';
import { jsonRpc, mcpPost, messagesIn } from '../helpers';

const TOOL_NAMES = ['search_documents', 'search_projects', 'get_project', 'read_document', 'retrieve_skill'];

describe('tool registry', () => {
    it('lists the five tools and diagnostic', () => {
        expect(TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES, 'diagnostic']);
    });

    it('declares every tool read-only, non-destructive and open-world in tools/list', async () => {
        const res = await createApp().fetch(mcpPost(jsonRpc(1, 'tools/list')));
        const [message] = messagesIn(await res.text());
        expect(message.result.tools).toHaveLength(6);
        for (const tool of message.result.tools) {
            expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        }
    });

    it('has no stubs left', async () => {
        const result = await TOOLS.find((tool) => tool.name === 'retrieve_skill')!.handler({}, {} as ServerContext);
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).not.toMatch(/not available yet/);
    });

    // Design §4.2: short descriptions that fit every client's tool listing, each pointing to retrieve_skill.
    it.each(TOOLS.map((tool) => tool.name))('%s has a description of at most 1,024 characters', (name) => {
        expect(TOOLS.find((tool) => tool.name === name)!.description.length).toBeLessThanOrEqual(1024);
    });

    it.each(TOOL_NAMES.filter((name) => name !== 'retrieve_skill'))(
        '%s tells the model to call retrieve_skill first for multi-step research',
        (name) => {
            const tool = TOOLS.find((candidate) => candidate.name === name)!;
            expect(tool.description).toMatch(/multi-step research[^.]*, call retrieve_skill first\./);
        },
    );

    it('describes every parameter in tools/list', async () => {
        const res = await createApp().fetch(mcpPost(jsonRpc(1, 'tools/list')));
        const [message] = messagesIn(await res.text());
        const undescribed = message.result.tools.flatMap(
            (tool: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }) =>
                Object.entries(tool.inputSchema.properties)
                    .filter(([, property]) => !property.description)
                    .map(([key]) => `${tool.name}.${key}`),
        );
        expect(undescribed).toEqual([]);
    });

    it('says in its display name and description that it is unofficial and not affiliated', () => {
        expect(SERVER_INFO.title).toMatch(/unofficial/i);
        expect(SERVER_INFO.description).toMatch(/^Unofficial .*Not affiliated with the World Bank\.$/);
    });
});
