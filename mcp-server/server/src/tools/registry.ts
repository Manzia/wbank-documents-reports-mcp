import { McpServer } from '@modelcontextprotocol/server';
import { diagnostic } from './diagnostic';
import { getProject } from './get-project';
import { readDocument } from './read-document';
import { retrieveSkill } from './retrieve-skill';
import { searchDocuments } from './search-documents';
import { searchProjects } from './search-projects';
import type { ToolDefinition } from './types';

export const SERVER_INFO = {
    name: 'wbank-documents-reports-mcp',
    title: 'World Bank Documents & Reports (unofficial)',
    version: '0.1.0',
    description:
        'Unofficial MCP server for the World Bank Documents & Reports and Projects APIs. Not affiliated with the World Bank.',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [
    searchDocuments,
    searchProjects,
    getProject,
    readDocument,
    retrieveSkill,
    diagnostic,
];

export const createServer = (): McpServer => {
    const server = new McpServer(SERVER_INFO);
    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
            },
            tool.handler,
        );
    }
    return server;
};
