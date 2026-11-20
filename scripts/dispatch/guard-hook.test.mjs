import { describe, expect, test } from '@jest/globals';
import { apiMethod, checkAgent, checkCommand, main, pushTargets, readCurrentBranch, tokenize } from './guard-hook.mjs';

const onBranch = (branch) => ({ currentBranch: () => branch });
const R = 'repos/Manzia/wbank-documents-reports-mcp';

describe('checkCommand', () => {
  test.each([
    // merging, approving deploys, starting or re-running workflows
    'gh pr merge 12',
    'gh pr merge 12 --squash --admin',
    'gh workflow run deploy.yml',
    'gh workflow enable deploy.yml',
    'gh run rerun 123',
    'gh run cancel 123',
    `gh api -X PUT ${R}/pulls/12/merge`,
    `gh api -X POST ${R}/merges -f base=main -f head=feature/x`,
    `gh api -X POST ${R}/actions/workflows/ci.yml/dispatches`,
    `gh api -X POST ${R}/actions/runs/1/pending_deployments -f state=approved`,
    `gh api ${R}/actions/runs/1/rerun -X POST`,
    `gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'`,
    // repo settings, protections, secrets, refs
    `gh api -X PUT ${R}/branches/main/protection`,
    `gh api ${R}/environments/production`,
    `gh api -X PATCH ${R}/git/refs/heads/main -f sha=abc`,
    `gh api -X PUT ${R}/contents/README.md`,
    `gh api -X DELETE ${R}/issues/comments/1`,
    'gh secret set X',
    'gh variable set AWS_DEPLOY_ROLE_ARN',
    'gh repo edit --visibility private',
    'gh auth token',
    'gh alias set m "pr merge"',
    'gh extension install someone/ext',
    // pushes
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin +feature/MCP-110-x',
    'git push origin feature/x:refs/heads/main',
    'git push --all origin',
    'git push --tags',
    'git push --force',
    'git push -f origin feature/MCP-110-x',
    'git push origin --delete feature/MCP-110-x',
    'git push origin :feature/MCP-110-x',
    'git push origin release-1',
    'cd /tmp && git push origin main',
    'git -C ../repo push origin main',
    'FOO=1 git push origin main',
    'env git push origin main',
    '/usr/bin/git push origin main',
    // deploys, nested sessions, keychain
    'sam deploy --no-confirm-changeset',
    'sam sync --watch',
    'sam delete',
    'claude --cloud "do it"',
    'npx something && claude -p hi',
    'echo $(claude -p hi)',
    'security find-generic-password -s gh:github.com -w',
    '/usr/bin/security dump-keychain',
    // wrappers, nested shells and flag spellings (security review, PR #4)
    'bash -c "gh pr merge 1"',
    "sh -lc 'git push origin main'",
    'bash -c "cd x && gh pr merge 1"',
    'zsh -c "bash -c \'gh workflow run deploy.yml\'"',
    'eval "gh pr merge 1"',
    'env -S "gh pr merge 1"',
    'env FOO=1 gh pr merge 1',
    'sudo -u roy gh pr merge 1',
    'timeout 30 gh pr merge 1',
    'echo 1 | xargs -I{} gh pr merge {}',
    'xargs gh pr merge < ids.txt',
    'gh -R Manzia/wbank-documents-reports-mcp pr merge 1',
    'gh --repo=Manzia/x pr merge 1',
    'gh pr -R Manzia/x merge 1',
    `gh api -XPUT ${R}/issues/1/labels`,
    `gh api --method=DELETE ${R}/issues/comments/1`,
    `gh api --method delete ${R}/issues/comments/1`,
    'git push -fu origin feature/MCP-110-x',
    'git push -uf origin feature/MCP-110-x',
    'git push -df origin feature/MCP-110-x',
    'git -c alias.p=push p origin main'
  ])('blocks %s', (command) => {
    expect(checkCommand(command, onBranch('feature/MCP-110-hosted-zone')).allowed).toBe(false);
  });

  test.each([
    'git push -u origin feature/MCP-110-hosted-zone',
    'git push --force-with-lease origin feature/MCP-110-hosted-zone',
    'git push origin HEAD',
    'git push',
    'gh pr create --draft --base main --title "MCP-110: Delegated hosted zone"',
    'gh pr ready 12',
    'gh pr edit 12 --body-file body.md',
    'gh pr view 12 --comments',
    'gh pr checks 12',
    'gh run list --workflow deploy.yml',
    'gh run view 123 --log-failed',
    `gh api ${R}/pulls`,
    `gh api ${R}/commits/abc/check-runs`,
    `gh api ${R}/issues/12/comments -f body=hi`,
    'git status',
    'npm test',
    'sam validate',
    'sam build --parallel',
    'echo "git push origin main is blocked"',
    'bash -c "npm test"',
    'bash scripts/build.sh',
    'git push -u origin feature/MCP-110-hosted-zone',
    'git -c user.name=x commit -m msg',
    'timeout 60 npm test',
    `gh api -XGET ${R}/pulls`
  ])('allows %s on a feature branch', (command) => {
    expect(checkCommand(command, onBranch('feature/MCP-110-hosted-zone'))).toEqual({ allowed: true });
  });

  test.each(['git push', 'git push origin HEAD'])('blocks %s while on main', (command) => {
    expect(checkCommand(command, onBranch('main')).allowed).toBe(false);
  });

  test('sam deploy gets a readable message', () => {
    expect(checkCommand('sam deploy').message).toMatch(/deploy pipeline after Roy merges and approves/);
  });
});

describe('checkAgent', () => {
  test('blocks remote (cloud) agents and allows local subagents', () => {
    expect(checkAgent({ isolation: 'remote', prompt: 'x' }).allowed).toBe(false);
    expect(checkAgent({ isolation: 'worktree', prompt: 'x' })).toEqual({ allowed: true });
    expect(checkAgent({ prompt: 'x' })).toEqual({ allowed: true });
  });
});

describe('helpers', () => {
  test('tokenize strips quotes (also stray ones) and leading env assignments', () => {
    expect(tokenize('A=1 B=2 git commit -m "a b"')).toEqual(['git', 'commit', '-m', 'a b']);
    expect(tokenize(' gh pr merge 1"')).toEqual(['gh', 'pr', 'merge', '1']);
  });

  test('apiMethod reads every spelling', () => {
    expect(apiMethod(['gh', 'api', '-X', 'put'])).toBe('PUT');
    expect(apiMethod(['gh', 'api', '-XDELETE'])).toBe('DELETE');
    expect(apiMethod(['gh', 'api', '--method=patch'])).toBe('PATCH');
    expect(apiMethod(['gh', 'api', 'x'])).toBeUndefined();
  });

  test('nesting beyond the limit fails closed', () => {
    expect(checkCommand('bash -c ls', {}, 4).allowed).toBe(false);
    expect(checkCommand('bash -c ls', {}, 3)).toEqual({ allowed: true });
  });

  test('pushTargets reads destinations and skips option values', () => {
    expect(pushTargets(['--repo', 'x', 'origin', 'a:b', 'c'])).toEqual({ refs: ['b', 'c'] });
    expect(pushTargets(['--mirror'])).toEqual({ bulk: '--mirror', refs: [] });
    expect(pushTargets(['origin', ':x'])).toEqual({ remove: true, refs: [] });
  });

  test('readCurrentBranch returns undefined outside a repo', () => {
    expect(readCurrentBranch('/nonexistent-dir')).toBeUndefined();
  });
});

describe('main', () => {
  const run = (input) => {
    const err = [];
    const code = main({ input, stderr: { write: (s) => err.push(s) }, currentBranch: () => 'feature/x' });
    return { code, err: err.join('') };
  };

  test('blocks a Bash command with exit 2 and a message on stderr', () => {
    const { code, err } = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 12' }, cwd: '/w' }));
    expect(code).toBe(2);
    expect(err).toContain('Blocked by the dispatcher guard');
  });

  test('blocks a remote Agent call', () => {
    expect(run(JSON.stringify({ tool_name: 'Agent', tool_input: { isolation: 'remote', prompt: 'x' } })).code).toBe(2);
  });

  test('allows with exit 0', () => {
    expect(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -u origin feature/x' } }))).toEqual({ code: 0, err: '' });
    expect(run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x' } })).code).toBe(0);
  });

  test('ignores input it cannot read', () => {
    expect(run('not json').code).toBe(0);
    expect(run('{}').code).toBe(0);
  });
});
