# MCP Server - World Bank Documents & Reports API

## Project Overview
This an AWS hosted MCP Server for The World Bank Documents and Reports API that allows for the search and retrieval of the public, Bank documents available in the Documents & Reports site.  Records can be retrieved in a format useful for research and for inclusion in web sites outside of Documents & Reports and the World Bank. 

Backend only — an AWS SAM project. **No frontend, no Next.js.**

## Environment Configuration
- AWS Account ID: 365677123675
- AWS Region: us-east-1
- AWS CLI Profile: wb-mcp
- GitHub Repository: https://github.com/Manzia/wbank-documents-reports-mcp.git (**public**)
- Project Name: wbank-docs-reports-mcp
- Documents & Reports API URL: https://documents.worldbank.org/en/publication/documents-reports/api
- Runtime: Node.js 24.x
- Architecture: arm64
- Environments: **`prod` only**, deployed from `main`
- CloudFormation stack: `wbank-docs-reports-mcp-prod`

## HARD RULES
- **CI/CD** - ALL deploys go ONLY through the CI/CD pipeline (`deploy.yml`). NO local `sam deploy`, `workflow_dispatch`, etc. UNLESS **explicitly approved by the user**.

## Development Workflow

### Branch Strategy
- main: Production-ready code. Every merge to `main` deploys to prod.
- feature/*: Feature branches (naming: feature/TASK-ID-description)
- No `develop` / `staging` branches. All changes land on `main` via PR from a `feature/*` branch.

## Repository Layout

```
.
├── mcp-server/                 # AWS SAM root
│   ├── template.yaml           #   stack definition
│   ├── samconfig.toml          #   SAM CLI defaults (stack name, build, validate)
│   ├── hello-world/            #   Lambda function package (esbuild, TypeScript)
│   │   ├── app.ts
│   │   ├── package.json        #   lint | compile | unit | test | test:coverage
│   │   └── tests/unit/
│   └── events/                 #   sample invoke events
├── context/                    # design notes (not built or deployed)
├── scripts/
│   └── check-template-descriptions.py   # CI guard: CFN Description ≤ 1024 chars
└── .github/workflows/
    ├── ci.yml                  #   path-gated orchestrator
    ├── _ci-sam.yml             #   reusable: lint / type-check / test+coverage / audit / validate / build
    └── deploy.yml              #   workflow_run-triggered CD to prod
```

`mcp-server/hello-world/` is the SAM scaffold's placeholder function. When it is
renamed or replaced, update `package-path` in `ci.yml` and the
`cache-dependency-path` in `deploy.yml` to match.

## Commands

```sh
# mcp-server/hello-world/
npm ci
npm run lint            # eslint (with --fix)
npm run compile         # tsc type-check (noEmit)
npm run unit            # jest
npm run test:coverage   # jest + coverage/coverage-summary.json (CI gate reads this)

# mcp-server/
sam validate
sam build --parallel
sam local invoke HelloWorldFunction -e events/event.json
```

## CI/CD

### CI — `ci.yml` → `_ci-sam.yml`
- Runs on push to `main` / `feature/**` and on PRs into `main`.
- `detect-changes` gates the `mcp-server` job: it runs only when something under
  `mcp-server/` changed, or when `.github/` or `scripts/` changed. A
  docs/`context/`-only change skips it.
- Jobs: **Lint** (eslint + `tsc`), **Unit tests + coverage gate** (line coverage
  **≥ 80%**), **npm audit** (moderate, non-blocking), **SAM build + validate**
  (Description-length check, `sam validate`, `sam build`).

### CD — `deploy.yml`
- Triggered by a **successful CI Pipeline run from a `push` to `main`** (i.e. a
  merged PR). The `event == 'push'` check stops a fork PR from a branch named
  `main` from triggering a deploy, which matters because the repo is public.
- Deploys only if the merge commit touched `mcp-server/` or `deploy.yml` itself
  (deploy flags live there). `workflow_dispatch` always deploys, but it falls
  under the HARD RULE above.
- Steps: `sam validate` → `rm -rf .aws-sam/` → `sam build --no-cached` →
  `sam deploy --stack-name wbank-docs-reports-mcp-prod --s3-bucket <artifacts>
  --no-confirm-changeset --no-fail-on-empty-changeset --force-upload`, then
  prints the stack outputs.
- `concurrency: deploy-prod` queues overlapping deploys rather than colliding on
  an in-progress stack update.
- The deploy job **pauses for approval** (environment `production`), then
  assumes the deploy role through OIDC. See "AWS deploy identity" below.
- Third-party `aws-actions/*` are pinned to commit SHAs. Bump them deliberately.

### GitHub protections (public repo)
- **Environment `production`**: required reviewer **Manzia**, so every deploy
  waits for a manual **Review deployments → Approve**. Deployment branches are
  limited to **`main`**, so a `workflow_dispatch` from any other branch can't
  use it. It holds the variable `AWS_DEPLOY_ROLE_ARN`. There are **no AWS
  secrets in GitHub**.
- **`main` branch protection**: PR required (0 approvals, since there's a single
  maintainer), required status check **`CI result`**, enforced for admins too,
  no force-push or deletion. `CI result` (in `ci.yml`) is the only check to
  require; see the comment there for why.
- **Fork PRs**: Actions runs need approval for all external contributors.

### AWS deploy identity (GitHub OIDC)
Created out-of-band with the AWS CLI (`wb-mcp` profile), not by any stack:

| Resource | Notes |
|---|---|
| OIDC provider `token.actions.githubusercontent.com` | audience `sts.amazonaws.com` |
| Role `wbank-docs-reports-mcp-github-deploy` | assumed by `deploy.yml` only |
| Bucket `wbank-docs-reports-mcp-artifacts-365677123675` | SAM artifacts (`--s3-bucket`); private, TLS-only, objects expire after 30 days |

**Trust policy**: `aud = sts.amazonaws.com`, **and**
`sub = repo:Manzia@1263542/wbank-documents-reports-mcp@1461012963:environment:production`,
**and** `ref = refs/heads/main`. The `sub` uses GitHub's *immutable* format
(owner and repo IDs, from `gh api repos/Manzia/wbank-documents-reports-mcp/actions/oidc/customization/sub`).
A job with `environment:` gets an `environment:` sub, not a `ref:` one, which
is why `ref` is a separate condition. Renaming the environment, or the repo
moving owner, breaks the trust.

**Permissions: deliberately broad for now** (to be narrowed to least privilege
once the MCP server's real resources are known: AgentCore Gateway, Bedrock
models, DynamoDB cache):
- `PowerUserAccess` (AWS managed). Covers everything except IAM.
- Inline `stack-iam-roles`. IAM **only** on roles named
  `wbank-docs-reports-mcp-prod-*`. `CreateRole` / `Put|Attach|Detach|DeleteRolePolicy`
  / `PutRolePermissionsBoundary` are allowed **only with permissions boundary
  `arn:aws:iam::aws:policy/PowerUserAccess`**. `PassRole` is allowed only to
  `lambda.amazonaws.com` and `bedrock-agentcore.amazonaws.com`.
  `DeleteRolePermissionsBoundary` is explicitly denied.

The boundary means a role the pipeline creates can never exceed PowerUser, so
role creation is no escalation path. **Every IAM role in `template.yaml` must
carry the boundary**: `Globals.Function.PermissionsBoundary` handles SAM's
implicit function roles, and an explicit `AWS::IAM::Role` must set
`PermissionsBoundary` itself. Role names must stay CloudFormation-generated (or
start with `wbank-docs-reports-mcp-prod-`), or the deploy fails with AccessDenied.

## Known Issues
- **`sam validate --lint` is off** (`samconfig.toml` → `lint = false`). SAM
  CLI's bundled cfn-lint crashes with `Rule already included: E3056`
  (DuplicateRuleError). Same workaround as manzia-agent-comparison.
- **Template `Description` is capped at 1024 chars** by CloudFormation, but only
  at changeset creation. `sam validate` and `sam build` both accept a longer one.
  `scripts/check-template-descriptions.py` catches it in CI. Put long prose in
  `#` comments.
- **`samconfig.toml` also applies in CI.** `sam deploy` merges
  `[default.deploy.parameters]` with `deploy.yml`'s flags, so the two must not
  conflict. The scaffold's `resolve_s3 = true` failed the first prod deploy
  with "Cannot use both --resolve-s3 and --s3-bucket". samconfig now names the
  same artifacts bucket.
- **Never pass `--parameter-overrides` for a parameter the template doesn't
  declare**, because the deploy fails. `template.yaml` declares no Parameters today.
