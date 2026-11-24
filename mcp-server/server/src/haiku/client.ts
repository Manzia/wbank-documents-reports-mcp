import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type * as z from 'zod';

// Design §7: every Haiku call goes through the US inference profile, with about 500 output tokens and a
// 5-second timeout, and asks for one fixed output structure (a forced tool call). Anything else is discarded.
export const HAIKU_MODEL_ID = 'us.anthropic.claude-haiku-5-5';
export const HAIKU_MAX_TOKENS = 500;
export const HAIKU_TIMEOUT_MS = 5_000;

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
    client?: BedrockRuntimeClient;
    timeoutMs?: number;
}

// The SDK retries throttling by default; a throttled call falls back at once instead (design §7).
let sharedClient: BedrockRuntimeClient | undefined;
const defaultClient = (): BedrockRuntimeClient =>
    (sharedClient ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 1 }));

const THROTTLING = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'TooManyRequestsException']);

class HaikuTimeout extends Error {
    override readonly name = 'HaikuTimeout';
}

const classify = (error: unknown): HaikuFailure => {
    const name = error instanceof Error ? error.name : '';
    if (error instanceof HaikuTimeout || name === 'AbortError' || name === 'TimeoutError') return 'timeout';
    if (THROTTLING.has(name)) return 'throttled';
    return 'error';
};

// Logs why a helper fell back, never the text it was given (design §11).
export const logFallback = (use: HaikuUse, reason: HaikuFailure, detail?: string): void =>
    console.warn(JSON.stringify({ message: 'haiku fallback', use, reason, ...(detail ? { detail } : {}) }));

const toolInput = (response: ConverseCommandOutput, name: string): unknown => {
    if (response.stopReason !== 'tool_use') return undefined;
    for (const block of response.output?.message?.content ?? []) {
        if (block.toolUse?.name === name) return block.toolUse.input;
    }
    return undefined;
};

export const callHaiku = async <T>(request: HaikuRequest<T>, options: HaikuOptions = {}): Promise<HaikuResult<T>> => {
    const client = options.client ?? defaultClient();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new HaikuTimeout('Haiku did not answer in time'));
        }, options.timeoutMs ?? HAIKU_TIMEOUT_MS);
    });
    const command = new ConverseCommand({
        modelId: HAIKU_MODEL_ID,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content: [{ text: request.prompt }] }],
        inferenceConfig: { maxTokens: HAIKU_MAX_TOKENS, temperature: 0 },
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
    let response: ConverseCommandOutput;
    try {
        response = await Promise.race([client.send(command, { abortSignal: controller.signal }), timeout]);
    } catch (error) {
        const reason = classify(error);
        logFallback(request.use, reason, error instanceof Error ? error.name : undefined);
        return { ok: false, reason };
    } finally {
        clearTimeout(timer);
    }
    const parsed = request.tool.output.safeParse(toolInput(response, request.tool.name));
    if (!parsed.success) {
        logFallback(request.use, 'invalid-output', `stopReason ${response.stopReason ?? 'none'}`);
        return { ok: false, reason: 'invalid-output' };
    }
    return { ok: true, value: parsed.data };
};
