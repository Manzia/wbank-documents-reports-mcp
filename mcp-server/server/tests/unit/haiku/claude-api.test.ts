import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import * as z from 'zod';
import { HAIKU_API_MODEL_ID, callHaiku, defaultAnthropic, forgetApiKey, haikuBackend } from '../../../src/haiku/client';
import { bedrock, haikuCalls, silenceWarnings, warnings } from './fake-bedrock';

// Unit tests never call the Claude API or Secrets Manager (plan D8): the SDK gets a fake fetch.
const tool = {
    name: 'pick',
    description: 'Pick words.',
    inputSchema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } } },
    output: z.object({ words: z.array(z.string()) }),
};
const request = { use: 'resolution' as const, system: 'System text.', prompt: 'secret user words', tool };
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:test/claude/access-AbCdEf';

const message = (content: unknown[], stopReason = 'tool_use') => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: HAIKU_API_MODEL_ID,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
});
const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', id: 'toolu_1', name, input });
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number) =>
    json({ type: 'error', error: { type: 'some_error', message: 'from the fake' } }, status);

interface Sent {
    url: string;
    apiKey: string | null;
    body: Record<string, unknown>;
}
let sent: Sent[];
const fakeFetch =
    (...answers: Array<Response | (() => Promise<Response>)>) =>
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push({
            url: String(url),
            apiKey: new Headers(init?.headers).get('authorization'),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
        return typeof answer === 'function' ? answer() : answer.clone();
    };
const client = (...answers: Parameters<typeof fakeFetch>) =>
    new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: fakeFetch(...answers) as never });
const throwing = (error: unknown) => ({ messages: { create: () => Promise.reject(error) } }) as unknown as Anthropic;
const api = { backend: 'claude-api' as const };

const secrets = mockClient(SecretsManagerClient);
let warn: ReturnType<typeof silenceWarnings>;
beforeEach(() => {
    sent = [];
    secrets.reset();
    bedrock.reset();
    forgetApiKey();
    warn = silenceWarnings();
});
afterEach(() => warn.mockRestore());

describe('haikuBackend', () => {
    it('is the Claude API only when HAIKU_BACKEND says so', () => {
        const saved = process.env.HAIKU_BACKEND;
        try {
            process.env.HAIKU_BACKEND = 'claude-api';
            expect(haikuBackend()).toBe('claude-api');
            process.env.HAIKU_BACKEND = 'something else';
            expect(haikuBackend()).toBe('bedrock');
            delete process.env.HAIKU_BACKEND;
            expect(haikuBackend()).toBe('bedrock');
        } finally {
            if (saved === undefined) delete process.env.HAIKU_BACKEND;
            else process.env.HAIKU_BACKEND = saved;
        }
    });
});

describe('callHaiku through the Claude API', () => {
    it('sends Haiku 5.5 a forced tool call with a 500-token cap and no sampling parameters', async () => {
        const anthropic = client(json(message([toolUse('pick', { words: ['a', 'b'] })])));
        expect(await callHaiku(request, { ...api, anthropic })).toEqual({ ok: true, value: { words: ['a', 'b'] } });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toMatch(/\/v1\/messages$/);
        expect(sent[0].body).toEqual({
            model: 'claude-haiku-5-5',
            max_tokens: 500,
            system: 'System text.',
            messages: [{ role: 'user', content: 'secret user words' }],
            tools: [{ name: 'pick', description: 'Pick words.', input_schema: tool.inputSchema }],
            tool_choice: { type: 'tool', name: 'pick' },
        });
        expect(haikuCalls()).toHaveLength(0);
        expect(warn).not.toHaveBeenCalled();
    });

    it('skips any thinking block and reads the tool call by type', async () => {
        const anthropic = client(
            json(message([{ type: 'thinking', thinking: '', signature: 's' }, toolUse('pick', { words: ['x'] })])),
        );
        expect(await callHaiku(request, { ...api, anthropic })).toEqual({ ok: true, value: { words: ['x'] } });
    });

    it('discards output outside the fixed structure', async () => {
        const answers = [
            message([toolUse('pick', { words: 'not a list' })]),
            message([toolUse('other_tool', { words: ['a'] })]),
            message([toolUse('pick', { words: ['a'] })], 'max_tokens'),
            message([{ type: 'text', text: 'no' }], 'refusal'),
        ];
        for (const answer of answers) {
            expect(await callHaiku(request, { ...api, anthropic: client(json(answer)) })).toEqual({
                ok: false,
                reason: 'invalid-output',
            });
        }
        expect(warnings(warn).map((w) => w.detail)).toEqual([
            'stopReason tool_use',
            'stopReason tool_use',
            'stopReason max_tokens',
            'stopReason refusal',
        ]);
    });

    it.each([
        [429, 'throttled'],
        [529, 'throttled'],
        [400, 'error'],
        [401, 'error'],
        [500, 'error'],
    ])('treats HTTP %i as %s', async (status, reason) => {
        expect(await callHaiku(request, { ...api, anthropic: client(apiError(status)) })).toEqual({
            ok: false,
            reason,
        });
        expect(warnings(warn)).toEqual([
            { message: 'haiku fallback', use: 'resolution', reason, detail: `claude-api ${status}` },
        ]);
    });

    it.each([
        ['a connection timeout', new Anthropic.APIConnectionTimeoutError(), 'timeout', 'claude-api timeout'],
        ['an aborted request', new Anthropic.APIUserAbortError(), 'timeout', 'claude-api timeout'],
        ['a connection error', new Anthropic.APIConnectionError({ message: 'down' }), 'error', 'claude-api connection'],
    ])('treats %s as %s', async (_, error, reason, detail) => {
        expect(await callHaiku(request, { ...api, anthropic: throwing(error) })).toEqual({ ok: false, reason });
        expect(warnings(warn)).toEqual([{ message: 'haiku fallback', use: 'resolution', reason, detail }]);
    });

    it('gives up after the timeout', async () => {
        const late = () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(message([]))), 200));
        expect(await callHaiku(request, { ...api, anthropic: client(late), timeoutMs: 10 })).toEqual({
            ok: false,
            reason: 'timeout',
        });
        expect(warnings(warn)[0]).toMatchObject({ reason: 'timeout' });
    });

    it('never logs the text it was given', async () => {
        await callHaiku(request, { ...api, anthropic: client(apiError(429)) });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret user words');
    });
});

describe('the API key', () => {
    const saved = process.env.CLAUDE_API_KEY_SECRET_ARN;
    let fetchSpy: ReturnType<typeof jest.spyOn>;
    beforeEach(() => {
        process.env.CLAUDE_API_KEY_SECRET_ARN = SECRET_ARN;
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(fakeFetch(json(message([toolUse('pick', { words: [] })]))) as never);
    });
    afterEach(() => {
        fetchSpy.mockRestore();
        if (saved === undefined) delete process.env.CLAUDE_API_KEY_SECRET_ARN;
        else process.env.CLAUDE_API_KEY_SECRET_ARN = saved;
    });
    const secretHolds = (value: unknown) =>
        secrets.on(GetSecretValueCommand, { SecretId: SECRET_ARN }).resolves({ SecretString: JSON.stringify(value) });

    it('is read once from the secret and sent as the bearer credential', async () => {
        secretHolds({ 'claude-api-key': 'key-from-secret' });
        await callHaiku(request, api);
        await callHaiku(request, api);
        expect(sent.map((s) => s.apiKey)).toEqual(['Bearer key-from-secret', 'Bearer key-from-secret']);
        expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('is read again after the API rejects it', async () => {
        secretHolds({ 'claude-api-key': 'old-key' });
        fetchSpy.mockImplementation(fakeFetch(apiError(401), json(message([toolUse('pick', { words: [] })]))) as never);
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        secretHolds({ 'claude-api-key': 'new-key' });
        expect(await callHaiku(request, api)).toEqual({ ok: true, value: { words: [] } });
        expect(sent.map((s) => s.apiKey)).toEqual(['Bearer old-key', 'Bearer new-key']);
    });

    it.each([
        ['has no claude-api-key field', { other: 'x' }],
        ['holds an empty key', { 'claude-api-key': '' }],
    ])('falls back when the secret %s, and reads it again next time', async (_, value) => {
        secretHolds(value);
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        secretHolds({ 'claude-api-key': 'k' });
        expect(await callHaiku(request, api)).toEqual({ ok: true, value: { words: [] } });
        expect(warnings(warn)).toEqual([
            { message: 'haiku fallback', use: 'resolution', reason: 'error', detail: 'HaikuSetupError' },
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('claude-api-key');
    });

    it('falls back when the secret is not JSON or cannot be read', async () => {
        secrets.on(GetSecretValueCommand).resolves({ SecretString: 'not json' });
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        secrets.on(GetSecretValueCommand).resolves({});
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        secrets
            .on(GetSecretValueCommand)
            .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        expect(warnings(warn).map((w) => w.detail)).toEqual([
            'HaikuSetupError',
            'HaikuSetupError',
            'AccessDeniedException',
        ]);
        expect(sent).toHaveLength(0);
    });

    it('falls back when CLAUDE_API_KEY_SECRET_ARN is not set', async () => {
        delete process.env.CLAUDE_API_KEY_SECRET_ARN;
        expect(await callHaiku(request, api)).toEqual({ ok: false, reason: 'error' });
        expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    });

    it('uses a given Secrets Manager client', async () => {
        secretHolds({ 'claude-api-key': 'k' });
        const anthropic = await defaultAnthropic(new SecretsManagerClient({ region: 'us-east-1' }));
        expect(anthropic.apiKey).toBe('k');
    });
});
