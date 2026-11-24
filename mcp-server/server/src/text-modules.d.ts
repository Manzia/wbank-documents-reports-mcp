// Skill files (src/tools/retrieve-skill.ts) are imported as text: esbuild inlines them, Jest uses tests/setup/text-transform.cjs.
declare module '*.md' {
    const text: string;
    export default text;
}
