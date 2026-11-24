// Every upstream failure becomes an UpstreamError whose message is plain enough to show the client as is.
// The upstream response body is never part of the message: the World Bank APIs return stack traces and
// internal hostnames in their error bodies.
export type UpstreamErrorKind =
    | 'refused-host'
    | 'refused-parameter'
    | 'timeout'
    | 'network'
    | 'http'
    | 'invalid-response'
    | 'too-large'
    | 'unavailable';

export class UpstreamError extends Error {
    readonly kind: UpstreamErrorKind;
    readonly status?: number;

    constructor(kind: UpstreamErrorKind, message: string, status?: number) {
        super(message);
        this.name = 'UpstreamError';
        this.kind = kind;
        this.status = status;
    }
}

export const isUpstreamError = (error: unknown): error is UpstreamError => error instanceof UpstreamError;
