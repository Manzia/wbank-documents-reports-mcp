#!/usr/bin/env node
// Build prechecks (MCP-102, plan §5.2). Read-only probes of the World Bank APIs, Bedrock, Service
// Quotas, the CloudFormation registry and npm. Prints one PASS/FAIL/BLOCKED line per check.
//
//   node scripts/checks/prechecks.mjs [--only 2,3] [--json results.json]
//
// Needs Node 24, the AWS CLI with read access in us-east-1 (checks 4 and 5) and npm (check 6).
// BLOCKED means the environment, not the target, refused the request (e.g. a sandbox proxy).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const WDS = 'https://search.worldbank.org/api/v3/wds';
const PROJECTS = 'https://search.worldbank.org/api/v2/projects';
const DOCS = 'documents.worldbank.org';
const DOCS1 = 'documents1.worldbank.org';
const REGION = 'us-east-1';
const UA = 'wbank-docs-reports-mcp-prechecks (+https://github.com/Manzia/wbank-documents-reports-mcp)';
const FACET_CAP = 100;
const FACET_BUDGET = 200;
const PROJECT_ID = 'P117635';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`  · ${msg}\n`);

// ---------- HTTP ----------

const lastCall = new Map();
const PACE_MS = { 'search.worldbank.org': 3000 };
let requestCount = 0;

export async function http(url, { redirect = 'follow', retries = 5 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + (PACE_MS[host] ?? 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    requestCount++;
    let res;
    try {
      res = await fetch(url, { redirect, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (attempt < retries) { await sleep(5000 * (attempt + 1)); continue; }
      return { url, status: 0, unreachable: true, error: `${e.message}: ${e.cause?.message ?? e.cause?.code ?? ''}` };
    }
    if (res.status === 403 && res.headers.get('x-proxy-error')) {
      return { url, status: 403, blocked: true, error: `blocked by local proxy (${res.headers.get('x-proxy-error')})` };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await res.arrayBuffer().catch(() => {});
      log(`${res.status} from ${host}, retrying`);
      await sleep(6000 * (attempt + 1));
      continue;
    }
    const body = await res.text();
    return { url, status: res.status, location: res.headers.get('location'), server: res.headers.get('server'), body };
  }
}

async function api(base, params) {
  const url = `${base}?${new URLSearchParams({ format: 'json', ...params })}`;
  const r = await http(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.error ?? ''} for ${url}`);
  const d = JSON.parse(r.body);
  const bag = d.documents ?? d.projects ?? {};
  const records = Object.entries(bag).filter(([k]) => k !== 'facets').map(([, v]) => v);
  return { url, total: Number(d.total), records, facets: bag.facets ?? d.facets ?? {} };
}

// ---------- results ----------

const results = [];
function report(n, title, status, summary, details, requests) {
  results.push({ check: n, title, status, summary, details, requests });
  process.stdout.write(`${status.padEnd(7)} ${n}. ${title}: ${summary}\n`);
  for (const d of details) process.stdout.write(`          ${d}\n`);
}
const worst = (...s) => (s.includes('FAIL') ? 'FAIL' : s.includes('BLOCKED') ? 'BLOCKED' : 'PASS');

// ---------- check 2: document text ----------

const DOC_TYPES = [
  { label: 'ICR', types: ['Implementation Completion and Results Report'] },
  { label: 'PAD', types: ['Project Appraisal Document'] },
  { label: 'ISR', types: ['Implementation Status and Results Report'] },
  { label: 'Financing agreement', types: ['Financing Agreement', 'Loan Agreement'] },
  { label: 'Procurement plan', types: ['Procurement Plan'] },
];
const FL = 'id,docty,docdt,repnb,display_title,txturl,projectid';

let projectListCache;
async function projectList() {
  projectListCache ??= await api(WDS, { proid: PROJECT_ID, rows: '200', srt: 'docdt', order: 'desc', fl: FL });
  return projectListCache;
}

export function toDocuments1(txturl, path = 'txt') {
  const u = new URL(txturl);
  u.protocol = 'https:';
  u.host = DOCS1;
  u.pathname = u.pathname.replace(/\/text\//, `/${path}/`);
  return u.toString();
}

const SAMPLES_PER_TYPE = 3;

// The P117635 record of each type first, then the newest records of that type elsewhere.
async function pickDocuments() {
  const list = await projectList();
  const picks = [];
  const requests = [list.url];
  for (const t of DOC_TYPES) {
    const recs = list.records.filter((r) => t.types.includes(r.docty) && r.txturl).slice(0, 1);
    for (const docty of t.types) {
      if (recs.length >= SAMPLES_PER_TYPE) break;
      const q = await api(WDS, { docty_exact: docty, rows: '10', srt: 'docdt', order: 'desc', fl: FL });
      requests.push(q.url);
      recs.push(...q.records.filter((r) => r.txturl && !recs.some((x) => x.id === r.id)).slice(0, SAMPLES_PER_TYPE - recs.length));
    }
    picks.push({ label: t.label, recs });
  }
  return { picks, requests };
}

export function pageMarkers(text) {
  return {
    formFeeds: (text.match(/\f/g) ?? []).length,
    footers: (text.match(/^[ \t]*(?:-[ \t]*\d{1,4}[ \t]*-|Page[ \t]+\d{1,4}(?:[ \t]+of[ \t]+\d+)?)[ \t]*$/gim) ?? []).length,
  };
}

async function checkDocuments() {
  const { picks, requests } = await pickDocuments();
  const details = [];
  const statuses = [];
  for (const { label, recs } of picks) {
    if (!recs.length) { statuses.push('FAIL'); details.push(`${label}: no record with a text link found`); continue; }
    let withFf = 0;
    let all200 = true;
    let docs;
    const lines = [];
    for (const [i, rec] of recs.entries()) {
      const d1 = toDocuments1(rec.txturl);
      const r1 = await http(d1);
      requests.push(d1);
      const m = r1.status === 200 ? pageMarkers(r1.body) : { formFeeds: 0, footers: 0 };
      all200 &&= r1.status === 200;
      if (m.formFeeds > 0) withFf++;
      let docsNote = '';
      if (i === 0) {
        const original = new URL(rec.txturl);
        original.protocol = 'https:';
        docs = await http(original.toString(), { redirect: 'manual', retries: 1 });
        requests.push(original.toString());
        docsNote = `; ${DOCS} ${docs.blocked || docs.unreachable ? `not reachable from here (${docs.error})` : docs.status + (docs.server ? ` (${docs.server})` : '')}`;
      }
      lines.push(`  ${rec.docty}, ${rec.docdt?.slice(0, 10)}, id ${rec.id}${rec.projectid ? `, ${rec.projectid}` : ''}: ` +
        `/txt/ ${r1.status}, ${r1.body?.length ?? 0} chars, ${m.formFeeds} form feeds, ${m.footers} page-footer lines${docsNote}`);
    }
    const okText = all200 && withFf === recs.length;
    const docsBlocked = docs.blocked || docs.unreachable;
    statuses.push(!okText ? 'FAIL' : docsBlocked ? 'BLOCKED' : docs.status === 403 ? 'PASS' : 'FAIL');
    details.push(`${label}: ${DOCS1} 200 for ${all200 ? 'all' : 'NOT all'}; form feeds in ${withFf}/${recs.length}`, ...lines);
  }
  const status = worst(...statuses);
  const n = statuses.filter((s) => s === 'PASS').length;
  report(2, 'Document text', status, `${n}/${picks.length} document types as expected` +
    (statuses.includes('BLOCKED') ? `; ${DOCS} not reachable from this environment (run --only 2 outside the sandbox)` : ''),
  details, requests);
}

// ---------- check 3: WDS and Projects API ----------

const monotone = (xs, dir) => xs.every((x, i) => i === 0 || (dir === 'desc' ? xs[i - 1] >= x : xs[i - 1] <= x));
export function parseProjectDate(s) {
  if (!s) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s.slice(0, 10);
}

// Facets stop at FACET_CAP values. A list that hits the cap is rebuilt from the union of the same
// facet within each value of a partition field (recursively), and flagged if a leaf still hits it.
async function completeFacet(base, field, chain, filters = {}, requests = [], partitionCache = new Map()) {
  const q = await api(base, { rows: '1', fl: 'id', fct: field, ...filters });
  requests.push(q.url);
  const values = new Map(Object.values(q.facets[field] ?? {}).map((v) => [v.name, Number(v.count)]));
  if (values.size < FACET_CAP) return { values, complete: true, total: q.total };
  const [part, ...rest] = chain.filter((c) => c !== field && !(c in filters) && !(c === YEARS && 'strdate' in filters));
  if (!part) return { values, complete: false, total: q.total, capped: [JSON.stringify(filters)] };
  let parts;
  if (part === YEARS) {
    parts = YEAR_RANGES.map(([strdate, enddate]) => ({ strdate, enddate }));
  } else {
    const pkey = `${part}|${JSON.stringify(filters)}`;
    if (!partitionCache.has(pkey)) {
      const p = await api(base, { rows: '1', fl: 'id', fct: part, ...filters });
      requests.push(p.url);
      partitionCache.set(pkey, Object.values(p.facets[part] ?? {}).map((v) => v.name).filter(Boolean));
    }
    parts = partitionCache.get(pkey).map((pv) => ({ [part]: pv }));
  }
  let complete = true;
  let covered = 0;
  const unmatched = [];
  const capped = [];
  for (const pf of parts) {
    if (requests.length - (partitionCache.start ??= requests.length) >= FACET_BUDGET) {
      complete = false;
      capped.push(`request budget (${FACET_BUDGET}) reached`);
      break;
    }
    const sub = await completeFacet(base, field, rest, { ...filters, ...pf }, requests, partitionCache);
    if (sub.total === 0) unmatched.push(JSON.stringify({ ...filters, ...pf }));
    complete &&= sub.complete;
    capped.push(...(sub.capped ?? []));
    unmatched.push(...(sub.unmatched ?? []));
    covered += sub.total;
    for (const [k, c] of sub.values) values.set(k, Math.max(values.get(k) ?? 0, c));
  }
  // A partition that doesn't cover every record (records without that field) can miss values.
  if (complete && covered < q.total) {
    complete = false;
    capped.push(`${JSON.stringify(filters)}: ${q.total - covered} records not covered by ${part}`);
  }
  return { values, complete, total: q.total, unmatched, capped };
}

const YEARS = '@years';
const YEAR_RANGES = [
  ['1900-01-01', '1989-12-31'], ['1990-01-01', '1999-12-31'], ['2000-01-01', '2009-12-31'],
  ['2010-01-01', '2014-12-31'], ['2015-01-01', '2019-12-31'], ['2020-01-01', '2022-12-31'],
  ['2023-01-01', '2099-12-31'],
];

const WDS_FACETS = [
  ['countries', 'count_exact'],
  ['regions', 'admreg_exact'],
  ['document types', 'docty_exact'],
  ['languages', 'lang_exact'],
];
const PROJECT_FACETS = [
  ['countries', 'countryshortname_exact'],
  ['regions', 'regionname_exact'],
  ['sectors', 'sector_exact'],
  ['themes', 'theme_exact'],
  ['statuses', 'status_exact'],
];

// Parameters from the API documentation; each filter is confirmed live by narrowing the total.
const WDS_PARAMS = [
  ['qterm', { qterm: '"road fund"' }],
  ['proid', { proid: PROJECT_ID }],
  ['count_exact', { count_exact: 'Kenya' }],
  ['admreg_exact', { admreg_exact: 'Eastern and Southern Africa' }],
  ['docty_exact', { docty_exact: 'Procurement Plan' }],
  ['majdocty_exact', { majdocty_exact: 'Project Documents' }],
  ['lang_exact', { lang_exact: 'French' }],
  ['strdate+enddate', { strdate: '2020-01-01', enddate: '2020-12-31' }],
  ['repnb', { repnb: 'ICR00185' }],
  ['id', { id: '40079232' }],
  ['guid', { guid: '099122425102515384' }],
  ['display_title', { display_title: 'Shizuoka' }],
  ['authr', { authr: 'Kraay' }],
  ['colti', { colti: 'Policy Research working paper' }],
  ['lndinstr_exact', { lndinstr_exact: 'Investment Project Financing' }],
];
const PROJECT_PARAMS = [
  ['qterm', { qterm: 'irrigation' }],
  ['id', { id: PROJECT_ID }],
  ['countrycode_exact', { countrycode_exact: 'KE' }],
  ['countryshortname_exact', { countryshortname_exact: 'Kenya' }],
  ['regionname_exact', { regionname_exact: 'Eastern and Southern Africa' }],
  ['status_exact', { status_exact: 'Active' }],
  ['sector_exact', { sector_exact: 'Health' }],
  ['theme_exact', { theme_exact: 'Rural services and infrastructure' }],
  ['strdate+enddate', { strdate: '2024-01-01', enddate: '2024-12-31' }],
  ['frmYear+toYear', { frmYear: '2024', toYear: '2024' }],
  ['lendinginstr_exact', { lendinginstr_exact: 'Investment Project Financing' }],
];

async function checkParams(name, base, params, requests) {
  const baseline = await api(base, { rows: '1', fl: 'id' });
  requests.push(baseline.url);
  const lines = [];
  const honoured = [];
  for (const [label, p] of params) {
    const q = await api(base, { rows: '1', fl: 'id', ...p });
    requests.push(q.url);
    const ok = q.total > 0 && q.total < baseline.total;
    if (ok) honoured.push(label);
    lines.push(`${label}=${Object.values(p).join('..')}: ${q.total} of ${baseline.total}${ok ? '' : ' (not honoured)'}`);
  }
  const two = await api(base, { rows: '2', fl: 'id' });
  const off = await api(base, { rows: '1', os: '1', fl: 'id' });
  const fl = await api(base, { rows: '1', fl: 'id' });
  requests.push(two.url, off.url);
  const controls = {
    rows: two.records.length === 2,
    os: off.records[0]?.id === two.records[1]?.id,
    fl: fl.records[0] && !('docty' in fl.records[0]) && !('status' in fl.records[0]),
  };
  for (const [k, v] of Object.entries(controls)) (v ? honoured : lines).push(v ? k : `${k}: not honoured`);
  const always = fl.records[0] ? Object.keys(fl.records[0]).filter((k) => k !== 'id') : [];
  lines.push(`fl=id still returns: ${always.join(', ') || '(nothing else)'}`);
  return { line: `${name} allow-list (confirmed live): format, srt, order, fct, ${honoured.join(', ')}`, lines, honoured };
}

async function checkApis() {
  const requests = [];
  const details = [];
  const statuses = [];

  for (const order of ['desc', 'asc']) {
    const q = await api(WDS, { srt: 'docdt', order, rows: '50', fl: 'docdt' });
    requests.push(q.url);
    const dated = q.records.map((r) => r.docdt).filter(Boolean);
    const undated = q.records.length - dated.length;
    const ok = q.records.length === 50 && dated.length > 1 && monotone(dated, order);
    statuses.push(ok ? 'PASS' : 'FAIL');
    details.push(`WDS srt=docdt&order=${order}: ${q.records.length} records, ${ok ? 'in' : 'NOT in'} date order ` +
      `(${dated[0]?.slice(0, 10)} … ${dated.at(-1)?.slice(0, 10)})${undated ? `; ${undated} records without docdt sort first` : ''}`);
  }

  const list = await projectList();
  requests.push(list.url);
  statuses.push(list.total >= 129 ? 'PASS' : 'FAIL');
  details.push(`WDS proid=${PROJECT_ID}: total ${list.total} (need ≥ 129), ${list.records.length} returned in one call`);

  const withText = list.records.find((r) => r.txturl);
  if (withText) {
    const textUrl = toDocuments1(withText.txturl, 'text');
    const r = await http(textUrl, { redirect: 'manual' });
    const loc = r.location ? new URL(r.location, textUrl) : undefined;
    const viaTxt = r.status === 301 && loc?.pathname.includes('/txt/');
    const target = toDocuments1(withText.txturl);
    const t = await http(target);
    requests.push(textUrl, target);
    statuses.push(viaTxt && t.status === 200 ? 'PASS' : 'FAIL');
    details.push(`text link of ${withText.id}: ${DOCS1} /text/ → ${r.status} ${loc ? loc.pathname.split('/').slice(0, 5).join('/') + '/…' : ''}; /txt/ → ${t.status}`);
  }

  for (const [api_, base, facets, chain] of [
    ['WDS', WDS, WDS_FACETS, ['majdocty_exact', 'admreg_exact', YEARS]],
    ['Projects', PROJECTS, PROJECT_FACETS, ['regionname_exact', 'status_exact', YEARS]],
  ]) {
    for (const [label, field] of facets) {
      log(`${api_} facet ${field}`);
      const before = requests.length;
      const f = await completeFacet(base, field, chain, {}, requests);
      statuses.push(f.complete && f.values.size > 0 ? 'PASS' : 'FAIL');
      const sample = [...f.values.keys()].slice(0, 4).join(' | ');
      details.push(`${api_} ${label} (${field}): ${f.values.size} values${f.complete ? '' : ' (INCOMPLETE: ' + f.capped.length + ' partitions still hit the cap, e.g. ' + f.capped[0] + ')'}` +
        `, ${requests.length - before} requests${f.unmatched?.length ? `, partitions matching nothing: ${f.unmatched.join('; ')}` : ''}; e.g. ${sample}`);
    }
  }

  for (const [srt, order, extra] of [['boardapprovaldate', 'desc', {}], ['closingdate', 'asc', { status_exact: 'Active' }]]) {
    const q = await api(PROJECTS, { srt, order, rows: '20', fl: `id,${srt}`, ...extra });
    requests.push(q.url);
    const dates = q.records.map((r) => parseProjectDate(r[srt])).filter(Boolean);
    const ok = dates.length > 1 && monotone(dates, order);
    details.push(`Projects srt=${srt}&order=${order}: ${ok ? 'sorted' : 'NOT sorted'} (${dates[0]} … ${dates.at(-1)}) [informational]`);
  }

  for (const [name, base, params] of [['WDS', WDS, WDS_PARAMS], ['Projects', PROJECTS, PROJECT_PARAMS]]) {
    log(`${name} parameters`);
    const p = await checkParams(name, base, params, requests);
    details.push(p.line, ...p.lines.map((l) => `  ${name} ${l}`));
  }

  const status = worst(...statuses);
  report(3, 'WDS and Projects API', status, `${statuses.filter((s) => s === 'PASS').length}/${statuses.length} sub-checks pass`, details, requests);
}

// ---------- AWS CLI ----------

function aws(args) {
  const cmd = ['aws', ...args, '--region', REGION, '--output', 'json'];
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return { cmd: cmd.join(' '), ok: true, data: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    const err = String(e.stderr || e.message).trim().split('\n').at(-1);
    return { cmd: cmd.join(' '), ok: false, error: err };
  }
}

// ---------- check 4: Haiku 5.5 and quotas ----------

const HAIKU = 'us.anthropic.claude-haiku-5-5';

async function checkHaiku() {
  const requests = [];
  const details = [];
  const call = aws(['bedrock-runtime', 'converse', '--model-id', HAIKU,
    '--messages', JSON.stringify([{ role: 'user', content: [{ text: 'Reply with the single word: ok' }] }]),
    '--inference-config', 'maxTokens=10']);
  requests.push(call.cmd.replace(/--messages \S+/, '--messages <one short user message>'));
  const okCall = call.ok && call.data?.stopReason;
  details.push(okCall
    ? `Converse via ${HAIKU}: ${call.data.stopReason}, ${call.data.usage?.inputTokens} in / ${call.data.usage?.outputTokens} out, ${call.data.metrics?.latencyMs} ms`
    : `Converse via ${HAIKU} failed: ${call.error}`);

  const list = aws(['service-quotas', 'list-service-quotas', '--service-code', 'bedrock']);
  requests.push(list.cmd);
  let quotasOk = list.ok;
  if (list.ok) {
    const rx = /Claude (Haiku|Sonnet|Opus) 5\.5/;
    const quotas = list.data.Quotas.filter((q) => rx.test(q.QuotaName) && /(tokens|requests) per minute/i.test(q.QuotaName));
    const models = new Set(quotas.map((q) => rx.exec(q.QuotaName)[1]));
    quotasOk = ['Haiku', 'Sonnet', 'Opus'].every((m) => models.has(m));
    quotas.sort((a, b) => a.QuotaName.localeCompare(b.QuotaName));
    for (const q of quotas) {
      const def = aws(['service-quotas', 'get-aws-default-service-quota', '--service-code', 'bedrock', '--quota-code', q.QuotaCode]);
      requests.push(def.cmd);
      details.push(`${q.QuotaCode} ${q.QuotaName}: applied ${q.Value}, AWS default ${def.ok ? def.data.Quota.Value : '?'}${q.Adjustable ? ', adjustable' : ''}`);
    }
    if (!quotas.some((q) => /requests per minute/i.test(q.QuotaName))) {
      details.push('No requests-per-minute quota is listed for the Claude 5.5 models (tokens per minute only)');
    }
  } else {
    details.push(`list-service-quotas failed: ${list.error}`);
  }
  report(4, 'Haiku 5.5', okCall && quotasOk ? 'PASS' : 'FAIL',
    `${okCall ? 'Converse OK' : 'Converse FAILED'}; quotas ${quotasOk ? 'listed' : 'missing'}`, details, requests);
}

// ---------- check 5: CloudFormation support ----------

function schema(type, requests) {
  const r = aws(['cloudformation', 'describe-type', '--type', 'RESOURCE', '--type-name', type]);
  requests.push(r.cmd);
  return r.ok ? JSON.parse(r.data.Schema) : undefined;
}
const has = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj) !== undefined;
const oneOfTitles = (def) => (def?.oneOf ?? []).map((o) => o.title);

export function evaluateCfn({ gw, tgt, rl, assoc }) {
  const out = [];
  const gd = gw?.definitions ?? {};
  out.push({
    item: 'Gateway authorizer NONE',
    ok: gd.AuthorizerType?.enum?.includes('NONE'),
    how: 'CloudFormation',
    note: `AuthorizerType enum: ${gd.AuthorizerType?.enum?.join(', ')}`,
  });
  out.push({
    item: 'Gateway MCP response streaming',
    ok: has(gd, 'MCPGatewayConfiguration.properties.StreamingConfiguration') &&
      has(gd, 'StreamingConfiguration.properties.EnableResponseStreaming'),
    how: 'CloudFormation',
    note: 'ProtocolConfiguration.Mcp.StreamingConfiguration.EnableResponseStreaming (boolean)',
  });
  const td = tgt?.definitions ?? {};
  out.push({
    item: 'GatewayTarget MCP server with IAM (SigV4, service lambda) outbound auth',
    ok: oneOfTitles(td.McpTargetConfiguration).includes('McpServer') &&
      has(td, 'McpServerTargetConfiguration.properties.Endpoint') &&
      td.CredentialProviderType?.enum?.includes('GATEWAY_IAM_ROLE') &&
      oneOfTitles(td.CredentialProvider).includes('IamCredentialProvider') &&
      has(td, 'IamCredentialProvider.properties.Service'),
    how: 'CloudFormation',
    note: 'TargetConfiguration.Mcp.McpServer.Endpoint; CredentialProviderConfigurations[{CredentialProviderType: GATEWAY_IAM_ROLE, CredentialProvider.IamCredentialProvider.Service: lambda}]',
  });
  const dimPattern = rl?.properties?.DimensionKeys?.items?.pattern ?? '';
  const entry = rl?.definitions?.LimitEntry?.properties ?? {};
  out.push({
    item: 'Gateway rate limits',
    ok: Boolean(rl) && dimPattern.includes('targetName') && dimPattern.includes('toolName') && 'Requests' in entry,
    how: 'CloudFormation',
    note: rl
      ? `AWS::BedrockAgentCore::GatewayRateLimit; dimensions targetName, toolName (also qualifiedModelId, IAM/JWT context); ` +
        `entries: ${Object.keys(entry).filter((k) => k !== 'Dimensions').join(', ')}; periods ${rl.definitions?.Period?.enum?.join('/')}; ` +
        `Connections: "${entry.Connections?.description ?? 'n/a'}"`
      : 'type not found',
  });
  const webAclReadOnly = (gw?.readOnlyProperties ?? []).includes('/properties/WebAclArn');
  const assocArn = assoc?.definitions?.ResourceArn ?? {};
  out.push({
    item: 'WAF web ACL on the gateway',
    ok: Boolean(assoc) && !assocArn.pattern,
    how: 'CloudFormation (AWS::WAFv2::WebACLAssociation, ResourceArn = gateway ARN; unproven until the MCP-113 deploy, fallback: post-deploy CLI step aws wafv2 associate-web-acl)',
    note: `Gateway.WebAclArn is ${webAclReadOnly ? 'read-only' : 'writable'}; Gateway.WafConfiguration.FailureMode: ${gd.WafFailureMode?.enum?.join('/')}; ` +
      `WebACLAssociation.ResourceArn has no pattern (its description names only ALB, CloudFront, API Gateway); ` +
      `the AgentCore guide associates with the same AssociateWebACL API`,
  });
  return out;
}

async function checkCfn() {
  const requests = [];
  const s = {
    gw: schema('AWS::BedrockAgentCore::Gateway', requests),
    tgt: schema('AWS::BedrockAgentCore::GatewayTarget', requests),
    rl: schema('AWS::BedrockAgentCore::GatewayRateLimit', requests),
    assoc: schema('AWS::WAFv2::WebACLAssociation', requests),
  };
  const items = evaluateCfn(s);
  const details = items.flatMap((i) => [`${i.item}: ${i.ok ? i.how : 'post-deploy CLI step'}`, `  ${i.note}`]);
  const ok = items.every((i) => i.ok);
  report(5, 'CloudFormation support', s.gw && s.tgt && s.rl && s.assoc ? 'PASS' : 'FAIL',
    `${items.filter((i) => i.ok).length}/${items.length} settings expressible in CloudFormation`, details, requests);
  return ok;
}

// ---------- check 6: SDK versions ----------

const SDKS = [
  { name: '@modelcontextprotocol/server', exportName: 'createMcpHandler', major: 2 },
  { name: '@hono/aws-lambda', exportName: 'streamHandle' },
  { name: 'hono', peerOnly: true },
];

async function checkSdk() {
  const requests = [];
  const details = [];
  const versions = {};
  let ok = true;
  for (const s of SDKS) {
    const url = `https://registry.npmjs.org/${s.name}`;
    const r = await http(url);
    requests.push(url);
    if (r.status !== 200) { ok = false; details.push(`${s.name}: registry ${r.status} ${r.error ?? ''}`); continue; }
    const meta = JSON.parse(r.body);
    const v = meta['dist-tags'].latest;
    const published = meta.time[v];
    const ageDays = Math.floor((Date.now() - Date.parse(published)) / 86400000);
    const prev = Object.keys(meta.time).filter((k) => /^\d+\.\d+\.\d+$/.test(k) && k !== v).sort((a, b) => Date.parse(meta.time[b]) - Date.parse(meta.time[a]))[0];
    versions[s.name] = v;
    if (s.major && Number(v.split('.')[0]) !== s.major) ok = false;
    const peer = meta.versions[v].peerDependencies;
    details.push(`${s.name}@${v}: published ${published.slice(0, 10)} (${ageDays} days ago)` +
      `${prev ? `; previous ${prev} (${meta.time[prev].slice(0, 10)})` : ''}${peer ? `; peers ${JSON.stringify(peer)}` : ''}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'prechecks-sdk-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"private":true}');
    const specs = SDKS.filter((s) => versions[s.name]).map((s) => `${s.name}@${versions[s.name]}`);
    const args = ['install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...specs];
    requests.push(`npm ${args.join(' ').replace(dir, '<tmpdir>')}`);
    execFileSync('npm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const req = createRequire(join(dir, 'package.json'));
    for (const s of SDKS.filter((x) => x.exportName)) {
      const mod = await import(pathToFileURL(req.resolve(s.name)).href);
      const fn = mod[s.exportName] ?? mod.default?.[s.exportName];
      const found = typeof fn === 'function';
      ok &&= found;
      details.push(`${s.name}@${versions[s.name]} exports ${s.exportName}: ${found ? 'yes (function)' : 'NO'}`);
    }
  } catch (e) {
    ok = false;
    details.push(`install/import failed: ${String(e.stderr ?? e.message).trim().split('\n').at(-1)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  report(6, 'SDK versions', ok ? 'PASS' : 'FAIL',
    Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(', '), details, requests);
}

// ---------- main ----------

const CHECKS = { 2: checkDocuments, 3: checkApis, 4: checkHaiku, 5: checkCfn, 6: checkSdk };

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const only = opt('--only')?.split(',').map(Number) ?? Object.keys(CHECKS).map(Number);
  const jsonOut = opt('--json');
  const started = new Date();
  for (const n of only) {
    if (!CHECKS[n]) continue;
    try {
      await CHECKS[n]();
    } catch (e) {
      report(n, `check ${n}`, 'FAIL', `error: ${e.message}`, [], []);
    }
  }
  const summary = results.every((r) => r.status === 'PASS') ? 'PASS' : worst(...results.map((r) => r.status));
  process.stdout.write(`${summary.padEnd(7)} 1. Prechecks: ${results.length} checks, ${requestCount} HTTP requests, ` +
    `${Math.round((Date.now() - started) / 1000)} s\n`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ started: started.toISOString(), results }, null, 2));
  process.exit(summary === 'PASS' ? 0 : 1);
}

if (isMain) await main();
