# Owner Runbook — Automated Claude Code Workflow (World Bank MCP Build)

**For:** Roy (owner)
**Plan:** `context/tasks/wbank-mcp-implementation-plan.md` · **Tasks:** `context/tasks/wbank-mcp-tasks.yaml` · **Agent rules:** `context/tasks/agent-instructions.md` · **Dispatcher:** `scripts/dispatch/README.md`

---

## 1. How the Workflow Works

- **The plan is a list of tasks** in `wbank-mcp-tasks.yaml`. Each task says where it runs (`local` or
  `human`) and which tasks it depends on.
- **Local sessions only.** There are no cloud sessions, scheduled tasks or routines for this project.
  Local tasks are started by a small dispatcher script that `launchd` runs every 15 minutes while your
  Mac is awake. Each one runs as a background Claude Code session (CLI) in its own git worktree, and
  opens a PR.
- **Human tasks** are yours: setup, the DNS delegation, connector checks in the three web apps,
  reviewing evaluation results, sign-off, and the least-privilege switch.
- **GitHub is the shared record.** A task is done when its PR (title `MCP-1xx: …`) is merged into
  `main`. **You merge every PR**, and your merges are what unblock the next tasks.
- **Deploys need your merge and your approval.** A merge that touches `mcp-server/` starts the prod
  deploy, which waits at **Review deployments → Approve**. Sessions are guarded in six layers
  (plan §2.4):
  1. temporary AWS credentials with an allow-list policy: read the stack and invoke Claude on Bedrock,
     nothing else;
  2. the macOS sandbox, so your real keys in `~/.aws` and your GitHub token file are unreadable by
     anything they run, and the network is limited to AWS, GitHub, npm and the World Bank hosts;
  3. permission rules, so Claude's file tools can't read those files either;
  4. a hook that blocks merging, workflow and deployment commands, pushes outside `feature/*`,
     `claude` commands, cloud agents and the Keychain;
  5. a GitHub token for this repo only, with no right to approve deployments or change settings;
  6. GitHub's own protections on `main` and the `production` environment.
  None of this applies to your own Claude sessions.
- **One rules file**, `agent-instructions.md`, governs every session (it's in their system prompt).
  Change it by PR; it applies to new sessions and resumes once merged.

```text
 you merge a PR ─► CI ─► (stack changed) deploy waits ─► you approve ─► prod deploy
                └─► dispatcher starts unblocked local tasks (within 15 min, Mac awake)
                └─► verification tasks start once the deploy is green
 sessions work ─► draft PR ─► ready PR ─► you review ─► you merge ─► …
```

---

## 2. One-Time Setup (MCP-101, after MCP-100 is merged)

### 2.1 Install

Install the `launchd` agent **last**: it has `RunAtLoad`, so loading it starts a real pass at once.

1. **Session GitHub token.** GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   - Resource owner `Manzia`; **Only select repositories** → `wbank-documents-reports-mcp`;
     expiration **90 days**.
   - Repository permissions: **Contents** read and write, **Pull requests** read and write,
     **Workflows** read and write, **Actions** read, **Checks** read, **Commit statuses** read
     (Metadata read is automatic). Nothing else.
   - Store it in the Keychain (it prompts for the token, so it never lands in your shell history):
     `security add-generic-password -a "$USER" -s wbank-mcp-dispatch-github -w`
2. **Check the token's limits.** All three must fail with **403**:
   ```bash
   R=repos/Manzia/wbank-documents-reports-mcp
   T=$(security find-generic-password -s wbank-mcp-dispatch-github -w)
   # No Administration permission
   GH_TOKEN=$T gh api $R/branches/main/protection
   # No Environments / Secrets permission
   GH_TOKEN=$T gh api $R/environments/production/secrets
   # No Deployments permission: it can't review (approve or reject) a deployment.
   # Uses the newest Deploy Pipeline run, which has already finished, and state=rejected,
   # so nothing can change even if the call were allowed.
   RUN=$(gh run list --workflow deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
   ENV=$(gh api $R/environments/production --jq .id)
   GH_TOKEN=$T gh api -X POST $R/actions/runs/$RUN/pending_deployments \
     -F "environment_ids[]=$ENV" -f state=rejected -f comment="token permission check"
   unset T
   ```
   A **422** on the last call (instead of 403) means the token *can* review deployments: delete it
   and create it again without the Deployments permission.
3. **Alert e-mail:** GitHub → Settings → Environments → `production` → add variable `ALERT_EMAIL`
   (used from MCP-140).
4. **Dispatcher dependencies:** `cd scripts/dispatch && npm ci` in the main checkout
   (`/Users/roy.manzi/WorldBank/API/wbank-documents-reports-mcp`). Its current branch doesn't matter;
   the dispatcher reads everything from `origin/main`.
5. **Dry run:** `scripts/dispatch/dispatch-local.sh --dry-run`. Expect MCP-102, MCP-110 and MCP-120
   waiting for MCP-101 and nothing else ready.
6. **Self-test**, in a terminal window of its own (it opens an interactive session):
   `scripts/dispatch/dispatch-local.sh --self-test`. Every check in the README's table must pass. If one
   fails, fix it by PR (with your own Claude session) and run the self-test again.
7. Only when every check passes, install the agent (README, Install).
8. **Merge MCP-101** (its record). That merge unblocks MCP-102, MCP-110 and MCP-120; the next pass
   starts two of them (`local_capacity` 2).

### 2.2 Ongoing upkeep

| When | Do |
|---|---|
| After every Claude Code update | Run the self-test again (README). Sandbox behaviour can change between versions. |
| Every 90 days (token expiry) | Create a new token as in §2.1 step 1, then update the Keychain item: `security add-generic-password -U -a "$USER" -s wbank-mcp-dispatch-github -w`. Sessions that hit the expiry have marked their PR **Blocked: token expired**: `claude attach <ID>` and tell them to push again. |
| The `wb-mcp` access keys are rotated | Nothing else to change: the dispatcher uses the profile, not the keys. |

---

## 3. Day to Day

Sessions act as your GitHub user, so GitHub doesn't notify you about their PRs. Bookmark:

- **Ready to review:** `https://github.com/Manzia/wbank-documents-reports-mcp/pulls?q=is:pr+is:open+base:main+draft:false`
- **In progress:** `https://github.com/Manzia/wbank-documents-reports-mcp/pulls?q=is:pr+is:open+draft:true`

| When | Do |
|---|---|
| A macOS notification says "`MCP-1xx` needs you" | `claude attach MCP-1xx`, read the question (also at the top of its draft PR as **Blocked:**), answer, detach. It continues in the background. |
| A PR is ready for review | Review it on GitHub (§5). For changes, write PR review comments, then `claude attach <ID>` and tell it to address them; or answer in the attached session directly. |
| A notification says a task is **stale** | No commit or PR activity for 6 hours, or the session stopped twice without a ready PR. `claude attach <ID>` to see where it is. To start it over: `claude stop <ID>`, close its PR, delete its branch, remove `~/.wbank-mcp-dispatch/claims/<ID>.json`, and run `git worktree remove --force .claude/worktrees/<ID>` and `git branch -D <branch>` in the main checkout. The next pass starts it fresh. |
| A strange comment, issue or PR from someone else | Sessions ignore everyone but you. Moderate it as usual on GitHub. Fork PRs never count as task progress. |
| You change a decision | For one task: tell its session (attach) and leave a PR comment as the record. For every task: change `agent-instructions.md` by PR. |
| Usage is high | Lower `local_capacity` in `wbank-mcp-tasks.yaml` by PR, or pause (§4.3). |
| Never | Don't merge a draft PR or one marked **Blocked:**. Don't approve a deploy you haven't read the PR for. |

---

## 4. Sleep, Restart, Shutdown

### 4.1 Waking from sleep

Usually **nothing to do**. `launchd` runs the dispatcher once on wake, and background sessions continue
where they paused. Optionally run `claude agents` to see what is running.

Temporary AWS credentials last at most 36 hours. A session paused longer than that reports
"credentials expired" on its PR: `claude stop <ID>`, and the dispatcher resumes it with fresh
credentials on its next pass.

### 4.2 After a restart or a fresh login

1. **Start the dispatcher now** instead of waiting up to 15 minutes:
   `scripts/dispatch/dispatch-local.sh --now`. (The `launchd` agent also runs it at login.)
2. **Check:** `claude agents`. Sessions stopped by the shutdown are resumed by the dispatcher, with
   their conversation intact (at most twice per task).

`gh`, `claude`, the Keychain token and the `wb-mcp` keys stay valid across restarts.

### 4.3 Before shutting down, or away for a while

| Situation | Do |
|---|---|
| Closing the lid | Nothing. Sessions pause and continue on wake. To keep working while away, leave the Mac plugged in and awake (`caffeinate -i`). |
| Shutting down or restarting (including macOS updates) | `claude agents`; optionally `claude attach <ID>` and ask it to push its work; `claude stop <ID>` for each. The dispatcher resumes them after your next login. |
| Don't start new tasks for now | `touch ~/.wbank-mcp-dispatch-paused`; delete the file to resume. Running sessions continue; stop them with `claude stop <ID>` if needed. |
| Stop everything for a long time | Pause as above, then uninstall the agent (README). |

---

## 5. Merging Pull Requests

### 5.1 Before merging

| Check | Why |
|---|---|
| **`CI result` is green** | GitHub blocks the merge otherwise |
| **Not a draft, no Blocked: line** | The session is still working, or needs you |
| **Title starts with the task ID** (`MCP-1xx: …`) | That is how the dispatcher knows the task is done |
| **The diff stays inside the task's Owns list** (plan §5), plus tests | Prevents conflicts with the parallel task. Shared files (`template.yaml`, workflows, `package.json`, `CLAUDE.md`, `context/tasks/`) change only in the task that owns them. |
| **Acceptance checks and "could not verify"** in the description | Decide whether what wasn't verified matters now |
| **No secrets, tokens, the origin secret, your e-mail address or copied log lines** | The repo is public; these would be public in git history |
| **Infra PRs** (`infra: true`): the previous deploy has finished green, and the PR lists what the deploy will add, replace or delete | Merge them **one at a time**, so a failed deploy points at one PR |
| **Gate: MCP-120** only when all 41 reference answers say `review: done` | Merging is your approval of the evaluation set |
| **Conflicts:** `claude attach <ID>` and ask it to rebase onto `main` | Sessions rebase and push with `--force-with-lease` |

Then merge on GitHub. Your own changes (plan or document updates, including ones Claude makes for you
in an interactive session) also go through a PR: `main` protection applies to admins too.

### 5.2 After merging

1. **Approve the deploy** if the PR touched `mcp-server/` or `deploy.yml`: GitHub › Actions › the
   Deploy Pipeline run › **Review deployments** › `production` › **Approve and deploy**. Read the
   PR's "deploy will change" section first.
2. **Watch the deploy.** If it fails, don't merge another infra PR. Open your own Claude session on
   the repo with the error (for example "the prod deploy failed after MCP-113: <error>. Open a fix PR
   on a feature/ branch titled `MCP-113: Fix deploy`"). Verification tasks wait until a deploy is green.
3. **Local side:** automatic within 15 minutes while the Mac is awake. To start now:
   `scripts/dispatch/dispatch-local.sh --now`. The dispatcher also removes the merged task's worktree.
4. **Your next human task:** check whether the merge unblocked one (for example MCP-110 → you add the
   NS records, MCP-111).
5. If the merged PR changed `agent-instructions.md`, `wbank-mcp-tasks.yaml` or the dispatcher's guard
   files, new sessions and resumes use the new version automatically. Running ones keep the old one.
   If the dispatcher script itself changed, `git pull` the main checkout (README, Install).

---

## 6. Hotfixes

There is no promotion step: `main` is prod. For an urgent fix, use your own Claude session: branch
`feature/<ID or HOTFIX-n>-<description>` from `main`, open a PR, merge it when `CI result` is green, and
approve the deploy. Pause the dispatcher first (§4.3) if a running session is touching the same files.
