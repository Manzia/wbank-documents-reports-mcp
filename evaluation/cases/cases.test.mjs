// Checks the evaluation set (MCP-120): 41 cases, Q1 9 / Q2 5 / Q3 16 / Q4 11, each valid against
// case.schema.json, with 3 to 13 cases in each of six regions. Run with `node --test evaluation/cases/cases.test.mjs`. No dependencies: the validator below
// covers the JSON Schema keywords case.schema.json uses, and fails on any other keyword.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '..', 'case.schema.json'), 'utf8'));
const queryDoc = readFileSync(join(here, '..', '..', 'context', 'design', 'wbank-mcp-query-design.md'), 'utf8');
const files = readdirSync(here).filter(f => f.endsWith('.json')).sort();
const cases = files.map(f => ({ file: f, data: JSON.parse(readFileSync(join(here, f), 'utf8')) }));

const KNOWN = new Set(['$schema', '$id', 'title', 'description', '$defs', 'type', 'enum', 'pattern', 'minLength',
  'minItems', 'maxItems', 'items', 'properties', 'required', 'additionalProperties', '$ref', 'minimum']);

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

export function validate(value, s, path = '$', root = s) {
  const errors = [];
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) errors.push(`${path}: schema keyword '${k}' not supported`);
  if (s.$ref) {
    const target = s.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], root);
    return errors.concat(validate(value, target, path, root));
  }
  const t = typeOf(value);
  if (s.type && !(s.type === t || (s.type === 'number' && t === 'integer'))) return [...errors, `${path}: expected ${s.type}, got ${t}`];
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`);
  if (t === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match ${s.pattern}`);
  }
  if (t === 'integer' && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
  if (t === 'array') {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...validate(v, s.items, `${path}[${i}]`, root)));
  }
  if (t === 'object') {
    for (const r of s.required || []) if (!(r in value)) errors.push(`${path}: missing '${r}'`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties) errors.push(...validate(v, s.properties[k], `${path}.${k}`, root));
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected property '${k}'`);
      else if (typeof s.additionalProperties === 'object') errors.push(...validate(v, s.additionalProperties, `${path}.${k}`, root));
    }
  }
  return errors;
}

const normalise = s => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

test('the validator rejects what the schema forbids', () => {
  assert.deepEqual(validate({ a: 'x' }, { type: 'object', required: ['a'], properties: { a: { type: 'string', pattern: '^x$' } } }), []);
  assert.equal(validate({}, { type: 'object', required: ['a'] }).length, 1);
  assert.equal(validate({ b: 1 }, { type: 'object', additionalProperties: false }).length, 1);
  assert.equal(validate('y', { enum: ['x'] }).length, 1);
  assert.equal(validate([], { type: 'array', minItems: 1 }).length, 1);
  assert.equal(validate(1, { type: 'string' }).length, 1);
  assert.equal(validate('a', { type: 'string', oneOf: [] }).length, 1);
});

test('41 cases: Q1 9, Q2 5, Q3 16, Q4 11', () => {
  const counts = {};
  for (const { data } of cases) counts[data.group] = (counts[data.group] || 0) + 1;
  assert.deepEqual(counts, { Q1: 9, Q2: 5, Q3: 16, Q4: 11 });
  assert.equal(cases.length, 41);
});

for (const { file, data } of cases) {
  test(`${file} is a valid case`, () => {
    assert.deepEqual(validate(data, schema), []);
    assert.equal(file.split('-').slice(0, 2).join('-'), data.id, 'file name starts with the case ID');
    const [g, n] = data.id.split('-');
    assert.equal(data.group, g);
    assert.equal(data.query_id, `${g}.${Number(n)}`);
    assert.ok(normalise(queryDoc).includes(normalise(data.query_wording)), 'query_wording appears verbatim in the expected-queries doc');
    assert.equal(data.reference_answer.turns.length, data.turns.length, 'one reference answer per turn');
    data.reference_answer.turns.forEach((t, i) => assert.equal(t.turn, i + 1));
    for (const t of data.turns) assert.doesNotMatch(t.user, /Pxxxxxx|P123456|this report number|this author/i, 'placeholders replaced');
    for (const s of data.expected_sources) {
      if (s.kind === 'document') assert.ok(s.document_id, 'document sources name a document ID');
      if (s.kind === 'project') assert.ok(s.project_id, 'project sources name a project ID');
      if (s.kind === 'search') assert.ok(s.api && s.filters, 'search sources name the API and filters');
      if (s.turn !== undefined) assert.ok(s.turn <= data.turns.length);
    }
  });
}

const REGIONS = ['Africa', 'East Asia & Pacific', 'Europe & Central Asia', 'Latin America & Caribbean',
  'Middle East & North Africa', 'South Asia'];

test('each of the six regions has 3 to 13 cases', () => {
  for (const r of REGIONS) {
    const n = cases.filter(c => c.data.region === r).length;
    assert.ok(n >= 3 && n <= 13, `${r}: ${n} cases`);
  }
});

test('Pxxxxxx and P123456 cases each sit in one region, different from each other and not Africa', () => {
  const regionOf = re => [...new Set(cases.filter(c => re.test(c.data.query_wording)).map(c => c.data.region))];
  const q3 = regionOf(/Pxxxxxx/);
  const q4 = regionOf(/P123456/);
  assert.equal(q3.length, 1, `Pxxxxxx regions: ${q3}`);
  assert.equal(q4.length, 1, `P123456 regions: ${q4}`);
  assert.notEqual(q3[0], q4[0]);
  for (const r of [q3[0], q4[0]]) assert.ok(REGIONS.includes(r) && r !== 'Africa', r);
});

test('case IDs and query IDs are unique', () => {
  assert.equal(new Set(cases.map(c => c.data.id)).size, cases.length);
  assert.equal(new Set(cases.map(c => c.data.query_id)).size, cases.length);
});
