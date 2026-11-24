import { jest } from '@jest/globals';
import { ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vocabulary } from '../../../src/vocabulary/format';
import { bedrock, toolAnswer } from '../haiku/fake-bedrock';
import { json, testUpstream, type Reply } from '../upstream/fake-fetch';
import { sampleVocabulary } from '../vocabulary/sample-vocabulary';

// Recorded from search.worldbank.org on 2026-11-24 and trimmed (fewer records, abstracts cut to about 400
// characters). projects-latam-urban-transport-closed.json keeps 30 of its 110 records, and its total says 30.
export const recorded = (name: string): string => readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8');

// The sample vocabulary plus the values these tests use, as the APIs list them.
export const testVocabulary = (): Vocabulary => {
    const vocabulary = sampleVocabulary();
    const add = (list: { values: { value: string; count: number }[] }, values: string[]) =>
        list.values.push(...values.map((value) => ({ value, count: 10 })));
    add(vocabulary.lists.wds.countries, ['Philippines', 'Morocco', 'Tunisia', 'India']);
    add(vocabulary.lists.wds.documentTypes, ['Project Completion Report', 'Policy Research Working Paper']);
    add(vocabulary.lists.projects.countries, ['Bangladesh', 'Peru', 'Bolivia', 'Ecuador', 'Colombia']);
    add(vocabulary.lists.projects.regions, ['South Asia', 'Latin America and Caribbean']);
    add(vocabulary.lists.projects.sectors, ['Crops']);
    return vocabulary;
};

export interface HaikuScript {
    // Keyword variants for every reformulation.
    variants?: string[];
    // Values chosen for a term, by the term as sent.
    choose?: Record<string, string[]>;
}

const termOf = (input: ConverseCommandInput): string =>
    /<term>([\s\S]*?)<\/term>/.exec(input.messages?.[0].content?.[0].text ?? '')?.[1] ?? '';

// Answers each Haiku call as its forced tool would; unscripted calls are throttled, so the helpers fall back.
export const scriptHaiku = (script: HaikuScript): void => {
    bedrock.on(ConverseCommand).callsFake(async (input: ConverseCommandInput) => {
        const tool = input.toolConfig?.tools?.[0]?.toolSpec?.name;
        if (tool === 'keyword_variants' && script.variants) {
            return toolAnswer(tool, { variants: script.variants });
        }
        const chosen = script.choose?.[termOf(input)];
        if (tool === 'choose_values' && chosen) return toolAnswer(tool, { values: chosen });
        throw Object.assign(new Error('throttled by the mock'), { name: 'ThrottlingException' });
    });
};

export type Params = Record<string, string>;

export interface Recorder {
    requests: Params[];
    unmatched: string[];
}

// Routes each request to a recorded response by its parameters; the first matching route answers.
export const routed = (routes: [(p: Params) => boolean, string | ((p: Params) => Reply)][]) => {
    const recorder: Recorder = { requests: [], unmatched: [] };
    const { upstream, fetch } = testUpstream((url) => {
        const params = Object.fromEntries(url.searchParams);
        recorder.requests.push(params);
        const route = routes.find(([match]) => match(params));
        if (!route) {
            recorder.unmatched.push(url.search);
            return json({ total: 0, documents: {}, projects: {} });
        }
        return typeof route[1] === 'string' ? { body: recorded(route[1]) } : route[1](params);
    });
    return { upstream, fetch, recorder };
};

export const text = (result: CallToolResult): string => {
    const [first] = result.content;
    return first.type === 'text' ? first.text : '';
};

export const progressContext = () => {
    const notify = jest.fn(async (notification: unknown) => {
        void notification;
    });
    const ctx = { mcpReq: { _meta: { progressToken: 'p1' }, notify } } as unknown as ServerContext;
    return { ctx, notify };
};

// The numbered record lines of a result, e.g. "1. Title".
export const listed = (output: string): string[] =>
    output
        .split('\n')
        .filter((line) => /^\d+\. /.test(line))
        .map((line) => line.replace(/^\d+\. /, ''));
