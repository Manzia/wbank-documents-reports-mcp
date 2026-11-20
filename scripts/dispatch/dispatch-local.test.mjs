import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./dispatch-local.sh', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/tasks.yaml', import.meta.url));

// Stub gh, git, claude, aws and security that log every call and answer the dispatcher's reads.
const STUBS = {
  git: `case "$*" in
  *" show origin/main:context/tasks/wbank-mcp-tasks.yaml") cat "$FIXTURE" ;;
  *" worktree list --porcelain") echo "worktree /repo" ;;
  *" rev-parse origin/main") echo "mainsha" ;;
esac`,
  gh: `case "$*" in
  *"/actions/workflows/"*) echo '{"head_sha":"mainsha","status":"completed","conclusion":"success"}' ;;
  *) echo '{"number":1,"title":"MCP-902: Local done task","state":"closed","draft":false,"merged":true,"updatedAt":"2026-11-20T00:00:00Z"}' ;;
esac`,
  claude: '[ "$1 $2" = "agents --json" ] && echo "[]"',
  aws: 'exit 1',
  security: 'exit 1'
};

let dir;
let home;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-bin-'));
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >> "$CALLS"\n${body}\nexit 0\n`);
    chmodSync(join(dir, name), 0o755);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('--dry-run prints one decision per task and changes nothing', () => {
  const calls = join(dir, 'calls.log');
  const stdout = execFileSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: home, CALLS: calls, FIXTURE: fixture }
  });

  expect(stdout.trim().split('\n')).toEqual([
    'MCP-900 skip: runs: human',
    'MCP-901 skip: runs: human',
    'MCP-902 skip: done',
    'MCP-903 would start on feature/MCP-903-local-ready-task',
    'MCP-904 skip: waiting for MCP-901',
    'MCP-905 would start on feature/MCP-905-second-local-ready-task',
    'MCP-906 skip: no capacity (local_capacity 2, 0 running)'
  ]);

  const log = readFileSync(calls, 'utf8').trim().split('\n');
  expect(log.filter((c) => /^git .*\bworktree (add|remove|prune)\b/.test(c))).toEqual([]);
  expect(log.filter((c) => /^git .*\b(branch|config|push)\b/.test(c))).toEqual([]);
  expect(log.filter((c) => c.startsWith('claude ') && !c.startsWith('claude agents --json'))).toEqual([]);
  expect(log.filter((c) => c.startsWith('aws ') || c.startsWith('security '))).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});
