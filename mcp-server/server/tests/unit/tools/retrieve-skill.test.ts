import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import { TOOLS as TOOL_DEFINITIONS } from '../../../src/tools/registry';
import { SKILLS, findSkill, parseSkill, retrieveSkill } from '../../../src/tools/retrieve-skill';

const SKILL_DIR = join(__dirname, '../../../skills');
const NAMES = [
    'project-briefing',
    'implementation-tracking',
    'document-comparison',
    'restructuring',
    'completion-lessons',
    'comparable-operations',
    'catalog-search',
    'country-evidence',
];
const TOOLS = ['search_documents', 'search_projects', 'get_project', 'read_document'];
// Design §9 table: the client's model needs these names to pick documents.
const DOCUMENT_TYPES = [
    'Project Appraisal Document',
    'Implementation Status and Results Report',
    'Implementation Completion and Results Report',
    'Environmental and Social Commitment Plan',
    'Financing Agreement',
    'Project Paper',
    'Program Document',
    'Program Appraisal Document',
    'Procurement Plan',
];

const call = async (task?: string) => {
    const result = await retrieveSkill.handler(task === undefined ? {} : { task }, {} as ServerContext);
    return { result, text: (result.content[0] as { text: string }).text };
};

describe('skills', () => {
    it('has the eight skills of design §5.5, one file each, named as their files', () => {
        expect(SKILLS.map((skill) => skill.name)).toEqual(NAMES);
        const files = readdirSync(SKILL_DIR).filter((file) => file.endsWith('.md'));
        expect(files.sort()).toEqual(NAMES.map((name) => `${name}.md`).sort());
    });

    it.each(NAMES)('%s is a SKILL.md-style file with a one-line description', (name) => {
        const skill = parseSkill(readFileSync(join(SKILL_DIR, `${name}.md`), 'utf8'));
        expect(skill.name).toBe(name);
        expect(skill.description).not.toMatch(/\n/);
        expect(skill.description.length).toBeLessThanOrEqual(300);
        expect(skill.instructions).toMatch(/^# /);
    });

    it.each(NAMES)('%s names the tools, the steps, the document types and the citation and coverage rules', (name) => {
        const body = findSkill(name)!.instructions;
        const section = (heading: string) => {
            const start = body.indexOf(`\n## ${heading}`);
            expect(start).toBeGreaterThan(0);
            const text = body.slice(body.indexOf('\n', start + 1) + 1);
            return text.slice(0, text.indexOf('\n## ') + 1 || undefined).trim();
        };
        const steps = section('Steps');
        expect(steps).toMatch(/^1\. /);
        expect(steps).toContain('`search_documents`');
        expect(TOOLS.filter((tool) => steps.includes(`\`${tool}\``)).length).toBeGreaterThanOrEqual(2);
        expect(section('Document types')).toMatch(/Report|Document|Paper|Plan|Agreement|Framework/);
        const rules = section('Citation and coverage rules');
        expect(rules).toMatch(/\bcite/i);
        expect(rules).toMatch(/coverage/i);
        expect(rules).toMatch(/verbatim/);
    });

    it('uses only the tools, inputs and skills the server declares', () => {
        const known = new Set([
            ...NAMES,
            ...TOOL_DEFINITIONS.flatMap((tool) => [tool.name, ...Object.keys(tool.inputSchema.shape)]),
        ]);
        for (const skill of SKILLS) {
            const used = [...skill.instructions.matchAll(/`([a-z][a-z_]*)(?::[^`]*)?`/g)].map((match) => match[1]);
            expect(used.length).toBeGreaterThan(3);
            expect([skill.name, used.filter((name) => !known.has(name))]).toEqual([skill.name, []]);
        }
    });

    it('covers the design §9 document-type table across the skills', () => {
        const all = SKILLS.map((skill) => skill.instructions).join('\n');
        for (const type of DOCUMENT_TYPES) expect(all).toContain(type);
    });

    it('parses front matter with Windows line ends and rejects files without it', () => {
        expect(parseSkill('---\r\nname: a\r\ndescription: b\r\n---\r\n# A\r\nsteps')).toEqual({
            name: 'a',
            description: 'b',
            instructions: '# A\r\nsteps',
        });
        expect(() => parseSkill('# No front matter')).toThrow(/front matter/);
        expect(() => parseSkill('---\nname: a\n---\n# A')).toThrow(/description/);
        expect(() => parseSkill('---\nname: a\ndescription: b\n---\n  ')).toThrow(/instructions/);
    });
});

describe('retrieve_skill', () => {
    it('is read-only, short, and lists the skill names in its task parameter', () => {
        expect(retrieveSkill.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
        expect(retrieveSkill.description.length).toBeLessThanOrEqual(1024);
        expect(retrieveSkill.description).toMatch(/call it first for any multi-step research/i);
        const task = retrieveSkill.inputSchema.shape.task;
        for (const name of NAMES) expect(task.description).toContain(name);
    });

    it('without task lists every skill with its one-line description', async () => {
        const { result, text } = await call();
        expect(result.isError).toBeUndefined();
        expect(text).toMatch(/not affiliated with the World Bank/);
        for (const skill of SKILLS) expect(text).toContain(`- ${skill.name}: ${skill.description}`);
        expect(text).toContain('wb___search_documents');
    });

    it('treats a blank task as no task', async () => {
        expect((await call('  ')).text).toBe((await call()).text);
    });

    it('with task returns that skill', async () => {
        const { result, text } = await call('implementation-tracking');
        expect(result.isError).toBeUndefined();
        const skill = SKILLS.find((candidate) => candidate.name === 'implementation-tracking')!;
        expect(text).toContain(`Skill: implementation-tracking. ${skill.description}`);
        expect(text).toContain(skill.instructions);
        expect(text).not.toContain('# Project briefing');
    });

    it.each([['Project briefing'], ['project_briefing'], [' PROJECT-BRIEFING ']])(
        'matches "%s" to project-briefing',
        async (task) => {
            expect(findSkill(task)?.name).toBe('project-briefing');
            expect((await call(task)).text).toContain('# Project briefing');
        },
    );

    it('answers an unknown task with an error and the list', async () => {
        const { result, text } = await call('weather forecast');
        expect(result.isError).toBe(true);
        expect(text).toMatch(/^No skill is named "weather forecast"\./);
        for (const name of NAMES) expect(text).toContain(`- ${name}: `);
    });

    it('keeps every skill well within the output budget', async () => {
        for (const name of NAMES) expect((await call(name)).text.length).toBeLessThan(12_000);
    });
});
