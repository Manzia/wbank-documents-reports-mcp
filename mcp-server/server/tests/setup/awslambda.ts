// Lambda's Node.js runtime provides the `awslambda` global that `streamHandle` uses. Tests stand in for it:
// `streamifyResponse` returns the handler as is, and `HttpResponseStream.from` records the response metadata.
import type { Writable } from 'node:stream';

export interface HttpResponseMetadata {
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
}

(globalThis as Record<string, unknown>).awslambda = {
    streamifyResponse: <T>(handler: T): T => handler,
    HttpResponseStream: {
        from: (stream: Writable & { metadata?: HttpResponseMetadata }, metadata: HttpResponseMetadata) => {
            stream.metadata = metadata;
            return stream;
        },
    },
};
