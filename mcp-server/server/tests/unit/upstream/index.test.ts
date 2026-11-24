import { describe, expect, it } from '@jest/globals';
import * as upstream from '../../../src/upstream';

describe('upstream module', () => {
    it('exports the transport, query building, normalising and document text functions', () => {
        for (const name of [
            'openUpstream',
            'collectPages',
            'buildQuery',
            'searchWds',
            'searchProjects',
            'parseWdsResponse',
            'parseProjectsResponse',
            'normaliseDate',
            'documentTextUrl',
            'fetchDocumentText',
            'isUpstreamError',
        ] as const) {
            expect(typeof upstream[name]).toBe('function');
        }
        expect(upstream.isUpstreamError(new upstream.UpstreamError('timeout', 'x'))).toBe(true);
        expect(upstream.isUpstreamError(new Error('x'))).toBe(false);
    });
});
