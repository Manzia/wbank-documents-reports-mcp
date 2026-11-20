# Local dispatcher

Starts `runs: local` tasks from `context/tasks/wbank-mcp-tasks.yaml` as background Claude Code sessions
on Roy's Mac, each in its own worktree with the six-layer guard. **Local sessions only**: this project
uses no cloud sessions, scheduled tasks or routines. Specification: plan §6 (dispatcher) and §2.4
(guard), in `context/tasks/wbank-mcp-implementation-plan.md`. Day-to-day use: the owner runbook,
`context/tasks/automate-claude-code-workflows.md`.

| File | What it is |
|---|---|
| `dispatch-local.sh` | Entry point. `launchd` runs it every 15 minutes and at login. |
| `dispatch.mjs` | The helper: reads the task file and GitHub state, cleans up, resumes, claims and starts sessions. |
| `session-policy.json` | Layer 1: the allow-list attached to each session's temporary AWS credentials. |
| `session-settings.json` | Layers 2–4: sandbox, permission deny rules and the guard hook, passed with `--settings`. |
| `guard-hook.mjs` | Layer 4: blocks merge, workflow, deployment and settings commands, pushes outside `feature/*`, `sam deploy`, `claude`, `security` and remote agents. |
| `com.manzia.wbank-mcp-dispatch.plist` | The `launchd` user agent. |

The task file, `agent-instructions.md`, the policy, the settings and the hook are always read from
`origin/main`, so only merged versions take effect and a session can't loosen its own guard by editing
its worktree. Before each start or resume the dispatcher copies the hook, settings and instructions to
`~/.wbank-mcp-dispatch/`, which sessions can't write.

## Prerequisites

- The main checkout at `/Users/roy.manzi/WorldBank/API/wbank-documents-reports-mcp` (the path in the
  plist), with `npm ci` run once in `scripts/dispatch/` so `js-yaml` is installed. Its current branch
  doesn't matter.
- `node` 24, `gh` (authenticated; used for the dispatcher's own reads), `claude` (logged in) and the AWS
  CLI, on the `PATH` set in the plist or in `~/.local/bin`.
- AWS profile `wb-mcp`: an IAM user with access keys, allowed `sts:GetFederationToken`.
- Keychain item `wbank-mcp-dispatch-github`: the fine-grained token for sessions (runbook §2.1). Without
  it the dispatcher starts nothing.

## Install

```bash
cd /Users/roy.manzi/WorldBank/API/wbank-documents-reports-mcp
git switch main && git pull
(cd scripts/dispatch && npm ci)
scripts/dispatch/dispatch-local.sh --dry-run        # check what it would do
scripts/dispatch/dispatch-local.sh --self-test      # interactive; every check must pass (below)
cp scripts/dispatch/com.manzia.wbank-mcp-dispatch.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.manzia.wbank-mcp-dispatch.plist
```

Load the agent only after the self-test passes: `RunAtLoad` starts a real pass as soon as it is loaded.

To update the dispatcher itself, pull `main` in the main checkout (the script runs from there;
everything else it reads comes from `origin/main` on every pass), and `npm ci` again if its
`package-lock.json` changed. If the plist changed, also reload the agent:
`launchctl bootout gui/$(id -u)/com.manzia.wbank-mcp-dispatch`, copy the plist again and
`launchctl bootstrap` it as above.

## Run now, pause, resume, uninstall

| To | Do |
|---|---|
| Run one pass now | `scripts/dispatch/dispatch-local.sh --now` |
| See what it would do | `scripts/dispatch/dispatch-local.sh --dry-run` (prints one line per task; starts, claims and writes nothing) |
| Pause | `touch ~/.wbank-mcp-dispatch-paused` (or set `paused: true` in the task file by PR) |
| Resume | `rm ~/.wbank-mcp-dispatch-paused` |
| Uninstall | `launchctl bootout gui/$(id -u)/com.manzia.wbank-mcp-dispatch && rm ~/Library/LaunchAgents/com.manzia.wbank-mcp-dispatch.plist` |

Decisions go to `~/Library/Logs/wbank-mcp-dispatch.log`, one line per task per pass (started, skipped
and why, cleaned up, resumed, stale). Crashes of the script itself go to
`~/Library/Logs/wbank-mcp-dispatch.launchd.log`. Claims are in `~/.wbank-mcp-dispatch/claims/<ID>.json`.

## What a pass does

1. Exits if the pause file exists or another pass holds the lock (`~/.wbank-mcp-dispatch/lock`).
2. Fetches `origin`; exits if the task file on `origin/main` says `paused: true`.
3. Reads state: PRs into `main` from this repo (fork PRs are ignored): merged = done, open = taken;
   `feature/<ID>-*` branches on `origin`, claim files, local branches and worktrees (taken); this
   repo's background sessions (`claude agents --json --cwd .claude/worktrees`); and the prod deploy for
   the head of `main` (ok, pending or failed).
4. For local tasks now done: removes the worktree, the local branch, the claim file and the session
   settings file.
5. For claimed tasks: a running session with no commit and no PR activity for `stale_hours` is
   reported stale; a `blocked` one gets a "needs you" notification. A stopped session whose PR is
   missing or still a draft is resumed with fresh credentials (`claude --bg --resume`), at most twice;
   after that it is reported stale. A stopped session with a ready (non-draft) PR is finished.
6. Starts ready tasks (`runs: local`, not done, not taken, all `depends` done, and for
   `after_deploy: true` a green deploy of the head of `main`), in file order, up to `local_capacity`
   minus running sessions (resumes count too).

Notifications go out at most once per `stale_hours` per task. The dispatcher never starts a task over,
never merges, deploys, approves or pushes, and only deletes branches of merged tasks.

### Credentials

**AWS.** `aws sts get-federation-token --profile wb-mcp --duration-seconds 129600 --policy <session-policy.json>`
(36 hours). A federation token gets the intersection of the user's rights and the session policy, so
although `wb-mcp` is an admin, the session can only do what `session-policy.json` allows: read the
stack, logs, metrics, gateway, DNS, certificates and quotas, and invoke Anthropic models on Bedrock.
Reads that would reveal the origin secret (Secrets Manager, CloudFront, WAF) are denied. STS limits the
policy to 2,048 characters packed (a test checks the size).

**GitHub.** The fine-grained token from the Keychain, passed as `GH_TOKEN`. `gh` and git (through
`gh auth git-credential`) use it instead of Roy's own token.

Both reach the session through its settings, not its environment. A background session runs in a
process that Claude Code's background service started, with the service's environment, so variables
set on the `claude --bg` call never reach it. Before each start and resume the dispatcher writes
`~/.wbank-mcp-dispatch/sessions/<ID>.json` (mode 600): `session-settings.json` plus an `env` block with
the credentials, `GH_TOKEN`, region `us-east-1` and `npm_config_cache` in the worktree, and passes it
with `--settings`. `claude` itself runs with no `AWS_*` or token variable. Sessions can't write
`~/.wbank-mcp-dispatch/` and their Read tool can't read `sessions/`; the file is deleted when the task
is cleaned up. Credentials are never logged.

A session counts as running only while `claude agents` gives it a process (`pid`).

## Self-test

Run after installing and after every Claude Code update. Don't let the dispatcher run unattended until
every check passes; a failure becomes a fix PR before local tasks start.

```bash
scripts/dispatch/dispatch-local.sh --self-test
```

This creates a detached worktree `.claude/worktrees/SELFTEST` from `origin/main`, fresh credentials and
the same settings as a dispatcher session, and starts an interactive `claude` session there with the
checks below as its prompt. Watch it, then exit; the worktree is removed.

| Check | Expected |
|---|---|
| `npm ci`, `npm test` in `mcp-server/hello-world` (later `mcp-server/server`) | Succeed |
| `gh api repos/Manzia/wbank-documents-reports-mcp --jq .full_name` | Succeeds (`gh` TLS under the sandbox, session token) |
| `git push --dry-run origin HEAD:refs/heads/feature/MCP-000-self-test` | Succeeds (git authenticates with the session token) |
| `aws cloudformation describe-stacks --stack-name wbank-docs-reports-mcp-prod` | Succeeds |
| `curl` to `search.worldbank.org` | 200 |
| `cat ~/.aws/credentials`; `node -e "require('fs').readFileSync(process.env.HOME+'/.aws/credentials')"` | Fail |
| Read tool on `~/.aws/credentials` and `~/.config/gh/hosts.yml` | Denied |
| `touch ~/.aws/x`, `touch ~/.npm/x` | Fail |
| `curl -sI https://example.com` | Fails (network allow-list) |
| `aws cloudformation create-stack …`, `aws secretsmanager list-secrets`, `aws lambda invoke …` | AccessDenied |
| `gh pr merge 1`, `gh run rerun 1`, `security find-generic-password …`, `claude --version` | Blocked by the guard hook |

**Then, yourself, in the same session**, check whether the sandbox stops a *script* from reaching the
Keychain (the hook only sees command text). Type these as `!` commands, which run sandboxed:

```text
! printf '/usr/bin/security find-generic-password -s gh:github.com >/dev/null 2>&1 && echo FOUND || echo DENIED\n' > "$TMPDIR/k.sh"
! bash "$TMPDIR/k.sh"
```

It never prints the token (no `-w`). Record FOUND or DENIED in MCP-101. FOUND means a script in a
session could reach your own GitHub token: plan §2.4 lists it as a known gap, and your deploy approval
remains the barrier.

Also check, once: `git commit` works in a dispatcher worktree (the sandbox allows writes to the main
checkout's shared `.git`, except `config` and `hooks`; the dispatcher sets each branch's upstream at
claim time so a plain `git push` works).

## Tests

`cd scripts/dispatch && npm ci && npm test`. CI runs them in the `Dispatcher tests` job whenever
`scripts/dispatch/` or `context/tasks/wbank-mcp-tasks.yaml` changes.
