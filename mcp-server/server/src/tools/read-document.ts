import * as z from 'zod';
import { READ_ONLY_ANNOTATIONS, defineTool, notAvailableYet } from './types';

export const readDocument = defineTool({
    name: 'read_document',
    title: 'Read a World Bank document',
    description: 'Reads one public document in parts, given its document ID or report number.',
    inputSchema: z.object({
        document_id: z.string().optional(),
        report_number: z.string().optional(),
        question: z.string().optional(),
        pages: z.string().optional(),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async () => notAvailableYet('read_document'),
});
