import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool, notAvailableYet } from './types';

export const retrieveSkill = defineTool({
    name: 'retrieve_skill',
    title: 'Retrieve a research skill',
    description: 'Returns step-by-step instructions for a type of World Bank research task.',
    inputSchema: z.object({
        task: z.string().optional(),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async () => notAvailableYet('retrieve_skill'),
});
