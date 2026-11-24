import { UpstreamError } from './errors';
import { DATE_FLOOR } from './params';

// The provenance every result item carries (design §5, "Rules common to all tools"). `fields` keeps every field
// the API returned, unchanged, for the tools that need more.
export interface ProvenanceRecord {
    source: 'wds' | 'projects';
    documentId: string | null;
    projectId: string | null;
    reportNumber: string | null;
    title: string;
    documentDate: string | null;
    disclosureDate: string | null;
    documentType: string | null;
    recordUrl: string | null;
    fileUrl: string | null;
    fields: Readonly<Record<string, unknown>>;
}

export interface DocumentRecord extends ProvenanceRecord {
    source: 'wds';
}

export interface ProjectRecord extends ProvenanceRecord {
    source: 'projects';
    approvalDate: string | null;
    closingDate: string | null;
}

export interface FacetValue {
    name: string;
    count: number;
}

export type Facets = Record<string, FacetValue[]>;

export interface ParsedResponse<R> {
    total: number;
    records: R[];
    facets: Facets;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

// The APIs nest repeated values as {"0": {...}, "1": {...}} or as arrays; this returns the first one.
const first = (value: unknown, key?: string): unknown => {
    const items = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [value];
    const item = items[0];
    return key && isObject(item) ? item[key] : item;
};

// Returns YYYY-MM-DD for the APIs' date formats ("2026-05-15T04:00:00Z", "5/31/2025 12:00:00 AM"), or null for
// a missing or placeholder date (year 1, 1900-01-01: MCP-102 F5).
export const normaliseDate = (value: unknown): string | null => {
    const raw = str(first(value));
    if (!raw) return null;
    let date: string | null = null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
    if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    else if (us) date = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
    return date && date >= DATE_FLOOR ? date : null;
};

const https = (value: unknown): string | null => {
    const raw = str(value);
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        url.protocol = 'https:';
        return url.href;
    } catch {
        return null;
    }
};

const count = (value: unknown): number => {
    const n = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
    return Number.isFinite(n) ? n : 0;
};

export const normaliseDocument = (raw: Raw): DocumentRecord => {
    const documentId = str(raw.id);
    const reportNumber = str(raw.repnb);
    return {
        source: 'wds',
        documentId,
        projectId: str(raw.projectid) ?? str(first(raw.proid)),
        reportNumber,
        title: str(raw.display_title) ?? str(first(raw.docna, 'docna')) ?? reportNumber ?? `Document ${documentId}`,
        documentDate: normaliseDate(raw.docdt),
        disclosureDate: normaliseDate(raw.disclosure_date),
        documentType: str(raw.docty),
        recordUrl: https(raw.url),
        fileUrl: https(raw.pdfurl),
        fields: raw,
    };
};

export const normaliseProject = (raw: Raw): ProjectRecord => {
    const projectId = str(raw.id) ?? str(raw.projectid);
    return {
        source: 'projects',
        documentId: null,
        projectId,
        reportNumber: null,
        title: str(raw.project_name) ?? `Project ${projectId}`,
        documentDate: null,
        disclosureDate: null,
        documentType: null,
        recordUrl: https(raw.url),
        fileUrl: null,
        approvalDate: normaliseDate(raw.boardapprovaldate),
        closingDate: normaliseDate(raw.closingdate),
        fields: raw,
    };
};

export const normaliseFacets = (raw: unknown): Facets => {
    const facets: Facets = {};
    if (!isObject(raw)) return facets;
    for (const [field, values] of Object.entries(raw)) {
        if (!isObject(values) && !Array.isArray(values)) continue;
        facets[field] = Object.values(values)
            .filter(isObject)
            .map((value) => ({ name: str(value.name) ?? '', count: count(value.count) }))
            .filter((value) => value.name.length > 0);
    }
    return facets;
};

const unreadable = (): never => {
    throw new UpstreamError(
        'invalid-response',
        'The World Bank search API returned a response that could not be read.',
    );
};

// WDS: {"total": n, "documents": {"D<id>": {...}, "facets": {...}}}
export const parseWdsResponse = (body: unknown): ParsedResponse<DocumentRecord> => {
    if (!isObject(body) || !isObject(body.documents)) return unreadable();
    const { facets, ...documents } = body.documents;
    return {
        total: count(body.total),
        records: Object.values(documents).filter(isObject).map(normaliseDocument),
        facets: normaliseFacets(facets),
    };
};

// Projects: {"total": "n", "projects": {"P<id>": {...}}, "facets": {...}}
export const parseProjectsResponse = (body: unknown): ParsedResponse<ProjectRecord> => {
    if (!isObject(body) || !isObject(body.projects)) return unreadable();
    return {
        total: count(body.total),
        records: Object.values(body.projects).filter(isObject).map(normaliseProject),
        facets: normaliseFacets(body.facets),
    };
};
