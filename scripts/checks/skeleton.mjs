#!/usr/bin/env node
// Walking-skeleton checks (MCP-115, plan §5.3, design §6.2 points 1–3). Read-only: MCP requests to the
// public endpoint, the gateway and the function URL, plus AWS and GitHub reads. One PASS/FAIL/BLOCKED
// line per check.
//
//   node scripts/checks/skeleton.mjs [--only 1,2] [--seconds 90] [--since <ISO time>] [--json out.json]
//
// Needs Node 24, the AWS CLI (read access, us-east-1) and gh. --since sets the start of the WAF metric
// window for check 6 (default: when this run started), so check 6 can be re-run once metrics land.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain && (process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(r.status ?? 1);
}

const REGION = 'us-east-1';
const STACK = 'wbank-docs-reports-mcp-prod';
const REPO = 'Manzia/wbank-documents-reports-mcp';
const PROTOCOL = '2025-06-18';
const ACCEPT = 'application/json, text/event-stream';
const UA = 'wbank-docs-reports-mcp-skeleton-check (+https://github.com/Manzia/wbank-documents-reports-mcp)';
const TOOLS = ['diagnostic', 'get_project', 'read_document', 'retrieve_skill', 'search_documents', 'search_projects'];
const MAX_GAP_S = 60;
const RESYNC_STEP = 'Re-sync gateway target';
const RATE_RULES = ['ai-platform-rate', 'per-ip-rate'];

const log = (msg) => process.stderr.write(`  · ${msg}\n`);

// ---------- pure helpers (unit-tested) ----------

// Splits an SSE byte stream into events as they complete. A comment-only event (":") is a keep-alive ping.
export function createSseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n?/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = [];
      let comment = false;
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) comment = true;
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ data: data.join('\n') });
      else if (comment) onEvent({ ping: true });
    }
  };
}

export function classifyEvent(ev) {
  if (ev.ping) return { kind: 'ping' };
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return { kind: 'other' };
  }
  if (msg.method === 'notifications/progress') return { kind: 'progress', progress: msg.params?.progress, message: msg.params?.message };
  if (msg.method) return { kind: 'notification', method: msg.method };
  if (msg.error) return { kind: 'error', code: msg.error.code, message: msg.error.message, msg };
  if ('result' in msg) return { kind: 'result', msg };
  return { kind: 'other' };
}

// Largest silence between response start, each event and the end of the stream, in seconds.
export function maxGap(offsets, end) {
  let prev = 0;
  let gap = 0;
  for (const t of [...offsets, end]) {
    gap = Math.max(gap, t - prev);
    prev = t;
  }
  return Math.round(gap * 10) / 10;
}

export function checkToolList(tools) {
  const problems = [];
  const names = tools.map((t) => t.name).sort();
  const want = TOOLS.map((t) => `wb___${t}`);
  if (names.length !== 6) problems.push(`${names.length} tools, expected 6`);
  for (const n of want) if (!names.includes(n)) problems.push(`missing ${n}`);
  for (const n of names) if (!want.includes(n)) problems.push(`unexpected ${n}`);
  for (const t of tools) {
    const a = t.annotations ?? {};
    if (a.readOnlyHint !== true) problems.push(`${t.name}: readOnlyHint ${a.readOnlyHint}`);
    if (a.destructiveHint !== false) problems.push(`${t.name}: destructiveHint ${a.destructiveHint}`);
  }
  return { names, problems };
}

export function rpcError(body) {
  try {
    const m = JSON.parse(body);
    return m?.error ? { code: m.error.code, message: m.error.message } : null;
  } catch {
    const ev = [];
    createSseParser((e) => ev.push(e))(`${body}\n\n`);
    for (const e of ev) {
      const c = classifyEvent(e);
      if (c.kind === 'error') return { code: c.code, message: c.message };
    }
    return null;
  }
}

// ---------- HTTP ----------

let rpcId = 0;
const rpc = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) });

const headers = () => ({
  'Content-Type': 'application/json',
  Accept: ACCEPT,
  'MCP-Protocol-Version': PROTOCOL,
  'User-Agent': UA,
});

async function post(url, body, { timeoutMs = 30000, signed = true } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: signed ? headers() : { 'Content-Type': 'application/json', 'User-Agent': UA },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), proxyError: res.headers.get('x-proxy-error'), body: text };
}

function parseRpc(r) {
  if (r.type?.includes('text/event-stream')) {
    const ev = [];
    createSseParser((e) => ev.push(e))(`${r.body}\n\n`);
    for (const e of ev) {
      const c = classifyEvent(e);
      if (c.kind === 'result' || c.kind === 'error') return c.msg ?? { error: { code: c.code, message: c.message } };
    }
    return null;
  }
  return JSON.parse(r.body);
}

// ---------- AWS / GitHub ----------

function run(cmd, args, env) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, env: env && { ...process.env, ...env } });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).trim().split('\n').at(-1) };
  }
}

function aws(args) {
  const r = run('aws', [...args, '--region', REGION, '--output', 'json']);
  return r.ok ? { ok: true, data: r.out.trim() ? JSON.parse(r.out) : null } : r;
}

function stackOutputs() {
  const r = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
  if (!r.ok) throw new Error(`describe-stacks: ${r.error}`);
  const s = r.data.Stacks[0];
  return { status: s.StackStatus, updated: s.LastUpdatedTime, ...Object.fromEntries(s.Outputs.map((o) => [o.OutputKey, o.OutputValue])) };
}

// ---------- checks ----------

const results = [];
function report(n, title, status, summary, details = {}) {
  results.push({ n, title, status, summary, details });
  process.stdout.write(`${status.padEnd(7)} ${n}. ${title}: ${summary}\n`);
}

async function check1(out) {
  const title = 'initialize and tools/list through the public endpoint';
  const url = out.McpEndpoint;
  const init = await post(url, rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'skeleton-check', version: '1' } }));
  if (init.proxyError) return report(1, title, 'BLOCKED', `local proxy refused ${new URL(url).host}`);
  const im = init.status === 200 ? parseRpc(init) : null;
  const list = await post(url, rpc('tools/list'));
  const lm = list.status === 200 ? parseRpc(list) : null;
  const tools = lm?.result?.tools ?? [];
  const { names, problems } = checkToolList(tools);
  if (!im?.result) problems.unshift(`initialize: HTTP ${init.status} ${init.body.slice(0, 200)}`);
  if (!lm?.result) problems.unshift(`tools/list: HTTP ${list.status} ${list.body.slice(0, 200)}`);
  const details = {
    url,
    accept: ACCEPT,
    initialize: { status: init.status, contentType: init.type, protocolVersion: im?.result?.protocolVersion, serverInfo: im?.result?.serverInfo },
    toolsList: { status: list.status, contentType: list.type, tools: tools.map((t) => ({ name: t.name, annotations: t.annotations })) },
    problems,
  };
  report(1, title, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `6 tools: ${names.join(', ')}; all readOnlyHint true, destructiveHint false`, details);
}

async function check2(out, seconds) {
  const title = `wb___diagnostic seconds=${seconds} through CloudFront`;
  const url = out.McpEndpoint;
  const events = [];
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) / 100) / 10;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: rpc('tools/call', { name: 'wb___diagnostic', arguments: { seconds }, _meta: { progressToken: 'skeleton' } }),
      signal: AbortSignal.timeout((seconds + 120) * 1000),
    });
  } catch (e) {
    return report(2, title, 'FAIL', `request failed: ${e.message}`);
  }
  if (res.headers.get('x-proxy-error')) return report(2, title, 'BLOCKED', 'local proxy refused the endpoint');
  const headersAt = at();
  const type = res.headers.get('content-type');
  let final = null;
  const parse = createSseParser((ev) => {
    const c = classifyEvent(ev);
    const e = { t: at(), kind: c.kind };
    if (c.kind === 'progress') Object.assign(e, { progress: c.progress, message: c.message });
    if (c.kind === 'result') { final = c.msg; e.text = c.msg.result?.content?.[0]?.text; e.isError = c.msg.result?.isError ?? false; }
    if (c.kind === 'error') Object.assign(e, { code: c.code, message: c.message });
    events.push(e);
    log(`${String(e.t).padStart(6)} s  ${e.kind}${e.message ? `  ${e.message}` : ''}${e.text ? `  ${e.text}` : ''}`);
  });
  let streamError;
  try {
    const dec = new TextDecoder();
    for await (const chunk of res.body) parse(dec.decode(chunk, { stream: true }));
  } catch (e) {
    streamError = e.message;
  }
  const end = at();
  const gap = maxGap(events.map((e) => e.t), end);
  const counts = Object.fromEntries(['ping', 'progress', 'result', 'error', 'notification', 'other'].map((k) => [k, events.filter((e) => e.kind === k).length]).filter(([, v]) => v));
  const problems = [];
  if (res.status !== 200) problems.push(`HTTP ${res.status}`);
  if (!type?.includes('text/event-stream')) problems.push(`content-type ${type}`);
  if (!final || final.result?.isError) problems.push('no successful final result');
  if (streamError) problems.push(`stream error after ${end} s: ${streamError}`);
  if (gap >= MAX_GAP_S) problems.push(`gap of ${gap} s`);
  const details = { url, status: res.status, contentType: type, headersAt, end, maxGap: gap, counts, events, problems };
  report(2, title, problems.length ? 'FAIL' : 'PASS',
    `${problems.length ? `${problems.join('; ')}; ` : ''}${events.length} events in ${end} s (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), largest gap ${gap} s`, details);
}

async function check3(out) {
  const title = 'tools/list straight to GatewayUrl without the origin header';
  const url = out.GatewayUrl;
  const r = await post(url, rpc('tools/list'));
  if (r.proxyError) return report(3, title, 'BLOCKED', `local proxy refused ${new URL(url).host}`);
  const err = rpcError(r.body);
  const tools = (() => { try { return parseRpc(r)?.result?.tools?.length; } catch { return undefined; } })();
  const ok = err?.code === -32002 && !tools;
  report(3, title, ok ? 'PASS' : 'FAIL', `HTTP ${r.status}, JSON-RPC error ${err?.code ?? 'none'}${err?.message ? ` (${err.message})` : ''}${tools ? `, ${tools} tools returned` : ''}`,
    { url, status: r.status, contentType: r.type, error: err });
}

async function check4(out) {
  const title = 'unsigned request to FunctionUrl';
  const url = new URL('mcp', out.FunctionUrl).href;
  let r;
  try {
    r = await post(url, rpc('tools/list'), { signed: false });
  } catch (e) {
    return report(4, title, 'BLOCKED', `request failed: ${e.message}: ${e.cause?.code ?? ''}`, { url });
  }
  if (r.proxyError) return report(4, title, 'BLOCKED', `local proxy refused ${new URL(url).host}`, { url });
  let message;
  try { message = JSON.parse(r.body).Message ?? JSON.parse(r.body).message; } catch { /* not JSON */ }
  report(4, title, r.status === 403 ? 'PASS' : 'FAIL', `HTTP ${r.status}${message ? ` (${message})` : ''}`, { url, status: r.status, message });
}

function check5() {
  const title = `last deploy ran "${RESYNC_STEP}" and it passed`;
  const runs = run('gh', ['run', 'list', '--repo', REPO, '--workflow', 'deploy.yml', '--branch', 'main', '--limit', '1', '--json', 'databaseId,headSha,conclusion,createdAt,url']);
  if (!runs.ok) return report(5, title, 'BLOCKED', `gh run list: ${runs.error}`);
  const [last] = JSON.parse(runs.out);
  const jobs = run('gh', ['run', 'view', String(last.databaseId), '--repo', REPO, '--json', 'jobs']);
  if (!jobs.ok) return report(5, title, 'BLOCKED', `gh run view: ${jobs.error}`);
  const steps = JSON.parse(jobs.out).jobs.flatMap((j) => j.steps.map((s) => ({ job: j.name, ...s })));
  const step = steps.find((s) => s.name === RESYNC_STEP);
  // gh caches run logs under ~/.cache, which the session sandbox can't write; a temp cache is enough.
  const cache = mkdtempSync(join(tmpdir(), 'skeleton-gh-'));
  const logs = run('gh', ['run', 'view', String(last.databaseId), '--repo', REPO, '--log'], { XDG_CACHE_HOME: cache });
  rmSync(cache, { recursive: true, force: true });
  const lines = logs.ok ? logs.out.split('\n').filter((l) => l.includes(RESYNC_STEP)) : [];
  // The step's script is echoed into the log too, so match the printed line, not the echo command.
  const synced = lines.some((l) => /\sTarget wb re-synced\.$/.test(l) && !l.includes('echo'));
  const ok = last.conclusion === 'success' && step?.conclusion === 'success' && synced;
  report(5, title, ok ? 'PASS' : 'FAIL',
    `run ${last.databaseId} on ${last.headSha.slice(0, 7)} ${last.conclusion}; step ${step ? step.conclusion : 'missing'}; log ${logs.ok ? `${lines.length} lines for the step${synced ? ', ends "Target wb re-synced."' : ', no "re-synced" line'}` : `unreadable (${logs.error})`}`,
    { run: last, step: step && { job: step.job, name: step.name, conclusion: step.conclusion, startedAt: step.startedAt, completedAt: step.completedAt }, logLines: lines.length, synced });
}

function metricSum(webAcl, metric, rule, start, end) {
  const r = aws(['cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/WAFV2', '--metric-name', metric,
    '--dimensions', `Name=WebACL,Value=${webAcl}`, `Name=Rule,Value=${rule}`,
    '--start-time', start, '--end-time', end, '--period', '60', '--statistics', 'Sum']);
  if (!r.ok) return { error: r.error };
  const points = r.data.Datapoints.sort((a, b) => a.Timestamp.localeCompare(b.Timestamp));
  return { sum: points.reduce((s, p) => s + p.Sum, 0), points: points.map((p) => [p.Timestamp, p.Sum]) };
}

// Decision A (Roy, 2026-11-24, record F1): the rate rules count only an IP over its limit, so test traffic
// can't make them count. Check 6 passes when nothing was blocked and the traffic was counted as allowed;
// the rate rules' counts are reported, and the rules are judged from real traffic in the COUNT week (MCP-170).
function check6(since) {
  const title = 'CloudFront WAF: no BlockedRequests for this traffic, counted as allowed; rate rules 2–3 reported';
  const res = aws(['cloudformation', 'describe-stack-resource', '--stack-name', STACK, '--logical-resource-id', 'CloudFrontWebAcl']);
  if (!res.ok) return report(6, title, 'BLOCKED', `describe-stack-resource: ${res.error}`);
  const webAcl = res.data.StackResourceDetail.PhysicalResourceId.split('|')[0];
  const start = new Date(new Date(since).getTime() - 60000).toISOString();
  const end = new Date(Date.now() + 60000).toISOString();
  const m = {
    allowed: metricSum(webAcl, 'AllowedRequests', 'ALL', start, end),
    blocked: metricSum(webAcl, 'BlockedRequests', 'ALL', start, end),
    ...Object.fromEntries(RATE_RULES.map((r) => [`counted:${r}`, metricSum(webAcl, 'CountedRequests', r, start, end)])),
  };
  const err = Object.entries(m).find(([, v]) => v.error);
  if (err) return report(6, title, 'BLOCKED', `${err[0]}: ${err[1].error}`);
  const counted = RATE_RULES.map((r) => `${r} ${m[`counted:${r}`].sum}`);
  const problems = [];
  if (m.blocked.sum > 0) problems.push(`${m.blocked.sum} blocked`);
  if (!(m.allowed.sum > 0)) problems.push('no AllowedRequests yet (metrics may not have landed)');
  report(6, title, problems.length ? 'FAIL' : 'PASS',
    `${start} to ${end}: allowed ${m.allowed.sum}, blocked ${m.blocked.sum}, counted ${counted.join(', ')}${problems.length ? `; ${problems.join('; ')}` : ''}`,
    { webAcl, start, end, metrics: m, problems });
}

// ---------- main ----------

function args(argv) {
  const a = { only: null, seconds: 90, since: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--only') a.only = new Set(argv[++i].split(',').map(Number));
    else if (k === '--seconds') a.seconds = Number(argv[++i]);
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!(a.seconds >= 0 && a.seconds <= 120)) throw new Error('--seconds must be 0 to 120');
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  const started = new Date().toISOString();
  const want = (n) => !a.only || a.only.has(n);
  const head = run('git', ['rev-parse', 'origin/main']);
  const out = stackOutputs();
  log(`stack ${STACK} ${out.status}, updated ${out.updated}; origin/main ${head.ok ? head.out.trim() : '?'}`);
  if (want(1)) await check1(out);
  if (want(2)) await check2(out, a.seconds);
  if (want(3)) await check3(out);
  if (want(4)) await check4(out);
  if (want(5)) check5();
  if (want(6)) {
    if (!a.since) log('WAF metrics arrive a few minutes late; re-run with --only 6 --since <start> if counts are missing');
    check6(a.since ?? started);
  }
  const summary = { started, finished: new Date().toISOString(), originMain: head.ok ? head.out.trim() : null, stack: { status: out.status, updated: out.updated }, results };
  if (a.json) writeFileSync(a.json, `${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = results.every((r) => r.status === 'PASS') ? 0 : 1;
}

if (isMain) await main();
