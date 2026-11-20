import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import {
  BASE, FILES, GITHUB_TOKEN_SERVICE, MAX_RESUMES, RESUME_PROMPT, acquireLock, branchName, branchTaskId, classify, isStale, main,
  paths, prTaskId, isLive, launchEnv, readDeploy, runOnce, selfTest, sessionPolicy, sessionSettings, slug
} from './dispatch.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/tasks.yaml', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('./session-settings.json', import.meta.url), 'utf8');
const POLICY = readFileSync(new URL('./session-policy.json', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 3600 * 1000;
const MAIN_SHA = 'mainsha';
const iso = (ms) => new Date(ms).toISOString();

let home;
let repo;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  repo = mkdtempSync(join(tmpdir(), 'dispatch-repo-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// A fake gh, git, claude, aws, security and osascript. Every call is recorded.
function world(overrides = {}) {
  const w = {
    tasks: FIXTURE,
    prs: [{ number: 1, title: 'MCP-902: Local done task', state: 'closed', draft: false, merged: true, updatedAt: iso(NOW) }],
    deployRun: { head_sha: MAIN_SHA, status: 'completed', conclusion: 'success' },
    remote: [],
    localBranches: [],
    worktrees: [],
    sessions: [],
    commitTimes: {},
    token: 'github_pat_fake',
    calls: [],
    ...overrides
  };
  const worktreesDir = join(repo, '.claude', 'worktrees');
  w.sh = (cmd, args, opts = {}) => {
    w.calls.push({ cmd, args, opts });
    const a = cmd === 'git' && args[0] === '-C' ? args.slice(2) : args;
    if (cmd === 'git') {
      if (a[0] === 'fetch') return '';
      if (a[0] === 'rev-parse') return `${MAIN_SHA}\n`;
      if (a[0] === 'show') {
        const file = a[1].slice(`${BASE}:`.length);
        if (file === FILES.tasks) return w.tasks;
        if (file === FILES.policy) return POLICY;
        if (file === FILES.settings) return SETTINGS;
        return `content of ${file}\n`;
      }
      if (a[0] === 'ls-remote') return w.remote.map((b) => `abc123\trefs/heads/${b}`).join('\n');
      if (a[0] === 'for-each-ref') return w.localBranches.join('\n');
      if (a[0] === 'worktree' && a[1] === 'list') return [`worktree ${repo}`, ...w.worktrees.map((p) => `worktree ${p}`)].join('\n');
      if (a[0] === 'log') {
        const t = w.commitTimes[a[a.length - 1]];
        if (t === undefined) throw new Error('unknown revision');
        return `${t / 1000}\n`;
      }
      return '';
    }
    if (cmd === 'gh') {
      if (args[1].includes('/actions/workflows/')) return w.deployRun ? JSON.stringify(w.deployRun) : '';
      return w.prs.map((pr) => JSON.stringify(pr)).join('\n');
    }
    if (cmd === 'claude') {
      if (args[0] === 'agents') return JSON.stringify(w.sessions.map((s) => ({ cwd: join(worktreesDir, s.name), ...s })));
      const name = args[args.indexOf('-n') + 1];
      w.sessions.push({ name, sessionId: `session-${name}`, state: 'working', pid: 4242 });
      return '';
    }
    if (cmd === 'aws') {
      return JSON.stringify({ Credentials: { AccessKeyId: 'FAKEKEYID', SecretAccessKey: 'fake-secret', SessionToken: 'fake-token' } });
    }
    if (cmd === 'security') {
      if (!w.token) throw new Error('The specified item could not be found in the keychain.');
      return `${w.token}\n`;
    }
    return '';
  };
  return w;
}

function run(w, { dryRun = false, now = NOW, isAlive } = {}) {
  const lines = [];
  runOnce({ sh: w.sh, env: { HOME: home, PATH: '/bin', AWS_PROFILE: 'wb-mcp', GH_TOKEN: 'roys-token' }, home, repo, dryRun, now: () => now, out: (l) => lines.push(l), isAlive });
  return lines;
}

const line = (lines, id) => lines.find((l) => l.startsWith(`${id} `));
const claudeStarts = (w) => w.calls.filter((c) => c.cmd === 'claude' && c.args[0] !== 'agents');
const startsFor = (w, id) => claudeStarts(w).filter((c) => c.args.includes(id));
const claimsDir = () => paths(home, repo).claims;
const readClaim = (id) => JSON.parse(readFileSync(join(claimsDir(), `${id}.json`), 'utf8'));
// The settings file a claude call was given, parsed
const sessionSettingsOf = (call) => JSON.parse(readFileSync(call.args[call.args.indexOf('--settings') + 1], 'utf8'));

function writeClaimFile(claim) {
  mkdirSync(claimsDir(), { recursive: true });
  writeFileSync(join(claimsDir(), `${claim.id}.json`), JSON.stringify(claim));
}

describe('helpers', () => {
  test('slug and branch name', () => {
    expect(slug('Walking skeleton: MCP server function')).toBe('walking-skeleton-mcp-server-function');
    expect(branchName({ id: 'MCP-112', title: 'Skeleton, function URL' })).toBe('feature/MCP-112-skeleton-function-url');
  });

  test('task ID comes only from a title or branch that starts with it', () => {
    expect(prTaskId('MCP-110: Delegated hosted zone')).toBe('MCP-110');
    expect(prTaskId('docs: Add MCP-111 note')).toBeUndefined();
    expect(branchTaskId('refs/heads/feature/MCP-110-zone')).toBe('MCP-110');
    expect(branchTaskId('feature/DOC-001-x')).toBeUndefined();
  });

  test('session policy is the allow-list without Sids and stays under the 2,048-character STS limit', () => {
    const policy = JSON.parse(sessionPolicy(JSON.parse(POLICY)));
    expect(policy.Statement.every((s) => !s.Sid)).toBe(true);
    expect(policy.Statement.some((s) => s.Action === '*' || (Array.isArray(s.Action) && s.Action.includes('*')))).toBe(false);
    expect(sessionPolicy(JSON.parse(POLICY)).length).toBeLessThanOrEqual(2048);
  });

  test('claude runs without AWS or GitHub token variables; the session settings carry them', () => {
    expect(launchEnv({ HOME: '/h', AWS_PROFILE: 'wb-mcp', AWS_ACCESS_KEY_ID: 'old', GH_TOKEN: 'roy', GITHUB_TOKEN: 'roy' })).toEqual({ HOME: '/h' });
    const guard = { sandbox: { enabled: true }, env: { KEEP: '1' } };
    expect(sessionSettings(guard, '/wt', { AccessKeyId: 'k', SecretAccessKey: 's', SessionToken: 't' }, 'pat')).toEqual({
      sandbox: { enabled: true },
      env: {
        KEEP: '1', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't',
        AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', GH_TOKEN: 'pat', GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0', npm_config_cache: '/wt/.npm-cache'
      }
    });
  });

  test('a working or blocked session is live only while it has a process', () => {
    expect(isLive({ state: 'working', pid: 1 })).toBe(true);
    expect(isLive({ state: 'blocked', pid: 1 })).toBe(true);
    expect(isLive({ state: 'blocked' })).toBe(false);
    expect(isLive({ state: 'stopped', pid: 1 })).toBe(false);
  });

  test('isStale uses the newest of commit, PR activity, start and resume', () => {
    const claim = { startedAt: iso(NOW - 10 * HOUR) };
    expect(isStale({ claim, lastCommitMs: NOW - 7 * HOUR, nowMs: NOW, staleHours: 6 })).toBe(true);
    expect(isStale({ claim, pr: { updatedAt: iso(NOW - HOUR) }, lastCommitMs: NOW - 7 * HOUR, nowMs: NOW, staleHours: 6 })).toBe(false);
    expect(isStale({ claim: { ...claim, resumedAt: iso(NOW - 2 * HOUR) }, nowMs: NOW, staleHours: 6 })).toBe(false);
  });

  test.each([
    [{ head_sha: MAIN_SHA, status: 'completed', conclusion: 'success' }, 'ok'],
    [{ head_sha: 'older', status: 'completed', conclusion: 'success' }, 'pending'],
    [{ head_sha: MAIN_SHA, status: 'waiting', conclusion: null }, 'pending'],
    [{ head_sha: MAIN_SHA, status: 'completed', conclusion: 'failure' }, 'failed'],
    [null, 'pending']
  ])('readDeploy: %j is %s', (deployRun, state) => {
    expect(readDeploy(world({ deployRun }).sh, repo).state).toBe(state);
  });

  test('fork PRs are filtered out by the GitHub query', () => {
    const w = world();
    run(w, { dryRun: true });
    const prCall = w.calls.find((c) => c.cmd === 'gh' && c.args.includes('--paginate'));
    expect(prCall.args[2]).toContain('base=main');
    expect(prCall.args[4]).toContain('select(.head.repo.full_name == "Manzia/wbank-documents-reports-mcp")');
  });
});

describe('dispatcher pass', () => {
  test('done from a merged PR title', () => {
    const lines = run(world());
    expect(line(lines, 'MCP-902')).toBe('MCP-902 skip: done');
    expect(line(lines, 'MCP-903')).toMatch(/started on feature\/MCP-903-local-ready-task$/);
  });

  test('an unmerged closed PR does not count as done', () => {
    const w = world({ prs: [{ number: 1, title: 'MCP-902: Local done task', state: 'closed', merged: false, updatedAt: iso(NOW) }] });
    const lines = run(w, { dryRun: true });
    expect(line(lines, 'MCP-902')).toMatch(/would start/);
    expect(line(lines, 'MCP-903')).toBe('MCP-903 skip: waiting for MCP-902');
  });

  test.each([
    ['claim file', () => { writeClaimFile({ id: 'MCP-905', branch: 'feature/MCP-905-x', startedAt: iso(NOW), resumes: 0, sessionId: 's' }); return {}; }, /running|resume/],
    ['local branch', () => ({ localBranches: ['feature/MCP-905-second-local-ready-task'] }), /taken \(local branch\)/],
    ['worktree', () => ({ worktrees: [join(repo, '.claude', 'worktrees', 'MCP-905')] }), /taken \(worktree\)/],
    ['branch on origin', () => ({ remote: ['feature/MCP-905-second-local-ready-task'] }), /taken \(branch on origin\)/],
    ['open PR', () => ({ prs: [...world().prs, { number: 7, title: 'MCP-905: Second local ready task', state: 'open', draft: true, merged: false, updatedAt: iso(NOW) }] }), /taken \(open PR #7\)/]
  ])('taken by %s is not started', (_name, setup, expected) => {
    const w = world(setup());
    const lines = run(w, { dryRun: true });
    expect(line(lines, 'MCP-905')).toMatch(expected);
    expect(line(lines, 'MCP-905')).not.toMatch(/would start/);
  });

  test('dependency gating', () => {
    const lines = run(world(), { dryRun: true });
    expect(line(lines, 'MCP-904')).toBe('MCP-904 skip: waiting for MCP-901');
  });

  test('an after_deploy task waits until the deploy for the head of main succeeded', () => {
    const pending = run(world({ deployRun: { head_sha: MAIN_SHA, status: 'waiting', conclusion: null } }), { dryRun: true });
    expect(line(pending, 'MCP-906')).toBe('MCP-906 skip: waiting for the prod deploy (deploy waiting)');
    const failed = run(world({ deployRun: { head_sha: MAIN_SHA, status: 'completed', conclusion: 'failure' } }), { dryRun: true });
    expect(line(failed, 'MCP-906')).toBe('MCP-906 skip: waiting for the prod deploy (last deploy failure)');
    // Capacity 2 goes to MCP-903 and MCP-905 first (file order); MCP-906 is ready, but no slot is left.
    const ok = run(world(), { dryRun: true });
    expect(line(ok, 'MCP-906')).toMatch(/no capacity/);
  });

  test('capacity is local_capacity minus running sessions of this repo only', () => {
    const w = world({ sessions: [{ name: 'MCP-800', state: 'working', pid: 1 }, { name: 'MCP-904', state: 'working', pid: 2 }, { name: 'other', state: 'working', pid: 3 }, { name: 'MCP-905', state: 'done' }] });
    const lines = run(w, { dryRun: true });
    expect(line(lines, 'MCP-903')).toMatch(/would start/);
    expect(line(lines, 'MCP-905')).toBe('MCP-905 skip: no capacity (local_capacity 2, 1 running)');
  });

  test('a session of another project with a task name does not count', () => {
    const w = world();
    const sh = w.sh;
    let agentsArgs;
    w.sh = (cmd, args, opts) => {
      if (cmd !== 'claude' || args[0] !== 'agents') return sh(cmd, args, opts);
      agentsArgs = args;
      return JSON.stringify([{ name: 'MCP-904', state: 'working', pid: 2, cwd: '/elsewhere/.claude/worktrees/MCP-904' }]);
    };
    const lines = run(w, { dryRun: true });
    expect(line(lines, 'MCP-905')).toMatch(/would start/);
    expect(agentsArgs).toEqual(['agents', '--json', '--cwd', join(repo, '.claude', 'worktrees')]);
  });

  test('pause by paused: true on origin/main', () => {
    const w = world({ tasks: FIXTURE.replace('paused: false', 'paused: true') });
    expect(run(w)).toEqual(['paused: paused: true in the task file on origin/main']);
    expect(claudeStarts(w)).toHaveLength(0);
  });

  test('pause by ~/.wbank-mcp-dispatch-paused', () => {
    writeFileSync(join(home, '.wbank-mcp-dispatch-paused'), '');
    const w = world();
    expect(run(w)).toEqual(['paused: ~/.wbank-mcp-dispatch-paused exists']);
    expect(w.calls).toHaveLength(0);
  });

  test('the lock stops an overlapping run and is released afterwards', () => {
    const { lock } = paths(home, repo);
    expect(acquireLock(lock, () => true)).toBe(true);
    const w = world();
    expect(run(w, { isAlive: () => true })).toEqual(['skipped: another dispatcher run holds the lock']);
    expect(w.calls).toHaveLength(0);
    rmSync(lock, { recursive: true });
    run(w);
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock left by a dead process is taken over', () => {
    const { lock } = paths(home, repo);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '999999');
    expect(acquireLock(lock, () => false)).toBe(true);
  });

  test('resume at most twice, then stale', () => {
    const claim = { id: 'MCP-905', title: 'Second local ready task', branch: 'feature/MCP-905-second-local-ready-task', worktree: join(repo, 'wt'), startedAt: iso(NOW - HOUR), resumes: 0, sessionId: 'sid-905' };
    writeClaimFile(claim);
    const notes = [];
    // Each resume starts a new session (session-MCP-905 in the fake); the second resume continues it
    const resumedIds = ['sid-905', 'session-MCP-905'];
    for (let i = 1; i <= MAX_RESUMES + 1; i += 1) {
      const w = world({ sessions: [{ name: 'MCP-905', sessionId: 'sid-905', state: 'stopped' }] });
      const lines = run(w);
      notes.push(line(lines, 'MCP-905'));
      if (i <= MAX_RESUMES) {
        const [resume] = startsFor(w, 'MCP-905');
        expect(resume.args).toEqual(expect.arrayContaining(['--bg', '--resume', resumedIds[i - 1], RESUME_PROMPT]));
        expect(sessionSettingsOf(resume).env.AWS_SESSION_TOKEN).toBe('fake-token');
        expect(sessionSettingsOf(resume).env.GH_TOKEN).toBe('github_pat_fake');
        expect(resume.opts.env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(resume.opts.env.GH_TOKEN).toBeUndefined();
        expect(readClaim('MCP-905').sessionId).toBe('session-MCP-905');
      } else {
        expect(startsFor(w, 'MCP-905')).toHaveLength(0);
        expect(w.calls.some((c) => c.cmd === 'osascript')).toBe(true);
      }
    }
    expect(notes).toEqual([
      'MCP-905 resumed (1 of 2)',
      'MCP-905 resumed (2 of 2)',
      'MCP-905 stale: session stopped without a ready PR after 2 resumes'
    ]);
  });

  test('a stopped session with a ready PR is finished, not resumed', () => {
    writeClaimFile({ id: 'MCP-905', branch: 'b', startedAt: iso(NOW), resumes: 0, sessionId: 's' });
    const w = world({ prs: [...world().prs, { number: 9, title: 'MCP-905: Second local ready task', state: 'open', draft: false, merged: false, updatedAt: iso(NOW) }] });
    expect(line(run(w), 'MCP-905')).toBe('MCP-905 finished: PR #9 is ready for review');
    expect(startsFor(w, 'MCP-905')).toHaveLength(0);
  });

  test('a running session with another ID than the claim updates the claim', () => {
    writeClaimFile({ id: 'MCP-905', branch: 'b', startedAt: iso(NOW), resumes: 1, sessionId: 'old-sid' });
    const w = world({ sessions: [{ name: 'MCP-905', sessionId: 'new-sid', state: 'working', pid: 7 }] });
    expect(line(run(w), 'MCP-905')).toBe('MCP-905 running (working)');
    expect(readClaim('MCP-905').sessionId).toBe('new-sid');
  });

  test('a blocked session is notified once per stale_hours', () => {
    const branch = 'feature/MCP-905-second-local-ready-task';
    writeClaimFile({ id: 'MCP-905', branch, startedAt: iso(NOW - HOUR), resumes: 0, sessionId: 'sid' });
    const sessions = [{ name: 'MCP-905', sessionId: 'sid', state: 'blocked', pid: 7 }];
    const first = world({ sessions, commitTimes: { [branch]: NOW - HOUR } });
    expect(line(run(first), 'MCP-905')).toBe('MCP-905 running (blocked)');
    const [note] = first.calls.filter((c) => c.cmd === 'osascript');
    expect(note.args[1]).toContain('MCP-905 needs you: claude attach MCP-905');
    const again = world({ sessions, commitTimes: { [branch]: NOW - HOUR } });
    run(again);
    expect(again.calls.filter((c) => c.cmd === 'osascript')).toHaveLength(0);
  });

  test('stale after stale_hours without commits or PR activity, notified once per period', () => {
    const branch = 'feature/MCP-905-second-local-ready-task';
    writeClaimFile({ id: 'MCP-905', branch, startedAt: iso(NOW - 20 * HOUR), resumes: 0, sessionId: 'old-sid' });
    const sessions = [{ name: 'MCP-905', sessionId: 'sid', state: 'working', pid: 7 }];
    const fresh = world({ sessions, commitTimes: { [branch]: NOW - 2 * HOUR } });
    expect(line(run(fresh), 'MCP-905')).toBe('MCP-905 running (working)');

    const old = world({ sessions, commitTimes: { [branch]: NOW - 7 * HOUR } });
    expect(line(run(old), 'MCP-905')).toBe('MCP-905 stale: no commit or PR activity for 6h');
    expect(old.calls.filter((c) => c.cmd === 'osascript')).toHaveLength(1);
    expect(readClaim('MCP-905')).toMatchObject({ sessionId: 'sid', staleNotifiedAt: iso(NOW) });

    const again = world({ sessions, commitTimes: { [branch]: NOW - 7 * HOUR } });
    run(again);
    expect(again.calls.filter((c) => c.cmd === 'osascript')).toHaveLength(0);
  });

  test('a blocked session whose process is gone is resumed, not counted as running', () => {
    const claim = { id: 'MCP-905', title: 'Second local ready task', branch: 'feature/MCP-905-second-local-ready-task', worktree: join(repo, 'wt'), startedAt: iso(NOW - HOUR), resumes: 0, sessionId: 'sid-905' };
    writeClaimFile(claim);
    const w = world({ sessions: [{ name: 'MCP-905', sessionId: 'sid-905', state: 'blocked' }] });
    expect(line(run(w), 'MCP-905')).toBe('MCP-905 resumed (1 of 2)');
    expect(startsFor(w, 'MCP-905')[0].args).toEqual(expect.arrayContaining(['--resume', 'sid-905']));
  });

  test('clean-up of a done task removes its worktree, branch, claim file and session settings', () => {
    const wt = join(repo, '.claude', 'worktrees', 'MCP-902');
    const p = paths(home, repo);
    mkdirSync(p.sessions, { recursive: true });
    writeFileSync(join(p.sessions, 'MCP-902.json'), '{}');
    writeClaimFile({ id: 'MCP-902', branch: 'feature/MCP-902-local-done-task', startedAt: iso(NOW), resumes: 0 });
    const w = world({ worktrees: [wt], localBranches: ['feature/MCP-902-local-done-task'] });
    expect(line(run(w), 'MCP-902')).toBe('MCP-902 cleaned up: done (claim file, local branch, worktree)');
    const gitArgs = w.calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2).join(' '));
    expect(gitArgs).toContain(`worktree remove --force ${wt}`);
    expect(gitArgs).toContain('branch -D feature/MCP-902-local-done-task');
    expect(existsSync(join(claimsDir(), 'MCP-902.json'))).toBe(false);
    expect(existsSync(join(p.sessions, 'MCP-902.json'))).toBe(false);
  });

  test('human tasks are never selected', () => {
    const w = world({ tasks: FIXTURE.replace(/runs: local/g, 'runs: human') });
    const lines = run(w);
    expect(lines.every((l) => /skip: runs: human/.test(l))).toBe(true);
    expect(claudeStarts(w)).toHaveLength(0);
  });

  test('a task with any other runs value is never selected', () => {
    const w = world({ tasks: FIXTURE.replace('runs: local, depends: []', 'runs: cloud, depends: []') });
    expect(line(run(w, { dryRun: true }), 'MCP-902')).toBe('MCP-902 skip: runs: cloud');
  });

  test('the task file is read from origin/main, not the working copy', () => {
    mkdirSync(join(repo, 'context', 'tasks'), { recursive: true });
    writeFileSync(join(repo, FILES.tasks), FIXTURE.replace('paused: false', 'paused: true'));
    const w = world();
    const lines = run(w, { dryRun: true });
    expect(lines).toHaveLength(7);
    expect(w.calls.find((c) => c.cmd === 'git' && c.args[2] === 'show').args[3]).toBe(`origin/main:${FILES.tasks}`);
    expect(w.calls[0].args.slice(2)).toEqual(['fetch', '--prune', 'origin']);
  });

  test('without the session GitHub token in the Keychain nothing starts (fail closed)', () => {
    const w = world({ token: '' });
    const s = { out: [], err: [] };
    const code = main({ argv: ['--now'], env: { HOME: home }, sh: w.sh, repo, now: () => NOW, stdout: { write: (x) => s.out.push(x) }, stderr: { write: () => {} } });
    expect(code).toBe(1);
    expect(s.out.join('')).toContain(`Keychain item "${GITHUB_TOKEN_SERVICE}" is missing`);
    expect(claudeStarts(w)).toHaveLength(0);
    expect(w.calls.some((c) => c.cmd === 'aws')).toBe(false);
  });

  test('starting a task claims, guards and launches the session from origin/main files', () => {
    const w = world();
    run(w);
    const branch = 'feature/MCP-903-local-ready-task';
    const wt = join(repo, '.claude', 'worktrees', 'MCP-903');
    const gitArgs = w.calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2).join(' '));
    expect(gitArgs).toContain(`worktree add -b ${branch} ${wt} origin/main`);
    expect(gitArgs).toContain(`config branch.${branch}.remote origin`);

    const p = paths(home, repo);
    expect(readFileSync(p.settings, 'utf8')).toBe(SETTINGS);
    expect(readFileSync(p.guard, 'utf8')).toBe(`content of ${FILES.guard}\n`);
    expect(readFileSync(p.instructions, 'utf8')).toBe(`content of ${FILES.instructions}\n`);

    const sts = w.calls.find((c) => c.cmd === 'aws');
    expect(sts.args).toEqual(expect.arrayContaining(['sts', 'get-federation-token', '--profile', 'wb-mcp', '--duration-seconds', '129600']));
    expect(JSON.parse(sts.args[sts.args.indexOf('--policy') + 1])).toEqual(JSON.parse(sessionPolicy(JSON.parse(POLICY))));

    const keychain = w.calls.find((c) => c.cmd === 'security');
    expect(keychain.args).toEqual(['find-generic-password', '-s', GITHUB_TOKEN_SERVICE, '-w']);

    const start = claudeStarts(w).find((c) => c.args.includes('MCP-903'));
    const settingsFile = join(p.sessions, 'MCP-903.json');
    expect(start.args.slice(0, 9)).toEqual(['--bg', '-n', 'MCP-903', '--permission-mode', 'auto', '--settings', settingsFile, '--append-system-prompt-file', p.instructions]);
    expect(start.args[9]).toContain('"MCP-903: Local ready task"');
    expect(start.args[9]).toContain('into main');
    expect(start.opts.cwd).toBe(wt);
    // No AWS or token variable reaches claude: a background service it starts would hand them to every later session
    expect(Object.keys(start.opts.env).filter((k) => k.startsWith('AWS_') || k === 'GH_TOKEN')).toEqual([]);
    const settings = sessionSettingsOf(start);
    expect(settings).toMatchObject({ ...JSON.parse(SETTINGS), env: { AWS_ACCESS_KEY_ID: 'FAKEKEYID', AWS_SESSION_TOKEN: 'fake-token', GH_TOKEN: 'github_pat_fake', npm_config_cache: join(wt, '.npm-cache') } });
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);

    const claim = readClaim('MCP-903');
    expect(claim).toMatchObject({ id: 'MCP-903', branch, worktree: wt, resumes: 0, sessionId: 'session-MCP-903' });
    expect(JSON.stringify(claim)).not.toContain('fake-secret');
    expect(JSON.stringify(claim)).not.toContain('github_pat_fake');
  });
});

describe('selfTest', () => {
  test('starts a guarded foreground session in a detached worktree and removes it', () => {
    const w = world();
    selfTest({ sh: w.sh, env: { HOME: home, GH_TOKEN: 'roy' }, home, repo, now: () => NOW });
    const wt = join(repo, '.claude', 'worktrees', 'SELFTEST');
    const gitArgs = w.calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2).join(' '));
    expect(gitArgs).toContain(`worktree add --detach ${wt} origin/main`);
    expect(gitArgs[gitArgs.length - 1]).toBe(`worktree remove --force ${wt}`);
    const session = claudeStarts(w)[0];
    expect(session.args).toContain('--settings');
    expect(Object.keys(session.opts.env).filter((k) => k.startsWith('AWS_') || k === 'GH_TOKEN')).toEqual([]);
    expect(existsSync(join(paths(home, repo).sessions, 'SELFTEST.json'))).toBe(false);
    expect(session.args).not.toContain('--bg');
    expect(session.opts.stdio).toBe('inherit');
  });
});

describe('main', () => {
  const io = () => {
    const out = [];
    const err = [];
    return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  };

  test('rejects unknown flags', () => {
    const s = io();
    expect(main({ argv: ['--force'], env: { HOME: home }, sh: world().sh, repo, ...s })).toBe(64);
    expect(s.err.join('')).toContain('Usage');
  });

  test('logs decisions with a timestamp when not a dry run, and never a credential', () => {
    const s = io();
    expect(main({ argv: ['--now'], env: { HOME: home }, sh: world().sh, repo, now: () => NOW, ...s })).toBe(0);
    const log = readFileSync(paths(home, repo).log, 'utf8');
    expect(log).toContain(`${iso(NOW)} MCP-900 skip: runs: human`);
    expect(log).not.toContain('fake-secret');
    expect(log).not.toContain('github_pat_fake');
  });

  test('a failing command is logged and exits 1', () => {
    const s = io();
    const sh = () => { throw new Error('fetch failed\nmore'); };
    expect(main({ argv: ['--dry-run'], env: { HOME: home }, sh, repo, ...s })).toBe(1);
    expect(s.out).toEqual(['error: fetch failed\n']);
  });
});

describe('classify', () => {
  test('a done task with nothing local is a plain skip', () => {
    const state = { done: new Set(['MCP-1']), claims: new Map(), localBranches: new Map(), worktrees: new Map(), remoteBranches: new Set(), openPrs: new Map() };
    expect(classify({ id: 'MCP-1', runs: 'local' }, state)).toEqual({ kind: 'skip', reason: 'done' });
  });
});
