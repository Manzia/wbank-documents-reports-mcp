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
  `sam deploy --stack-name wbank-docs-reports-mcp-prod --resolve-s3
  --no-confirm-changeset --no-fail-on-empty-changeset --force-upload`, then
  prints the stack outputs.
- `concurrency: deploy-prod` queues overlapping deploys rather than colliding on
  an in-progress stack update.

### GitHub setup the pipeline needs
- Environment **`production`** (Settings → Environments).
- Secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for an IAM user in
  account 365677123675, with rights to deploy the stack (CloudFormation, Lambda,
  API Gateway, IAM role creation, and the SAM-managed S3 artifact bucket).

## Known Issues
- **`sam validate --lint` is off** (`samconfig.toml` → `lint = false`). SAM
  CLI's bundled cfn-lint crashes with `Rule already included: E3056`
  (DuplicateRuleError). Same workaround as manzia-agent-comparison.
- **Template `Description` is capped at 1024 chars** by CloudFormation, but only
  at changeset creation. `sam validate` and `sam build` both accept a longer one.
  `scripts/check-template-descriptions.py` catches it in CI. Put long prose in
  `#` comments.
- **Never pass `--parameter-overrides` for a parameter the template doesn't
  declare**, because the deploy fails. `template.yaml` declares no Parameters today.
