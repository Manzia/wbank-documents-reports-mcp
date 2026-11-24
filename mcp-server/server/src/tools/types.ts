import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import type * as z from 'zod';

// Design §4.3: every tool is read-only, non-destructive and reaches the open web (the World Bank APIs).
export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
} as const;

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
    name: string;
    title: string;
    description: string;
    inputSchema: S;
    annotations: typeof READ_ONLY_ANNOTATIONS;
    handler: (args: z.infer<S>, ctx: ServerContext) => Promise<CallToolResult>;
}

export const defineTool = <S extends z.ZodObject>(definition: ToolDefinition<S>): ToolDefinition<S> => definition;

export const notAvailableYet = (name: string): CallToolResult => ({
    isError: true,
    content: [
        {
            type: 'text',
            text: `${name} is not available yet: this server is still being built. No request was sent to the World Bank.`,
        },
    ],
});
