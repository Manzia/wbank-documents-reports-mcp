import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool, notAvailableYet } from './types';

export const searchProjects = defineTool({
    name: 'search_projects',
    title: 'Search World Bank projects',
    description: 'Finds World Bank projects by keywords, country, region, status, sector, theme and dates.',
    inputSchema: z.object({
        query: z.string().optional(),
        countries: z.array(z.string()).optional(),
        region: z.string().optional(),
        status: z.string().optional(),
        sector: z.string().optional(),
        theme: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async () => notAvailableYet('search_projects'),
});
