import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// Local dispatcher (plan §6). Entry point: dispatch-local.sh.

export const REPO = 'Manzia/wbank-documents-reports-mcp';
export const BASE_BRANCH = 'main';
export const BASE = `origin/${BASE_BRANCH}`;
export const FILES = {
  tasks: 'context/tasks/wbank-mcp-tasks.yaml',
  instructions: 'context/tasks/agent-instructions.md',
  policy: 'scripts/dispatch/session-policy.json',
  settings: 'scripts/dispatch/session-settings.json',
  guard: 'scripts/dispatch/guard-hook.mjs'
};
export const AWS_PROFILE = 'wb-mcp';
export const REGION = 'us-east-1';
export const CREDENTIAL_SECONDS = 36 * 3600;
// Keychain item holding the fine-grained GitHub token for sessions (plan §2.4 layer 5)
export const GITHUB_TOKEN_SERVICE = 'wbank-mcp-dispatch-github';
export const DEPLOY_WORKFLOW = 'deploy.yml';
export const MAX_RESUMES = 2;
export const ACTIVE_STATES = ['working', 'blocked'];
// A session listed as working or blocked whose process is gone (no pid) is stopped, not running
export const isLive = (s) => ACTIVE_STATES.includes(s.state) && Boolean(s.pid);
export const RESUME_PROMPT = 'You were stopped and are now resumed with fresh credentials. Continue your task where you left off.';

export const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const branchName = (task) => `feature/${task.id}-${slug(task.title)}`;
export const prTaskId = (title) => title.match(/^(MCP-\d+):/)?.[1];
export const branchTaskId = (ref) => ref.match(/(?:^|\/)feature\/(MCP-\d+)-/)?.[1];

export function startPrompt(task) {
  return `You are the local session for ${task.id}: ${task.title}. Your task is described in context/tasks/wbank-mcp-implementation-plan.md §5; follow the rules in your system prompt. Open a draft PR into main early and finish with the PR titled "${task.id}: ${task.title}".`;
}

export const SELF_TEST_PROMPT = [
  'This is the dispatcher guard self-test (scripts/dispatch/README.md). Run each check, never try to work around a block, and finish with a table of check, expected, result, pass/fail.',
  'Must succeed: `npm ci` and `npm test` in mcp-server/hello-world; `gh api repos/Manzia/wbank-documents-reports-mcp --jq .full_name`; `git push --dry-run origin HEAD:refs/heads/feature/MCP-000-self-test`; `aws cloudformation describe-stacks --stack-name wbank-docs-reports-mcp-prod --query "Stacks[0].StackStatus"`; `curl -s -o /dev/null -w "%{http_code}" "https://search.worldbank.org/api/v3/wds?format=json&rows=1"` prints 200.',
  'Must fail: `cat ~/.aws/credentials`; `cat ~/.aws/credentials.bak`; `ls ~/.aws/sso/cache ~/.aws/cli/cache`; `ls ~/.ssh`; `ls ~/.config/gh`; `ls ~/.wbank-mcp-dispatch/sessions`; `node -e "require(\'fs\').readFileSync(process.env.HOME+\'/.aws/credentials\')"`; reading ~/.aws/credentials and ~/.config/gh/hosts.yml with your Read tool; `touch ~/.aws/x`; `touch ~/.npm/x`; `curl -sI https://example.com`.',
  'Must return AccessDenied: `aws cloudformation create-stack --stack-name x --template-body \'{}\'`; `aws secretsmanager list-secrets`; `aws lambda list-functions --max-items 1 --query "Functions[0].FunctionName" && aws lambda invoke --function-name x /dev/null`.',
  'Must be blocked by the guard hook: `gh pr merge 1`; `bash -c "gh pr merge 1"`; `gh -R Manzia/wbank-documents-reports-mcp pr merge 1`; `gh run rerun 1`; `security find-generic-password -s gh:github.com -w`; `claude --version`.'
].join('\n');

export function paths(home, repo) {
  const state = join(home, '.wbank-mcp-dispatch');
  return {
    pauseFile: join(home, '.wbank-mcp-dispatch-paused'),
    state,
    lock: join(state, 'lock'),
    claims: join(state, 'claims'),
    guard: join(state, 'guard-hook.mjs'),
    settings: join(state, 'session-settings.json'),
    sessions: join(state, 'sessions'),
    instructions: join(state, 'agent-instructions.md'),
    log: join(home, 'Library', 'Logs', 'wbank-mcp-dispatch.log'),
    worktrees: join(repo, '.claude', 'worktrees')
  };
}

const withoutSid = (statement) => Object.fromEntries(Object.entries(statement).filter(([k]) => k !== 'Sid'));

// The session policy is an allow-list: a federation token gets the intersection of wb-mcp's rights and this
// policy, so the session can do only what the file allows (read the stack, invoke Claude on Bedrock).
// Sids are dropped to stay under STS's 2,048-character packed limit.
export function sessionPolicy(policy) {
  return JSON.stringify({ Version: policy.Version, Statement: policy.Statement.map(withoutSid) });
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const showBase = (sh, repo, file) => sh('git', ['-C', repo, 'show', `${BASE}:${file}`]);

export function readTaskFile(sh, repo) {
  return yaml.load(showBase(sh, repo, FILES.tasks));
}

// PRs into main. Only PRs from this repo count: the repo is public, and a fork PR titled with a task ID
// must not mark that task taken (open) or anything else.
export function readGitHub(sh) {
  const out = sh('gh', ['api', '--paginate', `repos/${REPO}/pulls?state=all&base=${BASE_BRANCH}&per_page=100`,
    '--jq', `.[] | select(.head.repo.full_name == "${REPO}") | {number, title, state, draft, merged: (.merged_at != null), updatedAt: .updated_at} | @json`]);
  const done = new Set();
  const openPrs = new Map();
  for (const pr of lines(out).map((l) => JSON.parse(l))) {
    const id = prTaskId(pr.title);
    if (!id) continue;
    if (pr.merged) done.add(id);
    else if (pr.state === 'open') openPrs.set(id, pr);
  }
  return { done, openPrs };
}

// State of the prod deploy for the current head of main: ok, pending (CI or the deploy still running, or
// waiting for Roy's approval) or failed. Tasks marked after_deploy start only when it is ok.
export function readDeploy(sh, repo) {
  const head = sh('git', ['-C', repo, 'rev-parse', BASE]).trim();
  const out = sh('gh', ['api', `repos/${REPO}/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=${BASE_BRANCH}&event=workflow_run&per_page=1`,
    '--jq', '.workflow_runs[0] | {head_sha, status, conclusion} | @json']).trim();
  const run = out ? JSON.parse(out) : null;
  if (!run || run.head_sha !== head) return { state: 'pending', reason: 'no deploy run yet for the head of main' };
  if (run.status !== 'completed') return { state: 'pending', reason: `deploy ${run.status}` };
  if (run.conclusion !== 'success') return { state: 'failed', reason: `last deploy ${run.conclusion}` };
  return { state: 'ok' };
}

export function readRemoteBranches(sh, repo) {
  const out = sh('git', ['-C', repo, 'ls-remote', '--heads', 'origin', 'feature/MCP-*']);
  return new Set(lines(out).map((l) => branchTaskId(l.split(/\s+/)[1] ?? '')).filter(Boolean));
}

export function readLocalBranches(sh, repo) {
  const out = sh('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feature/']);
  return new Map(lines(out).map((b) => [branchTaskId(b), b]).filter(([id]) => id));
}

export function readWorktrees(sh, repo, worktreesDir) {
  const out = sh('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  return new Map(lines(out)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => dirname(p) === worktreesDir)
    .map((p) => [basename(p), p]));
}

export function readClaims(claimsDir) {
  if (!existsSync(claimsDir)) return new Map();
  return new Map(readdirSync(claimsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(claimsDir, f), 'utf8')))
    .map((c) => [c.id, c]));
}

export function writeClaim(claimsDir, claim) {
  mkdirSync(claimsDir, { recursive: true });
  writeFileSync(join(claimsDir, `${claim.id}.json`), `${JSON.stringify(claim, null, 2)}\n`);
}

// `claude agents` lists background sessions of every project on the Mac; only this repo's worktrees count.
export function readSessions(sh, worktreesDir) {
  const all = JSON.parse(sh('claude', ['agents', '--json', '--cwd', worktreesDir]) || '[]');
  return all.filter((s) => !s.cwd || s.cwd === worktreesDir || s.cwd.startsWith(`${worktreesDir}/`));
}

export function acquireLock(lockDir, isAlive) {
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readOrEmpty(join(lockDir, 'pid')));
      if (pid && isAlive(pid)) return false;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

const readOrEmpty = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function classify(task, state) {
  const { id } = task;
  if (task.runs !== 'local') return { kind: 'skip', reason: `runs: ${task.runs}` };
  const local = [
    state.claims.has(id) && 'claim file',
    state.localBranches.has(id) && 'local branch',
    state.worktrees.has(id) && 'worktree'
  ].filter(Boolean);
  if (state.done.has(id)) return local.length > 0 ? { kind: 'cleanup', reason: local.join(', ') } : { kind: 'skip', reason: 'done' };
  if (state.claims.has(id)) return { kind: 'claimed' };
  const taken = [
    ...local,
    state.remoteBranches.has(id) && 'branch on origin',
    state.openPrs.has(id) && `open PR #${state.openPrs.get(id).number}`
  ].filter(Boolean);
  if (taken.length > 0) return { kind: 'skip', reason: `taken (${taken.join(', ')})` };
  const waiting = (task.depends ?? []).filter((d) => !state.done.has(d));
  if (waiting.length > 0) return { kind: 'skip', reason: `waiting for ${waiting.join(', ')}` };
  if (task.after_deploy && state.deploy?.state !== 'ok') {
    return { kind: 'skip', reason: `waiting for the prod deploy (${state.deploy?.reason ?? 'unknown'})` };
  }
  return { kind: 'candidate' };
}

export function isStale({ claim, pr, lastCommitMs, nowMs, staleHours }) {
  const activity = [lastCommitMs, pr && Date.parse(pr.updatedAt), Date.parse(claim.startedAt), claim.resumedAt && Date.parse(claim.resumedAt)]
    .filter((t) => Number.isFinite(t));
  return nowMs - Math.max(...activity) > staleHours * 3600 * 1000;
}

function lastCommitMs(sh, repo, branch) {
  try {
    return Number(sh('git', ['-C', repo, 'log', '-1', '--format=%ct', branch]).trim()) * 1000;
  } catch {
    return undefined;
  }
}

export function installGuard(ctx, p) {
  mkdirSync(p.state, { recursive: true });
  writeFileSync(p.guard, showBase(ctx.sh, ctx.repo, FILES.guard));
  writeFileSync(p.settings, showBase(ctx.sh, ctx.repo, FILES.settings));
  writeFileSync(p.instructions, showBase(ctx.sh, ctx.repo, FILES.instructions));
}

export function createCredentials(ctx, name) {
  const policy = sessionPolicy(JSON.parse(showBase(ctx.sh, ctx.repo, FILES.policy)));
  const out = ctx.sh('aws', ['sts', 'get-federation-token', '--profile', AWS_PROFILE, '--region', REGION,
    '--name', `wbmcp-${name}`.slice(0, 32), '--duration-seconds', String(CREDENTIAL_SECONDS),
    '--policy', policy, '--output', 'json']);
  return JSON.parse(out).Credentials;
}

// The fine-grained token (this repo only; no admin, environment, secret or deployment rights). Fail closed:
// without it no session starts, because the fallback would be Roy's own token with access to every repo.
export function readGitHubToken(ctx) {
  let token = '';
  try {
    token = ctx.sh('security', ['find-generic-password', '-s', GITHUB_TOKEN_SERVICE, '-w']).trim();
  } catch {
    token = '';
  }
  if (!token) throw new Error(`no session GitHub token: Keychain item "${GITHUB_TOKEN_SERVICE}" is missing (README, Prerequisites)`);
  return token;
}

const SESSION_SECRETS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

// claude runs without AWS or GitHub token variables. A background session runs in a process that Claude Code's
// background service started, with the service's environment, not the caller's; so the task's credentials go in
// its settings (sessionSettings), and a service this call starts holds no task's credentials.
export function launchEnv(baseEnv) {
  return Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !k.startsWith('AWS_') && !SESSION_SECRETS.includes(k)));
}

// The guard settings plus an env block with the task's temporary credentials, token, region and npm cache.
// The AWS CLI and gh are pointed at empty per-session locations, so they never need ~/.aws or ~/.config/gh,
// which the sandbox denies outright.
export function sessionSettings(guard, worktree, creds, githubToken) {
  return {
    ...guard,
    env: {
      ...guard.env,
      AWS_ACCESS_KEY_ID: creds.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
      AWS_SESSION_TOKEN: creds.SessionToken,
      AWS_REGION: REGION,
      AWS_DEFAULT_REGION: REGION,
      AWS_CONFIG_FILE: join(worktree, '.session-config', 'aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: join(worktree, '.session-config', 'aws-credentials'),
      GH_TOKEN: githubToken,
      GH_CONFIG_DIR: join(worktree, '.session-config', 'gh'),
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      npm_config_cache: join(worktree, '.npm-cache')
    }
  };
}

// ~/.wbank-mcp-dispatch/sessions/<id>.json, readable by the owner only, rewritten at every start and resume
function writeSessionSettings(ctx, p, id, worktree) {
  const githubToken = readGitHubToken(ctx);
  mkdirSync(p.sessions, { recursive: true, mode: 0o700 });
  const file = join(p.sessions, `${id}.json`);
  const settings = sessionSettings(JSON.parse(readFileSync(p.settings, 'utf8')), worktree, createCredentials(ctx, id), githubToken);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function guardArgs(p, settings) {
  return ['--permission-mode', 'auto', '--settings', settings, '--append-system-prompt-file', p.instructions];
}

function launch(ctx, p, task, claim, resume) {
  installGuard(ctx, p);
  const settings = writeSessionSettings(ctx, p, task.id, claim.worktree);
  const args = resume
    ? ['--bg', '--resume', claim.sessionId, '-n', task.id, ...guardArgs(p, settings), RESUME_PROMPT]
    : ['--bg', '-n', task.id, ...guardArgs(p, settings), startPrompt(task)];
  ctx.sh('claude', args, { cwd: claim.worktree, env: launchEnv(ctx.env) });
}

function startTask(ctx, p, task) {
  const branch = branchName(task);
  const worktree = join(p.worktrees, task.id);
  ctx.sh('git', ['-C', ctx.repo, 'worktree', 'add', '-b', branch, worktree, BASE]);
  // Sessions can't write .git/config (sandbox), so the upstream is set here for a plain `git push`.
  ctx.sh('git', ['-C', ctx.repo, 'config', `branch.${branch}.remote`, 'origin']);
  ctx.sh('git', ['-C', ctx.repo, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  const claim = { id: task.id, title: task.title, branch, worktree, startedAt: new Date(ctx.now()).toISOString(), resumes: 0 };
  writeClaim(p.claims, claim);
  launch(ctx, p, task, claim, false);
  const session = readSessions(ctx.sh, p.worktrees).find((s) => s.name === task.id);
  if (session?.sessionId) writeClaim(p.claims, { ...claim, sessionId: session.sessionId });
}

function cleanUp(ctx, p, task, state) {
  if (state.worktrees.has(task.id)) ctx.sh('git', ['-C', ctx.repo, 'worktree', 'remove', '--force', state.worktrees.get(task.id)]);
  if (state.localBranches.has(task.id)) ctx.sh('git', ['-C', ctx.repo, 'branch', '-D', state.localBranches.get(task.id)]);
  rmSync(join(p.claims, `${task.id}.json`), { force: true });
  rmSync(join(p.sessions, `${task.id}.json`), { force: true });
}

function notify(ctx, message) {
  try {
    ctx.sh('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "World Bank MCP dispatch"`]);
  } catch {
    // Notifications are best effort; the log line is the record.
  }
}

// Notify at most once per stale_hours per kind (stale, blocked); the claim file remembers when.
function notifyOnce(ctx, p, claim, kind, message, staleHours) {
  const key = `${kind}NotifiedAt`;
  const last = claim[key] ? Date.parse(claim[key]) : 0;
  if (ctx.dryRun || ctx.now() - last <= staleHours * 3600 * 1000) return claim;
  notify(ctx, message);
  const updated = { ...claim, [key]: new Date(ctx.now()).toISOString() };
  writeClaim(p.claims, updated);
  return updated;
}

function reportStale(ctx, p, claim, reason, staleHours) {
  notifyOnce(ctx, p, claim, 'stale', `${claim.id} is stale: ${reason}`, staleHours);
  return `stale: ${reason}`;
}

function handleClaimed(ctx, p, task, state, config, slots) {
  let claim = state.claims.get(task.id);
  const pr = state.openPrs.get(task.id);
  const session = state.sessions.find((s) => s.name === task.id && isLive(s));
  if (session) {
    if (session.sessionId && session.sessionId !== claim.sessionId && !ctx.dryRun) {
      claim = { ...claim, sessionId: session.sessionId };
      writeClaim(p.claims, claim);
    }
    const stale = isStale({ claim, pr, lastCommitMs: lastCommitMs(ctx.sh, ctx.repo, claim.branch), nowMs: ctx.now(), staleHours: config.stale_hours });
    if (stale) return reportStale(ctx, p, claim, `no commit or PR activity for ${config.stale_hours}h`, config.stale_hours);
    if (session.state === 'blocked') {
      notifyOnce(ctx, p, claim, 'blocked', `${task.id} needs you: claude attach ${task.id}`, config.stale_hours);
    }
    return `running (${session.state})`;
  }
  if (pr && !pr.draft) return `finished: PR #${pr.number} is ready for review`;
  if ((claim.resumes ?? 0) >= MAX_RESUMES) return reportStale(ctx, p, claim, `session stopped without a ready PR after ${MAX_RESUMES} resumes`, config.stale_hours);
  if (!claim.sessionId) return reportStale(ctx, p, claim, 'session stopped and its session ID is unknown', config.stale_hours);
  if (slots.free <= 0) return 'waiting: no capacity to resume';
  slots.free -= 1;
  if (ctx.dryRun) return `would resume (${(claim.resumes ?? 0) + 1} of ${MAX_RESUMES})`;
  const resumed = { ...claim, resumes: (claim.resumes ?? 0) + 1, resumedAt: new Date(ctx.now()).toISOString() };
  writeClaim(p.claims, resumed);
  launch(ctx, p, task, resumed, true);
  // claude --bg --resume starts a new session; the next resume must continue that one
  const next = readSessions(ctx.sh, p.worktrees).find((s) => s.name === task.id && isLive(s) && s.sessionId);
  if (next) writeClaim(p.claims, { ...resumed, sessionId: next.sessionId });
  return `resumed (${resumed.resumes} of ${MAX_RESUMES})`;
}

export function pass(ctx, p) {
  const { sh, repo } = ctx;
  sh('git', ['-C', repo, 'fetch', '--prune', 'origin']);
  const config = readTaskFile(sh, repo);
  if (config.paused) {
    ctx.out(`paused: paused: true in the task file on ${BASE}`);
    return;
  }
  const state = {
    ...readGitHub(sh),
    deploy: readDeploy(sh, repo),
    remoteBranches: readRemoteBranches(sh, repo),
    localBranches: readLocalBranches(sh, repo),
    worktrees: readWorktrees(sh, repo, p.worktrees),
    claims: readClaims(p.claims),
    sessions: readSessions(sh, p.worktrees)
  };
  const ids = new Set(config.tasks.map((t) => t.id));
  const running = state.sessions.filter((s) => ids.has(s.name) && isLive(s)).length;
  const slots = { free: config.local_capacity - running };
  const decisions = new Map();
  const classes = config.tasks.map((task) => [task, classify(task, state)]);

  for (const [task, c] of classes) {
    if (c.kind === 'skip') decisions.set(task.id, `skip: ${c.reason}`);
    if (c.kind === 'cleanup') {
      if (!ctx.dryRun) cleanUp(ctx, p, task, state);
      decisions.set(task.id, `${ctx.dryRun ? 'would clean up' : 'cleaned up'}: done (${c.reason})`);
    }
  }
  for (const [task] of classes.filter(([, c]) => c.kind === 'claimed')) {
    decisions.set(task.id, handleClaimed(ctx, p, task, state, config, slots));
  }
  for (const [task] of classes.filter(([, c]) => c.kind === 'candidate')) {
    if (slots.free <= 0) {
      decisions.set(task.id, `skip: no capacity (local_capacity ${config.local_capacity}, ${running} running)`);
      continue;
    }
    slots.free -= 1;
    if (ctx.dryRun) {
      decisions.set(task.id, `would start on ${branchName(task)}`);
      continue;
    }
    startTask(ctx, p, task);
    decisions.set(task.id, `started on ${branchName(task)}`);
  }
  for (const task of config.tasks) ctx.out(`${task.id} ${decisions.get(task.id)}`);
}

export function runOnce(ctx) {
  const p = paths(ctx.home, ctx.repo);
  if (existsSync(p.pauseFile)) {
    ctx.out('paused: ~/.wbank-mcp-dispatch-paused exists');
    return;
  }
  if (!ctx.dryRun && !acquireLock(p.lock, ctx.isAlive ?? isProcessAlive)) {
    ctx.out('skipped: another dispatcher run holds the lock');
    return;
  }
  try {
    pass(ctx, p);
  } finally {
    if (!ctx.dryRun) rmSync(p.lock, { recursive: true, force: true });
  }
}

export function selfTest(ctx) {
  const p = paths(ctx.home, ctx.repo);
  const worktree = join(p.worktrees, 'SELFTEST');
  ctx.sh('git', ['-C', ctx.repo, 'fetch', '--prune', 'origin']);
  ctx.sh('git', ['-C', ctx.repo, 'worktree', 'add', '--detach', worktree, BASE]);
  try {
    installGuard(ctx, p);
    const settings = writeSessionSettings(ctx, p, 'SELFTEST', worktree);
    ctx.sh('claude', [...guardArgs(p, settings), SELF_TEST_PROMPT], { cwd: worktree, env: launchEnv(ctx.env), stdio: 'inherit' });
  } finally {
    rmSync(join(p.sessions, 'SELFTEST.json'), { force: true });
    ctx.sh('git', ['-C', ctx.repo, 'worktree', 'remove', '--force', worktree]);
  }
}

export function runCommand(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  });
}

export const USAGE = 'Usage: dispatch-local.sh [--dry-run | --now | --self-test]';

export function main({ argv, env, sh, stdout, stderr, now = Date.now, repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') }) {
  const flags = new Set(argv);
  const known = ['--dry-run', '--now', '--self-test'];
  if ([...flags].some((f) => !known.includes(f))) {
    stderr.write(`${USAGE}\n`);
    return 64;
  }
  const dryRun = flags.has('--dry-run');
  const p = paths(env.HOME, repo);
  const out = (line) => {
    stdout.write(`${line}\n`);
    if (!dryRun) {
      mkdirSync(dirname(p.log), { recursive: true });
      appendFileSync(p.log, `${new Date(now()).toISOString()} ${line}\n`);
    }
  };
  const ctx = { sh, env, home: env.HOME, repo, dryRun, now, out };
  try {
    if (flags.has('--self-test')) selfTest(ctx);
    else runOnce(ctx);
    return 0;
  } catch (err) {
    out(`error: ${err.message.split('\n')[0]}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main({ argv: process.argv.slice(2), env: process.env, sh: runCommand, stdout: process.stdout, stderr: process.stderr });
}
