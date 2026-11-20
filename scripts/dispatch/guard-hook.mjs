import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// PreToolUse hook for Bash and Agent in dispatcher sessions (plan §2.4 layer 4).
// The copy that runs is the one the dispatcher writes from origin/main to ~/.wbank-mcp-dispatch/.
// It sees command text only; the layers that hold against scripts are the AWS policy, the sandbox and the
// scoped GitHub token. This one turns the common mistakes into readable refusals.

export const PROTECTED_BRANCHES = ['main'];

// gh subcommands a session never needs. Merging, workflows, runs, repo settings, secrets, aliases
// (which could hide a blocked command) and printing the token.
const GH_BLOCKED = [
  ['pr', 'merge'], ['workflow'], ['run', 'rerun'], ['run', 'cancel'], ['run', 'delete'], ['repo'], ['secret'],
  ['variable'], ['ruleset'], ['auth'], ['alias'], ['extension'], ['gist'], ['release'], ['api', 'graphql']
];

// gh api paths that change who can deploy or merge, approve a deployment, or start a workflow
const GH_API_BLOCKED = /\/merges?\b|\/dispatches\b|\/pending_deployments\b|\/environments\b|\/protection\b|\/rulesets\b|\/(actions|dependabot|codespaces)\/(secrets|variables|permissions)\b|\/collaborators\b|\/hooks\b|\/keys\b|\/deployments\b|\/(rerun|rerun-failed-jobs|cancel|force-cancel|approve)\b|\/git\/refs\b|\/contents\//;

export function splitCommands(command) {
  return command.split(/&&|\|\||[;|\n&]|\$\(|`/).map((s) => tokenize(s)).filter((t) => t.length > 0);
}

export function tokenize(segment) {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const words = tokens.map((t) => t.replace(/^(['"])(.*)\1$/, '$2').replace(/[()]/g, '')).filter(Boolean);
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['env', 'command', 'exec', 'sudo', 'nohup', 'time'].includes(words[0]))) words.shift();
  return words;
}

const base = (cmd) => cmd.split('/').pop();

function gitSubcommand(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    i += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[i]) ? 2 : 1;
  }
  return { sub: words[i], args: words.slice(i + 1) };
}

export function pushTargets(args) {
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (['--all', '--mirror', '--branches', '--tags'].includes(a)) return { bulk: a, refs: [] };
    if (['-d', '--delete', '--prune'].includes(a)) return { remove: true, refs: [] };
    if (['-f', '--force'].includes(a)) return { force: true, refs: [] };
    if (['--repo', '--receive-pack', '--exec', '-o', '--push-option'].includes(a)) { i += 1; continue; }
    if (!a.startsWith('-')) positional.push(a);
  }
  const specs = positional.slice(1);
  if (specs.some((s) => s.startsWith(':'))) return { remove: true, refs: [] };
  if (specs.some((s) => s.startsWith('+'))) return { force: true, refs: [] };
  const refs = specs.map((spec) => spec.split(':').pop().replace(/^refs\/heads\//, ''));
  return { refs };
}

function checkGh(words) {
  const blocked = GH_BLOCKED.find((pattern) => pattern.every((w, i) => words[i + 1] === w));
  if (blocked) return block(`\`gh ${blocked.join(' ')}\` is not allowed in dispatcher sessions. Merging, workflows, deployments and repo settings are Roy's.`);
  if (words[1] === 'api') {
    if (words.some((w) => GH_API_BLOCKED.test(w))) return block('That `gh api` path changes merges, deployments, workflows or repo settings. It is not allowed.');
    const method = words.find((w, i) => ['-X', '--method'].includes(words[i - 1]))?.toUpperCase();
    if (['PUT', 'DELETE'].includes(method)) return block(`\`gh api -X ${method}\` is not allowed. Use \`gh pr\` commands for your own PR.`);
  }
  return undefined;
}

function checkGit(words, currentBranch) {
  const { sub, args } = gitSubcommand(words);
  if (sub !== 'push') return undefined;
  const t = pushTargets(args);
  if (t.bulk) return block(`\`git push ${t.bulk}\` is not allowed; push only your feature branch.`);
  if (t.remove) return block('Deleting branches on origin is not allowed.');
  if (t.force) return block('Force-pushing is not allowed; use `git push --force-with-lease` on your own feature branch.');
  const targets = (t.refs.length > 0 ? t.refs : ['HEAD']).map((r) => (r === 'HEAD' ? currentBranch() : r));
  const hit = targets.find((r) => PROTECTED_BRANCHES.includes(r));
  if (hit) return block(`Never push to ${hit}. Push your feature branch and open a PR into main.`);
  const other = targets.find((r) => r && !r.startsWith('feature/'));
  if (other) return block(`Push only feature/* branches (not ${other}).`);
  return undefined;
}

export function checkCommand(command, { currentBranch = () => undefined } = {}) {
  for (const words of splitCommands(command)) {
    const cmd = base(words[0]);
    const result =
      (cmd === 'gh' && checkGh(words)) ||
      (cmd === 'git' && checkGit(words, currentBranch)) ||
      (cmd === 'sam' && ['deploy', 'sync', 'delete', 'remote'].includes(words[1]) &&
        block(`\`sam ${words[1]}\` is not allowed: the stack changes only through the deploy pipeline after Roy merges and approves. AWS would refuse it anyway.`)) ||
      (cmd === 'claude' && block('Starting Claude sessions (local or cloud) from a dispatcher session is not allowed.')) ||
      (cmd === 'security' && block('Reading the macOS Keychain is not allowed.')) ||
      undefined;
    if (result) return result;
  }
  return { allowed: true };
}

// Subagents are fine; remote (cloud) agents are not: this project runs local sessions only.
export function checkAgent(input) {
  if (input?.isolation === 'remote') return block('Remote (cloud) agents are not allowed: this project runs local sessions only.');
  return { allowed: true };
}

function block(message) {
  return { allowed: false, message };
}

export function readCurrentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function main({ input, stderr, currentBranch }) {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return 0;
  }
  let result = { allowed: true };
  if (event.tool_name === 'Agent' || event.tool_name === 'Task') {
    result = checkAgent(event.tool_input);
  } else {
    const command = event.tool_input?.command;
    if (typeof command !== 'string') return 0;
    result = checkCommand(command, { currentBranch: () => currentBranch(event.cwd ?? process.cwd()) });
  }
  if (result.allowed) return 0;
  stderr.write(`Blocked by the dispatcher guard: ${result.message}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main({ input: readFileSync(0, 'utf8'), stderr: process.stderr, currentBranch: readCurrentBranch });
}
