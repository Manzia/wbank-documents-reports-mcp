# World Bank Public MCP Server: AWS Architecture & Design

**Status:** Approved v5.1 · **Date:** 2026-11-23 (v5.1: precheck corrections D6–D8; v5: live vocabulary snapshot A10, dynamic term resolution, paged `read_document`; see §13) · **Region:** us-east-1 · **Stack:** `wbank-docs-reports-mcp-prod` · **Endpoint:** `https://worldbank-mcp.manzia.com/mcp`

**Inputs:** the requirements in `context/tasks/wbank-mcp-to-do.md` and the expected queries in `context/design/wbank-mcp-query-design.md`.

Each statement in this doc is marked **[Verified]** when a live probe, AWS documentation or a hands-on test on 2026-11-19 confirmed it. Statements that still need checking during implementation are marked **[Assumption]**. Your approvals and rejections are recorded in §13.

---

## 1. Summary

A public MCP server at **`https://worldbank-mcp.manzia.com/mcp`** with no sign-in. Users **paste one URL** into the custom-connector dialog of the Claude, ChatGPT or Gemini web app. They install nothing else. The server **serves its own skills** through a `retrieve_skill` tool (the AWS Knowledge MCP approach), plus tool descriptions and result hints (§4).

**Request path:**

1. **Amazon CloudFront** with an AWS WAF web ACL serves the custom domain. WAF here sees each caller's real IP.
2. CloudFront forwards to **Amazon Bedrock AgentCore Gateway**, which has no inbound sign-in, has streaming on, and has its own regional WAF and rate limits per tool.
3. The gateway routes tool calls to a single **MCP-server target running on AWS Lambda** (Node.js 24, arm64). The function implements MCP with the official TypeScript SDK and sits behind an IAM-protected **function URL with response streaming**. The gateway signs its calls with SigV4. This is decision **D1 = option B**, §6.

**What the target does:**

- It exposes five read-only tools over the World Bank **Documents & Reports** (WDS) and **Projects & Operations** APIs.
- It calls **Claude Haiku 5.5 on Amazon Bedrock** only for bounded tasks: reformulating search queries, and resolving informal names ("East Africa", "PAD") to the World Bank's own values when plain matching fails.
- It keeps a **snapshot of the World Bank's own vocabulary** (the valid countries, regions, document types, sectors, themes, statuses and languages) in S3, refreshed every 30 days by a scheduled job (A10, §7.2).
- Documents are read the way the AWS Knowledge server reads its pages: an outline with page numbers, then verbatim pages on request. **The client's model decides what to read** (§5.4).
- It keeps no data. Every answer carries the IDs, titles, dates, page references and links it relied on.

### Requirement map

| # | Requirement | Where it is met |
|---|---|---|
| 1 | Public, easy to add to Claude, ChatGPT, Gemini and similar clients | §4: one URL, guidance built into the server, stable custom domain |
| 2 | AgentCore Gateway + Lambda target; Haiku 5.5 for query work | §3, §5, §7. The target is an MCP server **on Lambda** behind a function URL: AgentCore's "MCP server" target type, approved as D1 = B (§6). |
| 3 | Response streaming by default | §6: gateway streaming on, Lambda response streaming, SSE with progress events and keep-alive pings |
| 4 | Rate limiting | §8.3 |
| 5 | Basic WAF (bot and volumetric traffic) | §8.1–8.2 |
| 6 | ≥ 90% accurate on the expected queries at launch | §9, §10 |

---

## 2. Facts that shaped the design

These come from probes of the live APIs, AWS docs and a hands-on test on 2026-11-19.

| Finding | Consequence |
|---|---|
| **[Verified]** Sorting by date works with `srt=docdt&order=desc`. The `sort` parameter is **silently ignored**. Keyword searches default to relevance order. | "Latest" always uses `srt`, which answers the open question in the query doc. |
| **[Verified]** A multi-word `qterm` is broad: `digital learning` matches 3,949 records, while the quoted phrase matches 23. The query from the doc ("digital learning in Uganda since 2020") returns 2 records, and the top hit is Board minutes. | Keyword quality is the main accuracy risk for search queries, so Haiku reformulates them (§7). |
| **[Verified]** Abstracts are missing on many records (for example, most ISRs and aide-mémoires). | Substantive questions need the document text. |
| **[Verified]** `documents.worldbank.org/curated/...` (both the `txturl` and `pdfurl` links) returned **HTTP 403** on 2026-11-19 (Cloudflare bot protection); on 2026-11-23 the `txturl` links answered **301** to `documents1` instead (MCP-102). The same files on **`documents1.worldbank.org`** return **HTTP 200**: plain text (about 300 KB for an ICR) and the PDF. `documents1` has no robots.txt restrictions. | Document text is fetched from `documents1` only. Access stability is the top risk (§12). |
| **[Verified]** Older full-text files keep **form-feed page breaks**; most 2026 files have only `-N-` or "Page N" footer lines, and short ones neither (MCP-102, F2). | Page-level citations work where pages can be found; otherwise the text is split into fixed-size parts (§5.4, D6). |
| **[Verified]** The `proid` filter returns all records for a project: 129 for P117635, in date order. `fct=count_exact` returns country facet counts. | One call fetches a project's document list. Facets answer "which countries appear most often". |
| **[Verified]** The Projects API with `fl=*` returns about 69 fields: PDO, implementing agency, borrower, closing date, commitments, sectors, indicators, ISR and IEG ratings, milestones, financiers. | `get_project` requests the full set and trims it. |
| **[Verified]** Claude Haiku 5.5 is ACTIVE in us-east-1, **only through an inference profile** (`us.` or `global.anthropic.claude-haiku-5-5`). | IAM grants both the inference profile and the underlying foundation model ARNs. |
| **[Verified, your test]** The public **AWS Knowledge MCP Server**, which is itself an AgentCore Gateway with no sign-in (its tools are named `aws___…`), connects as a **Gemini custom connector** with no credentials. Claude custom connectors ("No sign-in") and ChatGPT ("No authentication") also support servers with no sign-in. | **No sign-in works in all three primary web apps.** No OAuth needed. |
| **[Verified, your test]** The AWS Knowledge server needed **no skill** in Gemini. It ships its own guidance as a tool (`retrieve_skill`). | Skills are **served by the server** through a `retrieve_skill` tool, as AWS does (§4.2). Users install nothing but the URL. |
| **[Verified]** Gateway progress and log events are relayed **only from MCP-server targets**. A Lambda target returns one JSON result. MCP-server targets can authenticate to their backend with **IAM signing (SigV4)**: service `lambda` for a Lambda **function URL**, or `bedrock-agentcore` for an **AgentCore Runtime** server. | These defined the D1 options. **B was chosen** (§6). |
| **[Verified]** None of Claude's, OpenAI's or Google's connector docs say whether their apps **display** MCP progress events. | Progress display isn't relied on. Option B was chosen for keep-alive pings and confirmed annotations (§6). |
| **[Verified]** For MCP-server targets, the gateway syncs **tools, prompts and resources**, including tool `annotations` and `outputSchema`, from the server itself. | Claude requires `readOnlyHint` and `destructiveHint` on every tool. With option B the annotations come from the server code and are passed through. |
| **[Verified]** AWS's documented way to give a gateway a custom domain is **CloudFront as a reverse proxy**, with an ACM certificate (us-east-1) and a Route 53 record. | Behind CloudFront, the gateway's WAF sees **CloudFront's IPs**, not the callers'. Per-IP rules therefore move to a CloudFront web ACL (§8). |
| **[Verified]** `manzia.com` DNS is in Route 53 in **another AWS account**. | `worldbank-mcp.manzia.com` is delegated to a hosted zone in this account (one-time step, §3.2). |
| **[Verified]** With no inbound auth, gateway rate limits can only use `targetName` and `toolName`. | Per-caller limiting is per IP, in WAF (§8). |
| **[Verified]** The official **MCP TypeScript SDK** (v2.4.0, released 2026-10-23) provides `createMcpHandler`, a standard web handler (`Request` → `Response`). It serves the stateless 2026-07-28 protocol revision with a fallback for older clients, and sends **SSE keep-alive pings every 15 s** by default. Hono's Lambda adapter (`streamHandle`, in `@hono/aws-lambda`) bridges a web handler to **Lambda function URL response streaming**. | Option B needs only a thin wiring layer (§6). |
| **[Verified]** Abstracts are rare: 13 of the 100 most recent records of project P117635 have one. An ICR's abstract summarises the project, not, for example, how maintenance was funded. | Abstract plus link can't answer substantive questions; the text has to be read (§5.4). |
| **[Verified]** One ICR's text file is 298,885 characters (about 75,000 tokens) over 72 pages. `documents1` ignores byte-range requests (a ranged GET returns the whole file) and serves it in about 0.15 s. The API's `/text/` links redirect to `/txt/`. | A multi-document question can't hand whole files to the client model. A document is fetched whole; a cached outline alone would save nothing (§13, A2). |
| **[Verified]** The AWS Knowledge MCP Server returns **verbatim chunks** from search, and reads pages **in parts** (10,000 characters by default) with a **table of contents giving each section's range**. Its descriptions tell the model to answer from the chunks and read further only when they lack the answer. | `read_document` follows the same pattern (§5.4). |
| **[Verified]** Claude limits: about 150,000 characters per tool result and 240 s per call on claude.ai; 25,000 tokens in Claude Code. Gateway: 15-minute invocation timeout, 6 MB payload, 200 tool calls per second (adjustable). | Tool output is capped at about 20,000 tokens (§5). |

---

## 3. Architecture

### 3.1 Request path

```
 Claude · ChatGPT · Gemini web apps (custom connector = one URL)      secondary: Claude Code, Gemini CLI, others
                                │  HTTPS, MCP Streamable HTTP, no sign-in
                                ▼
   worldbank-mcp.manzia.com ── Route 53 (delegated zone in this account)
                                ▼
   ┌──────────────────────────────────────┐
   │ CloudFront distribution              │◀── WAF web ACL (CloudFront scope): IP reputation ·
   │ ACM cert · no caching · adds secret  │    per-IP rate tiers · body size
   │ origin header                        │
   └──────────────────┬───────────────────┘
                      ▼
   ┌──────────────────────────────────────┐
   │ AgentCore Gateway                    │◀── WAF web ACL (regional): origin lock (secret header)
   │ authorizer NONE · streaming ON       │    · IP reputation
   │ rate limits per tool and target      │
   └──────────────────┬───────────────────┘
                      │  MCP-server target · SigV4 (service "lambda") · SSE streaming
                      ▼
   ┌──────────────────────────────────────┐      ┌──────────────────────────────┐
   │ Lambda function URL (IAM auth,       │─────▶│ Bedrock: Claude Haiku 5.5    │
   │ RESPONSE_STREAM) · MCP TS SDK        │      └──────────────────────────────┘
   │ Node.js 24, arm64 · 5 read-only tools│
   └───────┬──────────────────┬───────────┘
           ▼                  ▼                    ▲ reads at cold start
   search.worldbank.org   documents1.worldbank.org   │
   (WDS + Projects APIs)  (document text and PDF)  ┌─┴────────────────────────────┐
           ▲                                       │ S3: vocabulary.json          │
           └──── refresh Lambda ──────────────────▶│ (World Bank's own values)    │
                     ▲                             └──────────────────────────────┘
          EventBridge Scheduler, every 30 days (and once after each deploy)
```

### 3.2 Components (all in stack `wbank-docs-reports-mcp-prod`, deployed by the existing pipeline)

| Component | Configuration |
|---|---|
| Route 53 hosted zone `worldbank-mcp.manzia.com` | Delegated from `manzia.com`. **One-time manual step:** add its 4 NS records to the `manzia.com` zone in the other AWS account. Holds the certificate-validation record and the alias record pointing to CloudFront. |
| ACM certificate | `worldbank-mcp.manzia.com`, us-east-1 (as CloudFront requires), DNS-validated in the delegated zone |
| CloudFront distribution | Alternate domain `worldbank-mcp.manzia.com`. Origin: the gateway's hostname over HTTPS. **Caching disabled**. All methods allowed. All viewer headers forwarded except Host. Adds a **secret origin header**. Response timeout set to 60 s (§6). |
| WAF web ACL (CloudFront scope) | Per-IP and reputation rules (§8.1) |
| AgentCore Gateway | Protocol MCP; inbound authorizer **NONE**; `enableResponseStreaming = true`; WAF failure mode **FAIL_CLOSE** (the default). **Deletion and replacement protected** (Retain). |
| WAF web ACL (regional, on the gateway) | Origin lock plus reputation (§8.2). This is the gateway WAF integration that requirement 5 refers to. |
| Gateway target `wb` | **MCP-server** target. Endpoint: the function URL's `/mcp`. Outbound auth: gateway IAM role, SigV4 with service `lambda`. Its tool list is synced from the server, so the pipeline **re-syncs the target after each deploy**. Clients see tools named `wb___<tool>`. |
| MCP server function | Lambda, Node.js 24.x, arm64, TypeScript bundled with esbuild, 1,024 MB, 5-minute timeout. A **function URL** with auth type **AWS_IAM** and invoke mode **RESPONSE_STREAM**. Built on the official **MCP TypeScript SDK** (`createMcpHandler`, stateless) bridged to Lambda streaming with `@hono/aws-lambda` `streamHandle`. SDK versions are pinned. Replaces the scaffold's `HelloWorldFunction` and its API Gateway REST API. |
| Vocabulary bucket (A10) | S3, private, versioned, encrypted, TLS only. Holds `vocabulary.json`: the valid countries, regions, document types, sectors, themes, statuses and languages, as the APIs list them, with the date fetched. Versioning keeps the previous snapshot. |
| Vocabulary refresh function (A10) | Lambda, Node.js 24, arm64. Fetches the APIs' own value lists (facets) and writes the snapshot; on any failure it writes nothing, so the previous snapshot stays. Started every 30 days by an **EventBridge Scheduler** schedule, and once by the deploy pipeline after each deploy. |
| Origin secret | AWS Secrets Manager secret with a random value. Both CloudFront and the regional WAF rule read it through CloudFormation dynamic references. |
| Gateway service role | Trusted by `bedrock-agentcore.amazonaws.com`, limited by `aws:SourceAccount` and `aws:SourceArn`. Allows `lambda:InvokeFunctionUrl` (and `lambda:InvokeFunction`, which IAM-auth function URLs also require) on the MCP server function only. |
| Tool execution role | CloudWatch Logs for its own log group. `bedrock:InvokeModel` and `InvokeModelWithResponseStream` on the Haiku 5.5 inference profile and its foundation model only. `s3:GetObject` on the vocabulary object only. The refresh function's role may write that object; the scheduler's role may invoke the refresh function. |
| Monitoring (A3, approved) | CloudWatch alarms, a dashboard, an SNS topic with an e-mail subscription for the operator, and an AWS Budgets monthly alert (§11) |

Both IAM roles follow the existing deploy-role rule: names generated by CloudFormation, plus the PowerUserAccess permissions boundary (CLAUDE.md, "AWS deploy identity").

**[Assumption]** CloudFormation supports, for these resources: authorizer `NONE`, the gateway's streaming configuration, and WAF association with a gateway. If any is missing, that one setting is applied by a post-deploy CLI step in `deploy.yml`. It does not mean a new component.

---

## 4. Access, and guidance without skills (requirement 1)

### 4.1 How users add it

There's one URL, `https://worldbank-mcp.manzia.com/mcp`, and the same steps in every app:

| App | Steps |
|---|---|
| Claude (web, desktop: Chat and Cowork) | Customize → Plugins → Add → **Add custom connector** → Name + URL → Continue (no sign-in) |
| ChatGPT (web) | Plugins → Add → **Add custom MCP server** → URL → No authentication |
| Gemini (web) | Connectors → **+ Custom** → MCP Server URL → Next → Connect |
| Secondary: Claude Code, Gemini CLI, other clients | The same URL as a remote (Streamable HTTP) server |

The README carries a one-page "Add to Claude / ChatGPT / Gemini" guide with these steps.

**Naming:** the server's display name and description say it is **unofficial and not affiliated with the World Bank**.

### 4.2 Skills served by the server: nothing for users to install

Every MCP client gives its model the server's **tool names, tool descriptions and tool results**, so the guidance lives there. This is the pattern your AWS Knowledge test showed.

1. **Tool descriptions** say *when* to use each tool and *what to call next*. For example: "for 'latest', sort newest"; "to answer from a document's content, call `read_document` with a question"; "always cite page numbers". Each parameter's description carries the vocabulary it needs: the document-type table in §9, and plain-language country and region names. Descriptions are kept short enough to fit every client's tool listing.
2. **Tool results** carry the next step and the citation format. Search results end with hints such as "to read one, call `read_document` with its `document_id`". `read_document` passages come with a ready-made citation (title, date, page) and a coverage note.
3. **A `retrieve_skill` tool**, the same approach as the AWS Knowledge server, returns a **skill** for a task type: the workflow a user would otherwise install as a skill, fetched on demand. Examples: project briefing, latest ISR and what changed, PAD vs. financing agreement, restructuring summary, ICR lessons across projects, comparable operations, catalog search. Other tools' descriptions tell the model to call it first for any multi-step research request. The skills live in the repo, are versioned with the code, and use the same `SKILL.md` style (name, description, instructions), so they could also be packaged as installable skills later without rewriting them.

**Not relied on:** the MCP server-level `instructions` field (no vendor documents using it, and the gateway doesn't document passing it through) and MCP prompts (clients show them as user-chosen shortcuts, not automatic guidance).

### 4.3 Tool annotations

Claude requires `readOnlyHint` and `destructiveHint` on every tool, and ChatGPT reviews annotations. All five tools are declared `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`. They're defined in the server code and synced by the gateway, which passes annotations through for MCP-server targets (§6). Their appearance in the three web apps is checked in build step 1.

### 4.4 A stable endpoint (A4, approved)

The custom domain decouples the public URL from the gateway's generated hostname. The gateway, its target and even the hosting option (D1) can change without breaking any user's connector. The gateway also has Retain policies, so an accidental replacement can't delete it.

---

## 5. Tool design

There are five tools: the query doc's four, plus `retrieve_skill` (§4.2). All are read-only and keep no server-side state. The client's model plans multi-step answers, and each tool returns compact, cited evidence.

### Rules common to all tools

- **Output budget:** about **20,000 tokens** per result, which fits the tightest documented client limit (Claude Code). Results report when they've been truncated and how to get the next part (an offset or a page range).
- **Provenance in every item:** IDs (project ID, document ID, report number), title, document date, disclosure date where relevant, document type, and the official record link plus the file link.
- **"Those results" without server state:** every search result echoes the **exact query it ran** (keywords, filters, sort, offset). The client changes one part and calls again. This handles follow-ups like "only English, 2022 onward, next ten".
- **Clear about the source:** results say what they are, for example "matching document records" for facet counts, or "latest *disclosed* ISR" rather than "current status".
- **Upstream access, in two layers:**
  - **Transport, one per host** (`search.worldbank.org`, `documents1.worldbank.org`): only those hosts; a 10-second timeout, one retry with backoff, at most 3 parallel requests per tool call, a descriptive User-Agent, paging, an in-memory cache while the code stays warm, and API errors turned into plain messages. It knows nothing about queries.
  - **Query building, in each tool,** using the APIs' own parameter names, checked against an **allow-list** of parameters taken from the API documentation and the build prechecks. Tools can use anything the APIs support without a new client function, while neither Haiku, the client model nor injected text can make the server send an unknown parameter or reach another host.
  - Responses are **normalised**: the provenance fields go into one stable shape; every other returned field stays available to the tool.
  - A persistent cache is A2, on hold.
- **Term resolution (§7.1):** every filter value given in plain language is resolved against the live vocabulary, and every result says how it was interpreted ("interpreted as"), so the client's model can correct it in the next call.

### 5.1 `search_documents`

Finds Documents & Reports records, and doubles as a project's document list.

| Input | Meaning |
|---|---|
| `query` | Natural-language or keyword text (optional) |
| `project_id` | e.g. P117635. Returns that project's records. |
| `countries`, `region` | Plain names, resolved against the live vocabulary (§7.1) |
| `document_types` | e.g. "Procurement Plan", "ISR", resolved against the live vocabulary (§7.1) |
| `language`, `date_from`, `date_to`, `author`, `report_number`, `document_id`, `collection` | Exact filters |
| `sort` | `relevance` (default when there's a query), `newest` or `oldest` (uses `srt=docdt`) |
| `facet` | Optional: `country`, `document_type`, `language` or `year`. Returns counts. |
| `group_by_stage` | For a project ID: groups records into design, legal, environmental and social, implementation, restructuring and completion, using a fixed document-type table |
| `limit`, `offset` | Paging (default 10, max 50) |

**Output:** the total match count, the query as executed, how each term was interpreted, records (provenance plus an abstract when present), facets when asked for, and next-step hints.

### 5.2 `search_projects`

| Input | Meaning |
|---|---|
| `query` | Keywords (sector or topic) |
| `countries`, `region`, `status`, `sector`, `theme` | Resolved against the live vocabulary (§7.1) |
| `approval_from` / `approval_to`, `closing_from` / `closing_to` | Date windows. Closing-date filtering is done in the tool code if the API can't do it (**[Assumption]**). |
| `sort`, `limit`, `offset` | e.g. "closing soonest" |

**Output:** project ID, name, country, region, status, approval and closing dates, commitment (labelled as a *commitment*, separate from project cost), lending instrument, implementing agency, and the record link.

### 5.3 `get_project`

Takes a project ID. Returns a profile from the full Projects record:

- **Identity:** objective (PDO), borrower, implementing agencies, region and country, status.
- **Key dates:** approval, effectiveness, closing.
- **Financing:** commitments by source, *kept separate* from total project cost.
- **Classification:** sectors and themes.
- **Performance:** latest ISR ratings with their dates, IEG ratings where they exist, and results indicators.
- **Documents:** a count of public documents by type.

Implementation status is always labelled as coming from the latest *disclosed* ISR.

### 5.4 `read_document`

Reads one public document **in parts**, the way the AWS Knowledge server reads its pages (§2). The tool finds and returns text, verbatim; **the client's model does the reading** and decides what to read next.

| Input | Meaning |
|---|---|
| `document_id` or `report_number` | Identifies the document. **No arbitrary URLs**, which prevents server-side request forgery. |
| `question` | Optional. What to look for. |
| `pages` | Optional. An explicit page range, e.g. `40-46`, for reading further or reading tables |

**How it works:**

1. Look up the record through WDS.
2. Fetch the plain text from `documents1.worldbank.org` (the `/txt/` path), whole: the host doesn't serve parts.
3. Split it into pages on form-feed breaks, else on page-footer lines (`-N-`, `Page N`), else into fixed-size parts without page numbers; the coverage note says which (D6). Build an **outline**: the document's numbered headings (ICRs and PADs have them) with the page each starts on.
4. Return, depending on the input:
   - **no `question`, no `pages`:** the outline, the total page count and the first pages;
   - **`question`:** the outline plus the pages that best match it by keyword (with the terms from query reformulation, §7), verbatim;
   - **`pages`:** those pages, verbatim.

**Output:** metadata; the outline; the pages returned, each with its page number and a ready-made citation (title, date, page); a **coverage note** (for example, "72 pages; returned pages 12, 31–33 and 47 matching 'maintenance', 'road fund'"); and, when more is available, the next page ranges to ask for. At most about 20,000 tokens per call. The description says, as AWS's does, that pages are verbatim and need no re-reading to confirm them.

Haiku does not re-rank pages by default; the client's model chooses from the outline and the matches. Re-ranking is added back only if the evaluation shows it improves accuracy (§10). For documents with no text file: **[Assumption]** text is extracted from the PDF in the tool code; otherwise the tool says plainly that the text is unavailable.

### 5.5 `retrieve_skill`

| Input | Meaning |
|---|---|
| `task` | Optional. One of: project briefing, implementation tracking, document comparison, restructuring, completion lessons, comparable operations, catalog search, country evidence. Without it, returns the list of skills with one-line descriptions. |

**Output:** the skill's instructions: steps (which tools, in what order, with which filters), the document types involved, and the citation and coverage rules. Skills are static text maintained in the repo and versioned with the code. They follow the expected-query tiers (§9).

---

## 6. Response streaming (requirement 3): D1 = option B (approved)

### 6.1 Design

The tool code is an **MCP server running on Lambda**. AgentCore calls it as an **MCP-server target**.

- **Function URL:** auth type **AWS_IAM**, invoke mode **RESPONSE_STREAM**. The gateway calls it with SigV4, using service `lambda` and the gateway's IAM role. The URL isn't usable by the public.
- **MCP implementation:** the official **MCP TypeScript SDK** (`@modelcontextprotocol/server`, v2.x, pinned). `createMcpHandler` turns a standard web request into a streamed web response. It runs **stateless**, serving the 2026-07-28 protocol revision with the fallback for older clients that the gateway may use.
- **Lambda bridge:** `streamHandle` from `@hono/aws-lambda` connects that web handler to Lambda's response streaming. No session state is kept between requests.
- **What streams:** with `enableResponseStreaming = true` on the gateway, clients that send `Accept: text/event-stream` receive Server-Sent Events through the gateway and CloudFront:
  - **Progress notifications** from long tools (`read_document` on large documents, multi-variant searches), for example "fetched document", "72 pages, matching", "returning 5 pages".
  - **SSE keep-alive pings every 15 s** (the SDK default). These keep the connection inside CloudFront's 60-second idle limit, so a long read doesn't time out even when there's no progress to report.
  - **The final result** as the last event.
- **Tool definitions come from the server code:** names, descriptions, input schemas, **annotations** and output schemas. The gateway caches the tool list, so the deploy pipeline runs a **target re-sync** (`SynchronizeGatewayTargets`) after each deploy that changes the function.
- **Requirement 2:** the target is Lambda-hosted, but it's AgentCore's "MCP server" target type rather than its "Lambda" target type. You approved this.
- **Lambda settings:** 1,024 MB, a 5-minute timeout (well beyond the expected tool latency, and within the clients' 240 s limits plus margin), arm64. **No reserved concurrency cap** (A1 declined, to revisit later).

### 6.2 What is verified first (step 1 of the build)

1. The gateway reaches the IAM-auth function URL, with SigV4 service `lambda`, and the SSE stream flows through to the client.
2. **Keep-alive pings and progress events pass through the gateway and CloudFront.** AWS's docs say the gateway relays progress and log events and mention pings in streams, but that both make it through CloudFront end to end is **[Assumption]**.
3. The pipeline's re-sync step updates the gateway's tool list after a deploy.
4. Tool annotations appear in the Claude, ChatGPT and Gemini web apps.

### 6.3 Options considered

| | A: Lambda target | **B: MCP server on Lambda (chosen)** | C: MCP server on AgentCore Runtime |
|---|---|---|---|
| Progress and log events | No, final result only | Yes | Yes |
| Long calls behind CloudFront | At risk with no bytes for 60 s; tools must finish within about 55 s | Kept alive by 15 s pings | Kept alive |
| Tool annotations | Unconfirmed for this target type | Confirmed (synced from server) | Confirmed |
| Complexity | Lowest | Low to medium with the official SDK; adds a tool-list re-sync step | Highest: a new service, packaging, session cold starts |
| Requirement 2 | Exact | Lambda-hosted, MCP-server target type (approved) | Replaces Lambda |
| Cost model | Per invocation | Per invocation | Per-session compute and memory |

**Why B:** with the official SDK, B is little more work than A. It removes A's two risks (annotations, and the CloudFront idle timeout) **by design**, without depending on whether client apps display progress events. C's extra operational weight buys nothing that the expected queries need.

---

## 7. Vocabulary and Claude Haiku 5.5 (requirement 2)

Haiku is used **only** where it measurably improves accuracy. Every use has a token cap (about 500 output tokens) and a 5-second timeout, and falls back to plain keyword logic if Bedrock is slow or throttles. Calls go through the `us.anthropic.claude-haiku-5-5` inference profile.

| Use | When | Input → output |
|---|---|---|
| **Query reformulation** | `search_documents` and `search_projects` with free-text `query` | The user's words → 2 to 3 keyword variants (quoted phrases, synonyms, World Bank terms such as "learning poverty" or "EdTech"). The variants run in parallel and the results are merged and de-duplicated. |
| **Term resolution** | A filter value that plain matching can't resolve (§7.1, step 3) | An informal term ("East Africa", "PAD", "completion report") plus the matching part of the live vocabulary → one or more values **from that list only**. |

Haiku never writes the user-facing answer; the client's model does, from verbatim sources. Document text sent to Haiku is treated as **untrusted data**, and Haiku's output is restricted to a fixed structure (lists of terms or vocabulary values), so injected text can't steer results.

### 7.1 Term resolution: no hand-written mappings

People phrase things in ways no table can anticipate, so the server keeps **no hand-written list of synonyms or aliases**. Each plain-language filter value is resolved against the World Bank's own vocabulary (§7.2), in this order, stopping at the first that works:

1. **Forgiving exact match:** ignoring case, accents and punctuation ("Cote d'Ivoire" = "Côte d'Ivoire").
2. **Fuzzy match:** similar wording above a similarity threshold.
3. **Haiku** chooses from the live list (and may return several, such as a region's countries). It can't invent a value: anything not in the list is discarded.
4. **Nothing resolves:** the term goes into the free-text search instead, and the result lists the closest valid values.

Resolutions are remembered in memory while the code stays warm, so a new term costs a Haiku call once per instance. **Every result says how each term was interpreted**, for example "'East Africa' is not a World Bank region; searched Kenya, Tanzania, Uganda, Rwanda, Ethiopia, Burundi, South Sudan". Claude, ChatGPT and Gemini, which are stronger than Haiku and know the conversation, correct it in their next call when needed. The tool descriptions also ask them to expand informal terms themselves where they can.

### 7.2 Vocabulary snapshot (A10, approved)

- **What:** the valid values of each filter, as the APIs themselves list them (WDS and Projects API facets): countries, regions, document types, sectors, themes, statuses and languages, with the date fetched. Facets stop at 100 values, so most lists are a **best-effort union** of partitioned facet queries, and the snapshot marks each list complete or best-effort (D7).
- **Where:** `vocabulary.json` in the vocabulary bucket (§3.2).
- **When:** every **30 days** by an EventBridge Scheduler schedule, and once after each deploy (the pipeline invokes the refresh function), so a new or changed stack always has a current snapshot.
- **Failure:** a refresh that fails writes nothing, so the previous snapshot stays; an alarm reports it (§11). If the server ever finds no snapshot, it fetches the lists live and keeps them in memory.
- **Use:** the MCP server function reads the snapshot at cold start and keeps it in memory.

## 8. Protection: WAF (requirement 5) and rate limits (requirement 4)

There are three layers:

- **CloudFront's WAF** limits per IP. It's the only layer that sees callers' real IPs.
- **The gateway's WAF** makes sure all traffic comes through CloudFront.
- **Gateway rate limits** protect the service as a whole: a total budget per tool covering the Lambda, the Bedrock spend and the World Bank's servers.

**AWS managed Bot Control is excluded for now, for cost** (your decision). Bot traffic is covered by AWS's **IP reputation list** (known malicious sources, botnets and reconnaissance scanners) and by the rate rules.

### 8.1 WAF web ACL on CloudFront (per IP)

Rules are listed in evaluation order. **[Assumption]:** all thresholds are starting values, tuned during the COUNT-mode period.

| # | Rule | Action | Purpose |
|---|---|---|---|
| 1 | AWS managed **Amazon IP reputation list** | Block | Known malicious sources, botnets and scanners |
| 2 | **Per-IP rate rule, AI platforms:** source IP in an IP set of Anthropic's and OpenAI's published egress ranges, plus Google's published service ranges | Block above **3,000 requests per 5 minutes per IP** | Web-app users reach the server through their vendor's servers, so many users share a few IPs. **[Assumption]:** Google publishes no egress ranges specific to Gemini, so its general service ranges stand in, and the tier is confirmed from sampled requests. |
| 3 | **Per-IP rate rule, everyone else** | Block above **300 requests per 5 minutes per IP** (about 1 per second sustained) | Volumetric abuse from individual sources |
| 4 | **Request body size:** body over 64 KB | Block | MCP tool calls are small, so this drops oversized payloads |

Rules 2 and 3 start in **COUNT** mode for the first week, then move to Block (AWS best practice), using sampled requests. The AI-platform IP set is refreshed by hand; automating that refresh is A6, on hold.

### 8.2 WAF web ACL on the gateway (regional)

| # | Rule | Action | Purpose |
|---|---|---|---|
| 1 | **Origin lock:** request lacks the secret origin header that CloudFront adds | Block | Stops anyone calling the gateway's own hostname directly to get round CloudFront's per-IP rules |
| 2 | AWS managed **Amazon IP reputation list** | Block | Defence in depth (largely redundant, since traffic arrives from CloudFront) |

The failure mode is **FAIL_CLOSE**. Blocked MCP requests get JSON-RPC error `-32002`.

### 8.3 Gateway rate limits

Limits are requests per minute unless noted. They can be changed without interruption.

| Rate limit | Dimension | Entries |
|---|---|---|
| Per-tool budget | `toolName` | `wb___read_document`: 120 per minute (this tool uses Haiku and large downloads) · `wb___search_documents`: 600 · `wb___search_projects`: 600 · `wb___get_project`: 600 · `wb___retrieve_skill`: 600 |
| Target budget | `targetName` | `wb`: 1,200 per minute in total. No connection limit: the gateway's `Connections` limit is a rate (per second), not a concurrency cap (D8) |

**Notes:**

- Rate limits **fail open**: if the rate-limit service is unavailable, requests go through. WAF per-IP rules still apply. A Lambda concurrency cap (A1) was declined for now and can be revisited.
- **[Assumption]:** Bedrock's quota for Haiku 5.5 on this account is above the `read_document` peak. This needs checking in Service Quotas before launch.

**Cost note:** at AWS list prices, each web ACL is about $5 per month plus $1 per rule per month, plus a per-million-request charge. That's two web ACLs and about 6 rules. Bot Control would have added a monthly fee plus per-request charges. Check current pricing.

---

## 9. Accuracy approach (requirement 6)

The expected queries fall into three tiers. Each needs something different.

| Tier | Expected queries | What makes it accurate |
|---|---|---|
| **Search & retrieve** | Q1 (9), parts of Q4 | Correct filters (term resolution against the live vocabulary, §7.1), `srt` for "latest", facets for "most often", keyword variants for recall, query echo for follow-ups |
| **Project-centred reading** | Q2 (5), most of Q3 (16), Q4 project items | `proid` → full document list → right document type and version (by date, ISR sequence, version type) → `read_document` with page citations |
| **Cross-project synthesis** | Q3 "design precedents", "results measures", "apply lessons"; Q4 "comparable operations", "completion lessons" | `search_projects` to build a set of comparable projects → their ICRs and PADs → passages per project. The **coverage statement** is part of the answer ("in the 6 ICRs read…"). |

These design choices target the most likely ways to fail:

1. **Wrong "latest" document:** always sort by document date, never rely on relevance order, and show both document and disclosure dates.
2. **Wrong document type:** terms such as "PAD" or "restructuring paper" are resolved against the live list of WDS document types (§7.1), and the result says how. The table below is **not a lookup**: it gives examples for tool descriptions and skills, so the client's model knows the vocabulary.

   | Query wording | WDS document type |
   |---|---|
   | PAD | Project Appraisal Document |
   | ISR | Implementation Status and Results Report |
   | ICR | Implementation Completion and Results Report |
   | ESCP | Environmental and Social Commitment Plan |
   | Financing agreement | Financing Agreement / Loan Agreement |
   | Restructuring paper | Project Paper / Restructuring Paper |
   | Program document | Program Document (development policy operations) |
   | Program appraisal document | Program Appraisal Document (Program-for-Results) |
   | Procurement plan | Procurement Plan |

3. **Missing evidence in long documents:** the outline and keyword-matched pages of the whole text, then the client's model reads further page ranges itself, including tables (indicators, procurement packages).
4. **Over-claiming:** coverage notes and source labels are in every tool result.
5. **The client model using the tools badly:** tool descriptions, next-step hints and the skills served by `retrieve_skill` (§4.2) give Claude, GPT and Gemini the same workflow, **with no skill installed**.

---

## 10. Evaluation (requirement 6)

### 10.1 Evaluation set

- **Source:** all **41** queries in the expected-queries doc (Q1: 9, Q2: 5, Q3: 16, Q4: 11), each turned into a test case.
- **Placeholders resolved:** "Pxxxxxx", "P123456", "this report number", "this author" and similar are replaced with **real projects and documents** chosen because the needed public documents exist. For example, a project with a PAD, a financing agreement, at least 3 ISRs, a restructuring paper and an ICR.
- **Multi-turn cases:** queries that refer back ("those results", "Did that change…") become 2-turn conversations.
- **Each case records:** the query or turns, any fixed context, the **expected sources**, a **reference answer** checked by a person against the source documents, and the scoring rubric.

### 10.2 What "accurate" means (pass/fail per case)

A case passes only if **all** of the following hold:

1. **Right sources.** The expected records and documents are used.
2. **Grounded.** Every factual claim is supported by a cited source. Nothing is invented: no fabricated IDs, numbers, links or page references.
3. **Complete.** Every part of the question is addressed, or plainly marked as not available in public sources.
4. **Scoped.** Coverage and source limits are stated where they matter.

### 10.3 Harness and launch gate

- **Agent under test:** a fixed reference agent connects to `https://worldbank-mcp.manzia.com/mcp` and answers each case using **only what the server provides**: tools, descriptions and `retrieve_skill`, with nothing installed and no extra prompt, exactly as users have it. The default is Claude Sonnet 5.5 on Bedrock, pinned to a version.
- **Judge:** a judge model (Claude Opus 5.5 on Bedrock) scores each answer against the rubric and the reference answer. **A person reviews every failure and at least 25% of passes** before sign-off.
- **Stability:** each case runs **3 times**, and passes if at least 2 of 3 runs pass.
- **Launch gate:** **at least 37 of 41 cases (≥ 90%)** pass on the production stack. In addition, a manual acceptance test covers requirement 1: someone adds the URL as a custom connector in the **Claude, ChatGPT and Gemini web apps**, confirms the tools appear, and completes one query from each tier with citations.
- **Where it runs:** on demand, before launch and before releases. It is not part of the production stack.

---

## 11. Security & operations

- **Exposure:** only `worldbank-mcp.manzia.com` is advertised. The gateway's own hostname rejects traffic that doesn't come through CloudFront (§8.2). The MCP server's function URL accepts only SigV4-signed requests from the gateway service role. It calls out only to `search.worldbank.org`, `documents1.worldbank.org`, Bedrock and its own vocabulary object in S3.
- **No user data:** nothing is stored. Logs record the tool name, arguments, timing and upstream status codes, never document contents. Logs are kept 30 days.
- **Deploys:** the existing pipeline (PR → CI → approval → OIDC deploy). New IAM roles comply with the permissions boundary rule. The origin secret is rotated by hand, with a redeploy.
- **Monitoring (A3, approved):** CloudWatch alarms notify an SNS topic, which e-mails the operator, on:
  - tool errors, and p95 tool duration above 30 s;
  - gateway throttling (rate limits hit);
  - a spike in `WafBlocks`, and any `WafFailCloses`;
  - CloudFront 5xx errors;
  - Bedrock throttling;
  - a failed vocabulary refresh, or a snapshot older than 35 days.

  There's also one CloudWatch dashboard for these metrics, and an **AWS Budgets** alert on monthly spend.

---

## 12. Risks & open items

| Risk | Impact | Mitigation / next step |
|---|---|---|
| `documents1.worldbank.org` access changes, for example if Cloudflare bot protection is extended to it | `read_document` stops working, putting about two-thirds of the evaluation at risk | Check access at the start of the build. Consider contacting the World Bank about its terms of use and a sanctioned access path. Handle failures gracefully. |
| Keep-alive pings or progress events don't make it through the gateway or CloudFront | Long reads time out at CloudFront after 60 s | Verified in build step 1 (§6.2). Fallback: keep `read_document` under about 55 s by reading in page-range chunks. |
| Changes in MCP TypeScript SDK v2 (a new protocol revision in 2026) | Breakage on upgrade | Pin versions. Upgrade deliberately, with the evaluation run as the check. |
| The tool-list re-sync step is skipped or fails after a deploy | Clients see stale tool definitions | The pipeline runs the re-sync and fails the deploy if it fails |
| Legal and E&S documents aren't publicly disclosed for the chosen evaluation projects | Some Q3/Q4 cases can't be answered | Choose evaluation projects where these documents are disclosed. Answers state when a document isn't public. |
| Procurement and results tables lose their layout in plain text | Wrong figures in table answers | Return wider page ranges for tables. Fall back to PDF text for table pages if evaluation shows errors. |
| Some clients don't call `retrieve_skill`, or weight server-provided guidance less than an installed skill | Lower accuracy in that client | Keep the key rules in tool results as well, not just descriptions. The manual acceptance test checks each app. |
| CloudFormation lacks support for a gateway setting | Some settings can't be expressed in the template | Apply that setting with a post-deploy CLI step in the pipeline |
| Bedrock Haiku 5.5 quota | Haiku calls throttled | Check the quota before launch. Keyword-only fallback is built in. |
| The World Bank renames or adds values (a region, a document type) | Terms resolve to outdated values | The snapshot refreshes every 30 days and after each deploy; a failed refresh alarms. |
| Keyword matching misses the right pages of a long document | The client's model doesn't see the evidence | The outline lets it ask for the right section; Haiku re-ranking can be added back if the evaluation shows a gap. |
| Rate limits fail open | Unbounded load during an outage of the rate-limit service | WAF per-IP rules stay active. CloudWatch alarms flag unusual load (A3). A concurrency cap (A1) can be revisited. |

---

## 13. Decision log

| ID | Item | Status |
|---|---|---|
| D1 | Streaming and target type | **Decided: option B.** MCP server on Lambda (official TypeScript SDK) behind an IAM-auth streaming function URL, as an MCP-server target (§6) |
| D2 | Does Gemini need sign-in? | **Resolved:** no. Your test with the AWS Knowledge MCP Server worked without sign-in. |
| D3 | Gemini Enterprise and app eligibility | **Removed:** eligibility is up to users and their plans, not this design |
| A1 | Lambda reserved concurrency | **Declined for now:** revisit later |
| A2 | DynamoDB cache | **On hold.** Considered 2026-11-19 for `read_document` outlines: not useful alone, because `documents1` serves only whole files, so a cached outline still needs the full fetch (about 0.15 s). |
| A3 | CloudWatch alarms + dashboard + AWS Budgets alert | **Approved**: in the design (§11) |
| A4 | Custom domain `worldbank-mcp.manzia.com` | **Approved**: in the design (§3, §4.4) |
| A5 | OAuth inbound auth | **Rejected** |
| A6 | Automated refresh of the AI-platform IP set | **On hold** |
| A7 | Scheduled or CI evaluation runs | **Rejected** |
| A8 | WAF logging | **Rejected** |
| A9 | Plugin and skill packaging, directory listings | **Removed:** users install nothing. Skills are served by the server through `retrieve_skill` (§4.2). |
| A10 | Vocabulary snapshot in S3, refreshed every 30 days by EventBridge Scheduler and after each deploy | **Approved** 2026-11-19 (§3.2, §7.2) |
| D4 | How documents are read | **Decided** 2026-11-19: outline plus verbatim pages on request, as the AWS Knowledge server does; the client's model reads. Not abstract plus link (abstracts are rare and the official links return 403). Haiku re-ranking off by default (§5.4). |
| D5 | Filter vocabulary | **Decided** 2026-11-19: no hand-written mapping tables. Terms resolve against the live vocabulary: match, fuzzy match, Haiku from the list, then free text; results show the interpretation (§7.1). |
| D6 | Page splitting in `read_document` | **Decided** 2026-11-23: form feeds, else page-footer lines, else fixed-size parts; the coverage note says which (MCP-102 F2; §5.4) |
| D7 | Incomplete facet lists | **Decided** 2026-11-23: best-effort union of partitioned facet queries, each list marked complete or best-effort; values not in a list still resolve live (MCP-102 F4; §7.2) |
| D8 | Gateway connection limit | **Decided** 2026-11-23: left out; per-tool and target request budgets and the WAF per-IP rules cap load (MCP-102 F7; §8.3) |
| WAF | AWS managed Bot Control | **Excluded** for cost (§8) |

---

## 14. Build sequence

1. **Walking skeleton:** the stack end to end (domain, CloudFront, both WAFs, gateway, MCP-server target, function URL) with a single test tool. Verify the four points in §6.2. At the same start, check `documents1` access, the Haiku 5.5 quota, and CloudFormation support for gateway settings.
2. **Build the evaluation set:** instantiate the 41 cases and write the reference answers. This comes first so every later step can be measured.
3. **Tool code:** the upstream transport and query building, term resolution, the five tools, the Haiku uses, the skills served by `retrieve_skill`, and the tool descriptions and result hints (§4.2, §5, §7). Unit tests with the 80% coverage gate, as now.
4. **Stack:**
   - Replace the scaffold.
   - Add the delegated hosted zone, certificate and CloudFront distribution.
   - Add both WAF web ACLs, in COUNT mode.
   - Add the gateway (no sign-in, streaming), the MCP-server target with the IAM-auth streaming function URL, the roles, the rate limits, the origin secret and the monitoring.
   - Add the vocabulary bucket, refresh function and 30-day schedule, and the pipeline step that refreshes the snapshot after deploy.
   - Add the pipeline step that re-syncs the gateway target after deploy.
   - One-time manual step: add the NS delegation in the `manzia.com` zone.
5. **Evaluate and iterate** until at least 37 of 41 cases pass.
6. **Harden and accept:** move WAF rules to Block, set the final rate limits, publish the README guide, and run the manual acceptance test in the three web apps.
