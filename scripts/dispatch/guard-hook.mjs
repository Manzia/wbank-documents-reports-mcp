import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// PreToolUse hook for Bash and Agent in dispatcher sessions (plan §2.4 layer 4).
// The copy that runs is the one the dispatcher writes from origin/main to ~/.wbank-mcp-dispatch/.
// It sees command text only; the layers that hold against scripts are the AWS policy, the sandbox and the
// scoped GitHub token. This one turns the common mistakes into readable refusals, and refuses what it
// can't parse (unbalanced quotes, deep nesting, variables in a gh or git subcommand).

export const PROTECTED_BRANCHES = ['main'];

// gh subcommands a session never needs. Merging, workflows, runs, repo settings, secrets, aliases
// (which could hide a blocked command) and printing the token.
const GH_BLOCKED = [
  ['pr', 'merge'], ['workflow'], ['run', 'rerun'], ['run', 'cancel'], ['run', 'delete'], ['repo'], ['secret'],
  ['variable'], ['ruleset'], ['auth'], ['alias'], ['extension'], ['gist'], ['release'], ['api', 'graphql']
];

// gh api paths that change who can deploy or merge, approve a deployment, or start a workflow
const GH_API_BLOCKED = /\/merges?\b|\/dispatches\b|\/pending_deployments\b|\/environments\b|\/protection\b|\/rulesets\b|\/(actions|dependabot|codespaces)\/(secrets|variables|permissions)\b|\/collaborators\b|\/hooks\b|\/keys\b|\/deployments\b|\/(rerun|rerun-failed-jobs|cancel|force-cancel|approve)\b|\/git\/refs\b|\/contents\//;

// Variables that would change what git or gh run, which credentials they use, or where their config comes from
// Any word that names one refuses the command: FOO=…, FOO+=…, bare after export/read/unset/printf -v, and
// spellings that the shell turns into the name (GH_CONFIG_{DIR,X}, $'GH_TOKEN'), since the word is tested
// with every non-identifier character removed.
const BLOCKED_VARS = /GIT_CONFIG|GIT_EXEC_PATH|GIT_ALIAS|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_HOST|GH_ENTERPRISE_TOKEN|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_PROFILE/;
const namesBlockedVar = (w) => BLOCKED_VARS.test(w.replace(/[^A-Za-z0-9_]/g, ''));
// Shell reserved words and grouping that can precede a command: `{ gh pr merge 1; }`, `if …; then gh …`
// (`time` is a wrapper, below, so its options are skipped too; `coproc` and `function` are refused.)
const RESERVED = ['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', '[[', ']]'];
// Brace expansion and globs change words after the hook has looked at them
const EXPANDS = /[{}*?[\]]/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SUBSTITUTION = '$(…)';

// Quote-aware shell lexer: splits on ; & | ( ) and newlines outside quotes, removes quotes, and pulls out
// command substitutions ($(…), `…`, <(…), >(…)) as separate commands to check. Approximate, but it never
// hides a command: anything it can't follow (unbalanced quotes) is reported as unparsable.
export function parse(command) {
  const segments = [];
  const substitutions = [];
  let words = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      // A backslash-newline is a line continuation: bash joins the two lines into one word
      if (command[i + 1] === '\n') {
        i += 1;
        continue;
      }
      cur += command[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    const opensParen = (c === '$' || (quote === null && (c === '<' || c === '>'))) && command[i + 1] === '(';
    if (opensParen || c === '`') {
      let end;
      if (c === '`') {
        end = command.indexOf('`', i + 1);
        if (end < 0) return { segments, substitutions, unparsable: 'an unclosed backtick' };
        substitutions.push(command.slice(i + 1, end));
      } else {
        let depth = 1;
        end = i + 2;
        while (end < command.length && depth > 0) {
          if (command[end] === '(') depth += 1;
          else if (command[end] === ')') depth -= 1;
          end += 1;
        }
        if (depth > 0) return { segments, substitutions, unparsable: 'an unclosed $(' };
        substitutions.push(command.slice(i + 2, end - 1));
        end -= 1;
      }
      cur += SUBSTITUTION;
      inWord = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if ('\n;&|()'.includes(c)) {
      endSegment();
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quote) return { segments, substitutions, unparsable: 'unbalanced quotes' };
  endSegment();
  return { segments, substitutions };
}

const base = (cmd) => cmd.split('/').pop();
const hasVariable = (w) => w.includes('$') || EXPANDS.test(w);

function gitSubcommand(words) {
  let i = 1;
  const config = [];
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-c') config.push(words[i + 1] ?? '');
    if (words[i].startsWith('--config-env')) config.push('--config-env');
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(words[i]) ? 2 : 1;
  }
  return { sub: words[i], args: words.slice(i + 1), config };
}

// -fu → -f -u, so combined short flags can't hide a force or delete
const expandShortFlags = (args) => args.flatMap((a) => (/^-[A-Za-z]{2,}$/.test(a) ? [...a.slice(1)].map((c) => `-${c}`) : [a]));

export function pushTargets(rawArgs) {
  const args = expandShortFlags(rawArgs);
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

// gh's global -R/--repo flag can sit anywhere; drop it so `gh -R x pr merge` matches `pr merge`
function ghWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    if (['-R', '--repo'].includes(words[i])) { i += 1; continue; }
    if (words[i].startsWith('--repo=')) continue;
    out.push(words[i]);
  }
  return out;
}

export function apiMethod(words) {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (['-X', '--method'].includes(w)) return (words[i + 1] ?? '').toUpperCase();
    if (/^-X./.test(w)) return w.slice(2).toUpperCase();
    if (w.startsWith('--method=')) return w.slice('--method='.length).toUpperCase();
  }
  return undefined;
}

function checkGh(rawWords) {
  const words = ghWords(rawWords);
  // The subcommand words must be literal. An api path may hold a variable (the blocked paths are matched
  // on the literal parts), but not a whole substitution.
  const subcommand = words[1] === 'api' ? words.slice(1, 2) : words.slice(1, 3);
  if (subcommand.some(hasVariable)) return block('A variable or substitution in a `gh` subcommand can\'t be checked. Write the subcommand out.');
  if (words[1] === 'api' && words.some((w) => w.includes(SUBSTITUTION))) return block('A command substitution in a `gh api` call can\'t be checked.');
  const blocked = GH_BLOCKED.find((pattern) => pattern.every((w, i) => words[i + 1] === w));
  if (blocked) return block(`\`gh ${blocked.join(' ')}\` is not allowed in dispatcher sessions. Merging, workflows, deployments and repo settings are Roy's.`);
  if (words[1] === 'api') {
    if (words.some((w) => GH_API_BLOCKED.test(w))) return block('That `gh api` path changes merges, deployments, workflows or repo settings. It is not allowed.');
    const method = apiMethod(words);
    if (method !== undefined && hasVariable(method)) return block('A variable in `gh api -X` can\'t be checked.');
    if (['PUT', 'DELETE'].includes(method)) return block(`\`gh api -X ${method}\` is not allowed. Use \`gh pr\` commands for your own PR.`);
  }
  return undefined;
}

function checkGit(words, opts, depth) {
  const { sub, args, config } = gitSubcommand(words);
  if (config.some((c) => c === '--config-env' || /^alias\./i.test(c))) return block('`git -c alias.…` and `--config-env` are not allowed: they could hide a blocked command.');
  if (sub === undefined) return undefined;
  if (hasVariable(sub)) return block('A variable or substitution as the `git` subcommand can\'t be checked. Write it out.');
  // An alias from the existing git config is checked as what it expands to
  const alias = opts.gitAlias?.(sub);
  if (alias) {
    return alias.startsWith('!')
      ? nested(`${alias.slice(1)} ${args.join(' ')}`, opts, depth)
      : nested(`git ${alias} ${args.join(' ')}`, opts, depth);
  }
  if (sub !== 'push') return undefined;
  const t = pushTargets(args);
  if (t.bulk) return block(`\`git push ${t.bulk}\` is not allowed; push only your feature branch.`);
  if (t.remove) return block('Deleting branches on origin is not allowed.');
  if (t.force) return block('Force-pushing is not allowed; use `git push --force-with-lease` on your own feature branch.');
  const currentBranch = opts.currentBranch ?? (() => undefined);
  const targets = (t.refs.length > 0 ? t.refs : ['HEAD']).map((r) => (r === 'HEAD' ? currentBranch() : r));
  if (targets.some((r) => r && hasVariable(r))) return block('A variable as the push target can\'t be checked. Write the branch out.');
  const hit = targets.find((r) => PROTECTED_BRANCHES.includes(r));
  if (hit) return block(`Never push to ${hit}. Push your feature branch and open a PR into main.`);
  const other = targets.find((r) => r && !r.startsWith('feature/'));
  if (other) return block(`Push only feature/* branches (not ${other}).`);
  return undefined;
}

const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'];
// Commands that run the rest of their arguments as another command
const WRAPPERS = ['env', 'command', 'exec', 'sudo', 'nohup', 'time', 'nice', 'timeout', 'caffeinate', 'xargs'];
// Wrapper options that take a value, so the value isn't mistaken for the command
const VALUE_FLAGS = {
  env: ['-u', '-C', '--unset', '--chdir'],
  sudo: ['-u', '-g', '-U', '-C', '-h', '-p', '-D', '--user', '--group'],
  nice: ['-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  caffeinate: ['-t', '-w'],
  xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-J', '-R']
};
const DECLARE = ['export', 'declare', 'typeset', 'local', 'readonly', 'set'];
const MAX_DEPTH = 4;

function checkWords(rawWords, opts, depth) {
  const blockedVar = rawWords.find(namesBlockedVar);
  if (blockedVar) return block(`Setting or naming ${blockedVar.split('=')[0]} is not allowed: it changes what git, gh or the AWS CLI use.`);
  if (rawWords.some((w) => w === 'coproc' || w === 'function')) return block('`coproc` and `function` are not allowed in dispatcher sessions. Write the commands out.');
  // `{` starts a command group wherever it stands as a word (`f() { … }`, `while x; do { … }`): check what follows
  const brace = rawWords.indexOf('{', 1);
  if (brace > 0) return checkWords(rawWords.slice(0, brace), opts, depth) || checkWords(rawWords.slice(brace + 1), opts, depth);
  let start = 0;
  while (start < rawWords.length && (ASSIGN.test(rawWords[start]) || RESERVED.includes(rawWords[start]))) start += 1;
  const words = rawWords.slice(start);
  if (words.length === 0) return undefined;
  const cmd = base(words[0]);
  if (!['[', '[['].includes(words[0]) && hasVariable(words[0])) return block('A variable or substitution as the command name can\'t be checked. Write the command out.');
  if (SHELLS.includes(cmd)) {
    // bash -c '<command>' (also -lc, -ec, …): check the inner command. Extra arguments would become $0, $1, …
    // inside it, which can't be checked, so they are refused. A script file can't be seen into.
    const i = words.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (i < 0) return undefined;
    if (words[i + 1] === undefined) return block('`-c` without a command.');
    if (words.length > i + 2) return block('`sh -c` with extra arguments can\'t be checked. Put the whole command in the -c string.');
    return nested(words[i + 1], opts, depth);
  }
  if (cmd === 'eval' || cmd === 'source' || cmd === '.') {
    return cmd === 'eval' ? nested(words.slice(1).join(' '), opts, depth) : undefined;
  }
  if (WRAPPERS.includes(cmd)) {
    let i = 1;
    while (i < words.length && (words[i].startsWith('-') || ASSIGN.test(words[i]) || (cmd === 'timeout' && /^\d/.test(words[i])))) {
      // env -S '<command>' splits its argument into a command line
      if (cmd === 'env' && ['-S', '--split-string'].includes(words[i])) return nested(words.slice(i + 1).join(' '), opts, depth);
      i += (VALUE_FLAGS[cmd] ?? []).includes(words[i]) ? 2 : 1;
    }
    return checkWords(words.slice(i), opts, depth);
  }
  return (
    (cmd === 'gh' && checkGh(words)) ||
    (cmd === 'git' && checkGit(words, opts, depth)) ||
    (cmd === 'sam' && ['deploy', 'sync', 'delete', 'remote'].includes(words[1]) &&
      block(`\`sam ${words[1]}\` is not allowed: the stack changes only through the deploy pipeline after Roy merges and approves. AWS would refuse it anyway.`)) ||
    (cmd === 'claude' && block('Starting Claude sessions (local or cloud) from a dispatcher session is not allowed.')) ||
    (cmd === 'security' && block('Reading the macOS Keychain is not allowed.')) ||
    undefined
  );
}

function nested(command, opts, depth) {
  if (depth >= MAX_DEPTH) return block('The command nests shells too deeply to check.');
  const result = checkCommand(command, opts, depth + 1);
  return result.allowed ? undefined : result;
}

export function checkCommand(command, opts = {}, depth = 0) {
  const { segments, substitutions, unparsable } = parse(command);
  if (unparsable) return block(`The command can't be checked (${unparsable}).`);
  for (const sub of substitutions) {
    const result = nested(sub, opts, depth);
    if (result) return result;
  }
  for (const words of segments) {
    const result = checkWords(words, opts, depth);
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

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function readCurrentBranch(cwd) {
  try {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return undefined;
  }
}

export function readGitAlias(cwd, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  try {
    return git(cwd, ['config', '--get', `alias.${name}`]) || undefined;
  } catch {
    return undefined;
  }
}

export function main({ input, stderr, currentBranch, gitAlias = () => undefined }) {
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
    const cwd = event.cwd ?? process.cwd();
    result = checkCommand(command, { currentBranch: () => currentBranch(cwd), gitAlias: (name) => gitAlias(cwd, name) });
  }
  if (result.allowed) return 0;
  stderr.write(`Blocked by the dispatcher guard: ${result.message}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main({ input: readFileSync(0, 'utf8'), stderr: process.stderr, currentBranch: readCurrentBranch, gitAlias: readGitAlias });
}
