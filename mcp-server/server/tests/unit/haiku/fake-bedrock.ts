import { jest } from '@jest/globals';
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';

// Unit tests never call Bedrock (plan D8): the client is mocked, and answers are forced tool calls.
export const bedrock = mockClient(BedrockRuntimeClient);

export const toolAnswer = (name: string, input: unknown, stopReason = 'tool_use'): ConverseCommandOutput =>
    ({
        stopReason,
        output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name, input } }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
        $metadata: {},
    }) as ConverseCommandOutput;

export const awsError = (name: string): Error => Object.assign(new Error(`${name} from the mock`), { name });

export const slowAnswer = (answer: ConverseCommandOutput, ms: number) => () =>
    new Promise<ConverseCommandOutput>((resolve) => setTimeout(() => resolve(answer), ms));

export const haikuCalls = () => bedrock.commandCalls(ConverseCommand);

export const lastPrompt = (): string => {
    const calls = haikuCalls();
    return calls[calls.length - 1].args[0].input.messages?.[0].content?.[0].text ?? '';
};

export const silenceWarnings = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

export const warnings = (spy: ReturnType<typeof silenceWarnings>): Record<string, unknown>[] =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
