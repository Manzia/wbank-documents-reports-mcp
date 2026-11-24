import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type * as z from 'zod';

// Design §7: every Haiku call has about 500 output tokens and a 5-second timeout, and asks for one fixed
// output structure (a forced tool call). Anything else is discarded. No sampling parameters: Haiku 5.5
// rejects a non-default temperature.
export const HAIKU_MODEL_ID = 'us.anthropic.claude-haiku-5-5';
export const HAIKU_MAX_TOKENS = 500;
export const HAIKU_TIMEOUT_MS = 5_000;

// Temporary route while Bedrock refuses Claude 5.5 for this account (MCP-102 F1): with HAIKU_BACKEND set to
// `claude-api`, calls go to the Claude API with the key in the CLAUDE_API_KEY_SECRET_ARN secret. Unset, they
// use the Bedrock inference profile above, which stays the long-term route.
export const HAIKU_API_MODEL_ID = 'claude-haiku-5-5';
export const API_KEY_FIELD = 'claude-api-key';
export type HaikuBackend = 'bedrock' | 'claude-api';
export const haikuBackend = (): HaikuBackend => {
    const backend = process.env.HAIKU_BACKEND;
    return backend === 'claude-api' ? backend : 'bedrock';
};

export type HaikuUse = 'reformulation' | 'resolution';
export type HaikuFailure = 'timeout' | 'throttled' | 'error' | 'invalid-output';
export type HaikuResult<T> = { ok: true; value: T } | { ok: false; reason: HaikuFailure };

export interface HaikuTool<T> {
    name: string;
    description: string;
    // JSON Schema of the tool input, sent to the model.
    inputSchema: Record<string, unknown>;
    // Checks the tool input that comes back; a failure discards the output.
    output: z.ZodType<T>;
}

export interface HaikuRequest<T> {
    use: HaikuUse;
    system: string;
    prompt: string;
    tool: HaikuTool<T>;
}

export interface HaikuOptions {
    backend?: HaikuBackend;
    client?: BedrockRuntimeClient;
    anthropic?: Anthropic;
    timeoutMs?: number;
}

// The SDKs retry throttling by default; a throttled call falls back at once instead (design §7).
let sharedClient: BedrockRuntimeClient | undefined;
const defaultClient = (): BedrockRuntimeClient =>
    (sharedClient ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 1 }));

// The key is read once per instance and never logged. A failed read, or a key the API rejects, is read again
// on the next call, so a rotated key takes effect without a deploy.
let sharedAnthropic: Promise<Anthropic> | undefined;
const readApiKey = async (secrets: SecretsManagerClient): Promise<string> => {
    const secretId = process.env.CLAUDE_API_KEY_SECRET_ARN;
    if (!secretId) throw new HaikuSetupError('CLAUDE_API_KEY_SECRET_ARN is not set');
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    let key: unknown;
    try {
        key = (JSON.parse(secret.SecretString ?? '') as Record<string, unknown>)[API_KEY_FIELD];
    } catch {
        key = undefined;
    }
    if (typeof key !== 'string' || key === '') throw new HaikuSetupError(`secret has no ${API_KEY_FIELD}`);
    return key;
};
export const defaultAnthropic = (secrets?: SecretsManagerClient): Promise<Anthropic> =>
    (sharedAnthropic ??= readApiKey(
        secrets ?? new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    )
        .then((apiKey) => new Anthropic({ apiKey, maxRetries: 0, timeout: HAIKU_TIMEOUT_MS }))
        .catch((error: unknown) => {
            sharedAnthropic = undefined;
            throw error;
        }));
export const forgetApiKey = (): void => {
    sharedAnthropic = undefined;
};

const THROTTLING = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'TooManyRequestsException']);

class HaikuTimeout extends Error {
    override readonly name = 'HaikuTimeout';
}

class HaikuSetupError extends Error {
    override readonly name = 'HaikuSetupError';
}

// The detail is a fixed label, never an error message: the bundle is minified, and messages may quote input.
const classify = (error: unknown): { reason: HaikuFailure; detail?: string } => {
    if (error instanceof Anthropic.APIError) {
        if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
            return { reason: 'timeout', detail: 'claude-api timeout' };
        }
        if (error instanceof Anthropic.APIConnectionError) return { reason: 'error', detail: 'claude-api connection' };
        if (error instanceof Anthropic.AuthenticationError) forgetApiKey();
        const detail = `claude-api ${error.status ?? 'error'}`;
        if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.OverloadedError) {
            return { reason: 'throttled', detail };
        }
        return { reason: 'error', detail };
    }
    const name = error instanceof Error ? error.name : '';
    const detail = name || undefined;
    if (error instanceof HaikuTimeout || name === 'AbortError' || name === 'TimeoutError')
        return { reason: 'timeout', detail };
    if (THROTTLING.has(name)) return { reason: 'throttled', detail };
    return { reason: 'error', detail };
};

// Logs why a helper fell back, never the text it was given (design §11).
export const logFallback = (use: HaikuUse, reason: HaikuFailure, detail?: string): void =>
    console.warn(JSON.stringify({ message: 'haiku fallback', use, reason, ...(detail ? { detail } : {}) }));

interface Answer {
    stopReason: string | undefined;
    // The forced tool call's input, if the answer is one.
    input: unknown;
}

const viaBedrock = async <T>(request: HaikuRequest<T>, options: HaikuOptions, signal: AbortSignal): Promise<Answer> => {
    const client = options.client ?? defaultClient();
    const command = new ConverseCommand({
        modelId: HAIKU_MODEL_ID,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content: [{ text: request.prompt }] }],
        inferenceConfig: { maxTokens: HAIKU_MAX_TOKENS },
        toolConfig: {
            tools: [
                {
                    toolSpec: {
                        name: request.tool.name,
                        description: request.tool.description,
                        inputSchema: { json: request.tool.inputSchema as never },
                    },
                },
            ],
            toolChoice: { tool: { name: request.tool.name } },
        },
    });
    const response: ConverseCommandOutput = await client.send(command, { abortSignal: signal });
    const block =
        response.stopReason === 'tool_use'
            ? response.output?.message?.content?.find((b) => b.toolUse?.name === request.tool.name)
            : undefined;
    return { stopReason: response.stopReason, input: block?.toolUse?.input };
};

// Haiku 5.5 accepts a forced tool call; the answer then starts with the call, without thinking.
const viaClaudeApi = async <T>(
    request: HaikuRequest<T>,
    options: HaikuOptions,
    signal: AbortSignal,
): Promise<Answer> => {
    const client = options.anthropic ?? (await defaultAnthropic());
    const response = await client.messages.create(
        {
            model: HAIKU_API_MODEL_ID,
            max_tokens: HAIKU_MAX_TOKENS,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            tools: [
                {
                    name: request.tool.name,
                    description: request.tool.description,
                    input_schema: request.tool.inputSchema as Anthropic.Tool.InputSchema,
                },
            ],
            tool_choice: { type: 'tool', name: request.tool.name },
        },
        { signal },
    );
    const block =
        response.stop_reason === 'tool_use'
            ? response.content.find((b) => b.type === 'tool_use' && b.name === request.tool.name)
            : undefined;
    return {
        stopReason: response.stop_reason ?? undefined,
        input: block?.type === 'tool_use' ? block.input : undefined,
    };
};

export const callHaiku = async <T>(request: HaikuRequest<T>, options: HaikuOptions = {}): Promise<HaikuResult<T>> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new HaikuTimeout('Haiku did not answer in time'));
        }, options.timeoutMs ?? HAIKU_TIMEOUT_MS);
    });
    const send = (options.backend ?? haikuBackend()) === 'claude-api' ? viaClaudeApi : viaBedrock;
    let answer: Answer;
    try {
        answer = await Promise.race([send(request, options, controller.signal), timeout]);
    } catch (error) {
        const { reason, detail } = classify(error);
        logFallback(request.use, reason, detail);
        return { ok: false, reason };
    } finally {
        clearTimeout(timer);
    }
    const parsed = request.tool.output.safeParse(answer.input);
    if (!parsed.success) {
        logFallback(request.use, 'invalid-output', `stopReason ${answer.stopReason ?? 'none'}`);
        return { ok: false, reason: 'invalid-output' };
    }
    return { ok: true, value: parsed.data };
};
