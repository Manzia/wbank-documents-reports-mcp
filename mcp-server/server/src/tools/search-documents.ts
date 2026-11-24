import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool, notAvailableYet } from './types';

export const searchDocuments = defineTool({
    name: 'search_documents',
    title: 'Search World Bank documents',
    description: 'Finds Documents & Reports records by keywords, project, country, region, type and date.',
    inputSchema: z.object({
        query: z.string().optional(),
        project_id: z.string().optional(),
        countries: z.array(z.string()).optional(),
        region: z.string().optional(),
        document_types: z.array(z.string()).optional(),
        language: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async () => notAvailableYet('search_documents'),
});
