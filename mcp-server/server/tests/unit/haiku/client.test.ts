import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import * as z from 'zod';
import { HAIKU_MAX_TOKENS, HAIKU_MODEL_ID, HAIKU_TIMEOUT_MS, callHaiku } from '../../../src/haiku/client';
import { awsError, bedrock, haikuCalls, silenceWarnings, slowAnswer, toolAnswer, warnings } from './fake-bedrock';

const tool = {
    name: 'pick',
    description: 'Pick words.',
    inputSchema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } } },
    output: z.object({ words: z.array(z.string()) }),
};
const request = { use: 'reformulation' as const, system: 'System text.', prompt: 'secret user words', tool };

let warn: ReturnType<typeof silenceWarnings>;
beforeEach(() => {
    bedrock.reset();
    warn = silenceWarnings();
});
afterEach(() => warn.mockRestore());

describe('callHaiku', () => {
    it('uses the Haiku 5.5 inference profile, a 500-token cap and a forced tool call', async () => {
        bedrock.on(ConverseCommand).resolves(toolAnswer('pick', { words: ['a', 'b'] }));
        const result = await callHaiku(request);
        expect(result).toEqual({ ok: true, value: { words: ['a', 'b'] } });
        expect(HAIKU_MODEL_ID).toBe('us.anthropic.claude-haiku-5-5');
        expect(HAIKU_MAX_TOKENS).toBe(500);
        expect(HAIKU_TIMEOUT_MS).toBe(5000);
        const input = haikuCalls()[0].args[0].input;
        expect(input.modelId).toBe('us.anthropic.claude-haiku-5-5');
        expect(input.inferenceConfig?.maxTokens).toBe(500);
        expect(input.system).toEqual([{ text: 'System text.' }]);
        expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: 'pick' } });
        expect(input.toolConfig?.tools?.[0].toolSpec?.name).toBe('pick');
        expect(warn).not.toHaveBeenCalled();
    });

    it('uses a given client', async () => {
        bedrock.on(ConverseCommand).resolves(toolAnswer('pick', { words: [] }));
        const client = new BedrockRuntimeClient({ region: 'us-east-1' });
        expect(await callHaiku(request, { client })).toEqual({ ok: true, value: { words: [] } });
    });

    it('discards output outside the fixed structure', async () => {
        bedrock.on(ConverseCommand).resolves(toolAnswer('pick', { words: 'not a list' }));
        expect(await callHaiku(request)).toEqual({ ok: false, reason: 'invalid-output' });
        bedrock.on(ConverseCommand).resolves(toolAnswer('other_tool', { words: ['a'] }));
        expect(await callHaiku(request)).toEqual({ ok: false, reason: 'invalid-output' });
        bedrock.on(ConverseCommand).resolves(toolAnswer('pick', { words: ['a'] }, 'max_tokens'));
        expect(await callHaiku(request)).toEqual({ ok: false, reason: 'invalid-output' });
        bedrock.on(ConverseCommand).resolves({ stopReason: 'tool_use', $metadata: {} } as never);
        expect(await callHaiku(request)).toEqual({ ok: false, reason: 'invalid-output' });
        expect(warnings(warn).map((w) => w.reason)).toEqual(Array(4).fill('invalid-output'));
    });

    it('gives up after the timeout', async () => {
        bedrock.on(ConverseCommand).callsFake(slowAnswer(toolAnswer('pick', { words: ['late'] }), 200));
        expect(await callHaiku(request, { timeoutMs: 10 })).toEqual({ ok: false, reason: 'timeout' });
        expect(warnings(warn)).toEqual([
            { message: 'haiku fallback', use: 'reformulation', reason: 'timeout', detail: 'HaikuTimeout' },
        ]);
    });

    it.each([
        ['ThrottlingException', 'throttled'],
        ['ServiceQuotaExceededException', 'throttled'],
        ['AbortError', 'timeout'],
        ['TimeoutError', 'timeout'],
        ['AccessDeniedException', 'error'],
        ['ValidationException', 'error'],
    ])('treats %s as %s', async (name, reason) => {
        bedrock.on(ConverseCommand).rejects(awsError(name));
        expect(await callHaiku(request)).toEqual({ ok: false, reason });
        expect(warnings(warn)).toEqual([{ message: 'haiku fallback', use: 'reformulation', reason, detail: name }]);
    });

    it('treats a thrown non-error as an error', async () => {
        bedrock.on(ConverseCommand).callsFake(() => Promise.reject('boom'));
        expect(await callHaiku(request)).toEqual({ ok: false, reason: 'error' });
        expect(warnings(warn)).toEqual([{ message: 'haiku fallback', use: 'reformulation', reason: 'error' }]);
    });

    it('never logs the text it was given', async () => {
        bedrock.on(ConverseCommand).rejects(awsError('ThrottlingException'));
        await callHaiku(request);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret user words');
    });
});
