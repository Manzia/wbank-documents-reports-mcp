import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import catalogSearch from '../../skills/catalog-search.md' with { type: 'text' };
import comparableOperations from '../../skills/comparable-operations.md' with { type: 'text' };
import completionLessons from '../../skills/completion-lessons.md' with { type: 'text' };
import countryEvidence from '../../skills/country-evidence.md' with { type: 'text' };
import documentComparison from '../../skills/document-comparison.md' with { type: 'text' };
import implementationTracking from '../../skills/implementation-tracking.md' with { type: 'text' };
import projectBriefing from '../../skills/project-briefing.md' with { type: 'text' };
import restructuring from '../../skills/restructuring.md' with { type: 'text' };
import { READ_ONLY_ANNOTATIONS, defineTool } from './types';

// Design §4.2, §5.5: SKILL.md-style files (front matter with name and description, then the instructions),
// bundled into the function as text by esbuild.
export interface Skill {
    name: string;
    description: string;
    instructions: string;
}

export const parseSkill = (source: string): Skill => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
    if (!match) throw new Error('A skill file starts with front matter between --- lines.');
    const fields = new Map<string, string>();
    for (const line of match[1].split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const name = fields.get('name');
    const description = fields.get('description');
    const instructions = match[2].trim();
    if (!name || !description || !instructions) {
        throw new Error('A skill file needs a name, a description and instructions.');
    }
    return { name, description, instructions };
};

export const SKILLS: readonly Skill[] = [
    projectBriefing,
    implementationTracking,
    documentComparison,
    restructuring,
    completionLessons,
    comparableOperations,
    catalogSearch,
    countryEvidence,
].map(parseSkill);

// "Project briefing", "project_briefing" and "project-briefing" name the same skill.
const keyOf = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

export const findSkill = (task: string): Skill | undefined => {
    const key = keyOf(task);
    return SKILLS.find((skill) => skill.name === key);
};

const PREFIX_NOTE =
    'Tool names are given without the prefix some clients add (for example, wb___search_documents is search_documents).';

const skillList = (): string =>
    [
        'Research skills for this server (unofficial; not affiliated with the World Bank). Call retrieve_skill with task set to a name below, then follow its steps.',
        SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n'),
        `Each skill names the tools to call, in order, with their filters, the document types involved, and the citation and coverage rules. ${PREFIX_NOTE}`,
    ].join('\n\n');

const text = (value: string, isError = false): CallToolResult => ({
    ...(isError ? { isError } : {}),
    content: [{ type: 'text', text: value }],
});

export const retrieveSkill = defineTool({
    name: 'retrieve_skill',
    title: 'Retrieve a research skill',
    description:
        'Returns a research skill: step-by-step instructions for a type of World Bank research task, naming the tools to call in order, their filters, the document types involved, and how to cite sources and state coverage. ' +
        'Call it first for any multi-step research request: project briefings, ISR tracking, PAD vs. agreement or ICR comparisons, restructurings, completion lessons, comparable operations, catalog searches, country evidence. ' +
        'Without task it lists the skills; with task it returns that skill.',
    inputSchema: z.object({
        task: z
            .string()
            .max(100)
            .optional()
            .describe(`The skill to return: ${SKILLS.map((skill) => skill.name).join(', ')}. Omit to list them.`),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async ({ task }) => {
        if (task === undefined || !keyOf(task)) return text(skillList());
        const skill = findSkill(task);
        if (!skill) return text(`No skill is named "${task}".\n\n${skillList()}`, true);
        return text(`Skill: ${skill.name}. ${skill.description}\n\n${skill.instructions}\n\n${PREFIX_NOTE}`);
    },
});
