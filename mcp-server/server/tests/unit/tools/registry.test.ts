import { describe, expect, it } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { createApp } from '../../../src/handlers/mcp';
import { TOOLS } from '../../../src/tools/registry';
import { jsonRpc, mcpPost, messagesIn } from '../helpers';

const STUBS = ['search_documents', 'search_projects', 'get_project', 'read_document', 'retrieve_skill'];

describe('tool registry', () => {
    it('lists the five tools and diagnostic', () => {
        expect(TOOLS.map((tool) => tool.name)).toEqual([...STUBS, 'diagnostic']);
    });

    it('declares every tool read-only, non-destructive and open-world in tools/list', async () => {
        const res = await createApp().fetch(mcpPost(jsonRpc(1, 'tools/list')));
        const [message] = messagesIn(await res.text());
        expect(message.result.tools).toHaveLength(6);
        for (const tool of message.result.tools) {
            expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        }
    });

    it.each(STUBS)('%s is a stub returning a "not available yet" error', async (name) => {
        const tool = TOOLS.find((candidate) => candidate.name === name)!;
        const result = await tool.handler({}, {} as ServerContext);
        expect(result.isError).toBe(true);
        expect(result.content[0]).toEqual({
            type: 'text',
            text: expect.stringContaining(`${name} is not available yet`),
        });
    });
});
