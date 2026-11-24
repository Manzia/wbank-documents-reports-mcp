import { describe, expect, it } from '@jest/globals';
import { UpstreamError } from '../../../src/upstream/errors';
import {
    normaliseDate,
    normaliseDocument,
    normaliseFacets,
    normaliseProject,
    parseProjectsResponse,
    parseWdsResponse,
} from '../../../src/upstream/normalise';
import { fixture } from './fake-fetch';

const load = (name: string): unknown => JSON.parse(fixture(name));

describe('WDS records', () => {
    it('become the provenance shape and keep every returned field', () => {
        const parsed = parseWdsResponse(load('wds-proid-P117635.json'));
        expect(parsed.total).toBe(129);
        expect(parsed.records).toHaveLength(2);
        const [first, second] = parsed.records;
        expect(first).toEqual({
            source: 'wds',
            documentId: '40103324',
            projectId: 'P117635',
            reportNumber: 'ICRR0024889',
            title: 'Kenya - KE Enhancing Wat Security   Climate Res',
            documentDate: '2026-05-15',
            disclosureDate: '2026-05-15',
            documentType: 'Implementation Completion Report Review',
            recordUrl: 'https://documents.worldbank.org/curated/en/099051526122584470',
            fileUrl:
                'https://documents.worldbank.org/curated/en/099051526122584470/pdf/P117635-9bf7728d-7c1c-44c3-ba0a-c460082a1291.pdf',
            fields: expect.objectContaining({
                count: 'Kenya',
                majdocty: 'Project Documents',
                EnvironmentalCategory: 'A',
            }),
        });
        expect(Object.keys(first.fields)).toHaveLength(35);
        expect(second.documentType).toBe('Auditing Document');
        expect(parsed.facets).toEqual({});
    });

    it('keep the API order of records', () => {
        const ids = parseWdsResponse(load('wds-proid-P117635.json')).records.map((r) => r.documentId);
        expect(ids).toEqual(['40103324', '40084009']);
    });

    it('fall back for a missing title and leave out unusable links', () => {
        expect(normaliseDocument({ id: 7, docna: { 0: { docna: 'From docna' } }, url: 'ftp://x' })).toMatchObject({
            documentId: '7',
            title: 'From docna',
            recordUrl: null,
            fileUrl: null,
            documentType: null,
        });
        expect(normaliseDocument({ id: '8', repnb: 'ICR123', url: 'not a url' }).title).toBe('ICR123');
        expect(normaliseDocument({ id: '9', display_title: '  ' }).title).toBe('Document 9');
    });
});

describe('Projects records', () => {
    it('become the same provenance shape, with approval and closing dates', () => {
        const parsed = parseProjectsResponse(load('projects-id-P117635.json'));
        expect(parsed.total).toBe(1);
        expect(parsed.records[0]).toEqual({
            source: 'projects',
            documentId: null,
            projectId: 'P117635',
            reportNumber: null,
            title: 'Kenya Water Security and Climate Resilience Project',
            documentDate: null,
            disclosureDate: null,
            documentType: null,
            recordUrl: 'https://projects.worldbank.org/en/projects-operations/project-detail/P117635',
            fileUrl: null,
            approvalDate: '2013-06-18',
            closingDate: '2025-05-31',
            fields: expect.objectContaining({ totalcommamt: '174,940,000', curr_project_cost: '146060000' }),
        });
        expect(normaliseProject({ projectid: 'P1' }).title).toBe('Project P1');
    });
});

describe('facets', () => {
    it('are read from both APIs, with string counts as numbers', () => {
        const wds = parseWdsResponse(load('wds-facet-admreg.json'));
        expect(wds.total).toBe(623825);
        expect(wds.records).toHaveLength(1);
        expect(wds.facets.admreg_exact).toHaveLength(10);
        expect(wds.facets.admreg_exact[0]).toEqual({ name: 'Eastern and Southern Africa', count: 92842 });
        const projects = parseProjectsResponse(load('projects-facet-status.json'));
        expect(projects.records).toEqual([]);
        expect(projects.facets.status_exact).toEqual([
            { name: 'Closed', count: 14602 },
            { name: 'Active', count: 2666 },
            { name: 'Dropped', count: 1909 },
            { name: 'Pipeline', count: 700 },
        ]);
        expect(parseProjectsResponse(load('projects-facet-regionname.json')).facets.regionname_exact).toHaveLength(9);
    });

    it('skip unnamed values and malformed entries', () => {
        expect(
            normaliseFacets({ a: { 0: { name: '', count: 3 }, 1: { name: 'x', count: 'n/a' }, 2: 'junk' }, b: 5 }),
        ).toEqual({
            a: [{ name: 'x', count: 0 }],
        });
        expect(normaliseFacets(null)).toEqual({});
    });
});

describe('dates', () => {
    it.each([
        ['2026-05-15T04:00:00Z', '2026-05-15'],
        ['5/31/2025 12:00:00 AM', '2025-05-31'],
        ['12/1/2030', '2030-12-01'],
        [['2013-06-18T00:00:00Z'], '2013-06-18'],
        ['0001-01-01T00:00:00Z', null],
        ['1900-01-01T05:00:00Z', null],
        ['', null],
        [undefined, null],
        ['soon', null],
    ])('%p → %p', (input, output) => {
        expect(normaliseDate(input)).toBe(output);
    });
});

describe('unreadable responses', () => {
    it.each([null, [], { total: 1 }, { documents: 'x' }])('are refused: %p', (body) => {
        expect(() => parseWdsResponse(body)).toThrow(UpstreamError);
        expect(() => parseProjectsResponse(body)).toThrow(UpstreamError);
    });
});
