import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool, notAvailableYet } from './types';

export const getProject = defineTool({
    name: 'get_project',
    title: 'Get a World Bank project profile',
    description: 'Returns the profile of one World Bank project, given its project ID (e.g. P117635).',
    inputSchema: z.object({
        project_id: z.string(),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async () => notAvailableYet('get_project'),
});
