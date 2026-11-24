import { UpstreamError } from './errors';
import type { DocumentRecord } from './normalise';
import { DOCUMENTS_HOST, type Upstream } from './transport';

// The record's text link, e.g. https://documents.worldbank.org/curated/en/<guid>/text/<file>.txt. Only its
// language, guid and file name are kept; the host and the /txt/ path are fixed (plan G23).
const TEXT_LINK =
    /^\/curated\/([a-z]{2})\/([A-Za-z0-9_]{6,40})\/(?:text|txt)\/([A-Za-z0-9][A-Za-z0-9._~()-]{0,200}\.txt)$/;
const TEXT_LINK_HOSTS = new Set(['documents.worldbank.org', DOCUMENTS_HOST]);

// Built only from a record the WDS API returned, never from a URL a caller gives (design §5.4: no arbitrary URLs).
export const documentTextUrl = (record: Pick<DocumentRecord, 'fields'>): URL | null => {
    const link = record.fields.txturl;
    if (typeof link !== 'string') return null;
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !TEXT_LINK_HOSTS.has(url.hostname)) return null;
    const match = TEXT_LINK.exec(url.pathname);
    if (!match || url.search || url.port) return null;
    const [, language, guid, file] = match;
    return new URL(`https://${DOCUMENTS_HOST}/curated/${language}/${guid}/txt/${file}`);
};

// The whole file: documents1 serves no parts (plan G23). The transport keeps it in memory while warm.
export const fetchDocumentText = async (upstream: Upstream, record: DocumentRecord): Promise<string> => {
    const url = documentTextUrl(record);
    if (!url) {
        const id = record.documentId ?? record.reportNumber;
        const which = id ? `document ${id}` : 'this document';
        throw new UpstreamError('unavailable', `No plain-text version is listed for ${which}.`);
    }
    return upstream.documents.getText(url, { refuseContentTypes: ['text/html'] });
};
