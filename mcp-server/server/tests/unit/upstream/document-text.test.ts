import { beforeAll, describe, expect, it } from '@jest/globals';
import { documentTextUrl, fetchDocumentText } from '../../../src/upstream/document-text';
import { normaliseDocument, parseWdsResponse } from '../../../src/upstream/normalise';
import { blockNetwork, fixture, testUpstream } from './fake-fetch';

const record = () => parseWdsResponse(JSON.parse(fixture('wds-id-40139216.json'))).records[0];
const withLink = (txturl: unknown) => normaliseDocument({ id: '1', txturl });

beforeAll(blockNetwork);

describe('documentTextUrl', () => {
    it('rewrites the record text link to documents1 and the /txt/ path', () => {
        expect(documentTextUrl(record())?.href).toBe(
            'https://documents1.worldbank.org/curated/en/099111526065514117/txt/P513349-6123ea31-810b-4cc3-ba5e-024666b50e0c.txt',
        );
    });

    it('keeps a link already on documents1 /txt/', () => {
        expect(
            documentTextUrl(
                withLink('http://documents1.worldbank.org/curated/fr/916531468270300869/txt/multi0page.txt'),
            )?.href,
        ).toBe('https://documents1.worldbank.org/curated/fr/916531468270300869/txt/multi0page.txt');
    });

    it.each([
        ['no link', undefined],
        ['not text', 42],
        ['not a URL', 'curated/en/1/text/a.txt'],
        ['another host', 'https://example.com/curated/en/099111526065514117/text/a.txt'],
        ['another scheme', 'file://documents.worldbank.org/curated/en/099111526065514117/text/a.txt'],
        ['another path', 'https://documents.worldbank.org/other/en/099111526065514117/text/a.txt'],
        ['a PDF', 'https://documents.worldbank.org/curated/en/099111526065514117/pdf/a.pdf'],
        ['a nested path', 'https://documents.worldbank.org/curated/en/099111526065514117/text/x/a.txt'],
        ['a query string', 'https://documents.worldbank.org/curated/en/099111526065514117/text/a.txt?x=1'],
        ['a port', 'https://documents.worldbank.org:444/curated/en/099111526065514117/text/a.txt'],
    ])('returns null for %s', (_, link) => {
        expect(documentTextUrl(withLink(link))).toBeNull();
    });
});

describe('fetchDocumentText', () => {
    it('fetches the whole file from documents1', async () => {
        const text = fixture('document-P513349.txt');
        const { upstream, fetch } = testUpstream(() => ({
            body: text,
            headers: { 'content-type': 'text/plain;charset=utf-8' },
        }));
        expect(await fetchDocumentText(upstream, record())).toBe(text);
        expect(new URL(String(fetch.mock.calls[0][0])).host).toBe('documents1.worldbank.org');
    });

    it('says plainly when a record has no text link', async () => {
        const { upstream, fetch } = testUpstream(() => ({ body: '' }));
        await expect(fetchDocumentText(upstream, withLink(undefined))).rejects.toMatchObject({
            kind: 'unavailable',
            message: 'No plain-text version is listed for document 1.',
        });
        await expect(fetchDocumentText(upstream, normaliseDocument({}))).rejects.toMatchObject({
            message: 'No plain-text version is listed for this document.',
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a web page in place of the text', async () => {
        const { upstream } = testUpstream(() => ({
            body: '<html>challenge</html>',
            headers: { 'content-type': 'text/html' },
        }));
        await expect(fetchDocumentText(upstream, record())).rejects.toMatchObject({ kind: 'invalid-response' });
    });
});
