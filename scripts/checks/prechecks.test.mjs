// node --test scripts/checks/prechecks.test.mjs  (no network: pure helpers only)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCfn, pageMarkers, parseProjectDate, toDocuments1 } from './prechecks.mjs';

test('toDocuments1 moves the API text link to documents1 /txt/', () => {
  const api = 'http://documents.worldbank.org/curated/en/099122425102515384/text/BOSIB-24e62aba.txt';
  assert.equal(toDocuments1(api), 'https://documents1.worldbank.org/curated/en/099122425102515384/txt/BOSIB-24e62aba.txt');
  assert.equal(toDocuments1(api, 'text'), 'https://documents1.worldbank.org/curated/en/099122425102515384/text/BOSIB-24e62aba.txt');
});

test('parseProjectDate normalises both Projects API date formats', () => {
  assert.equal(parseProjectDate('12/20/2025 12:00:00 AM'), '2025-12-20');
  assert.equal(parseProjectDate('3/1/2026 12:00:00 AM'), '2026-03-01');
  assert.equal(parseProjectDate('2024-12-20T00:00:00Z'), '2024-12-20');
  assert.equal(parseProjectDate(undefined), undefined);
});

const schemas = {
  gw: {
    readOnlyProperties: ['/properties/WebAclArn'],
    definitions: {
      AuthorizerType: { enum: ['CUSTOM_JWT', 'AWS_IAM', 'NONE'] },
      MCPGatewayConfiguration: { properties: { StreamingConfiguration: {} } },
      StreamingConfiguration: { properties: { EnableResponseStreaming: { type: 'boolean' } } },
      WafFailureMode: { enum: ['FAIL_CLOSE', 'FAIL_OPEN'] },
    },
  },
  tgt: {
    definitions: {
      McpTargetConfiguration: { oneOf: [{ title: 'Lambda' }, { title: 'McpServer' }] },
      McpServerTargetConfiguration: { properties: { Endpoint: {} } },
      CredentialProviderType: { enum: ['GATEWAY_IAM_ROLE', 'OAUTH'] },
      CredentialProvider: { oneOf: [{ title: 'IamCredentialProvider' }] },
      IamCredentialProvider: { properties: { Service: {} } },
    },
  },
  rl: {
    properties: { DimensionKeys: { items: { pattern: '^(targetName|toolName)$' } } },
    definitions: { LimitEntry: { properties: { Dimensions: {}, Requests: {} } }, Period: { enum: ['second', 'minute'] } },
  },
  assoc: { definitions: { ResourceArn: { type: 'string' } } },
};

test('evaluateCfn finds every setting in complete schemas', () => {
  const items = evaluateCfn(schemas);
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.ok), JSON.stringify(items.filter((i) => !i.ok)));
});

test('evaluateCfn reports a missing setting as not expressible', () => {
  const gw = structuredClone(schemas.gw);
  gw.definitions.AuthorizerType.enum = ['CUSTOM_JWT'];
  delete gw.definitions.StreamingConfiguration;
  const items = evaluateCfn({ ...schemas, gw, rl: undefined });
  const byItem = Object.fromEntries(items.map((i) => [i.item, i.ok]));
  assert.equal(byItem['Gateway authorizer NONE'], false);
  assert.equal(byItem['Gateway MCP response streaming'], false);
  assert.equal(byItem['Gateway rate limits'], false);
});

test('pageMarkers counts form feeds and centred page footers', () => {
  const text = 'a\n            -2-\n\nb\n   - 11 -\nPage 3 of 9\n\fc\n2.06 text -2- inline\n';
  assert.deepEqual(pageMarkers(text), { formFeeds: 1, footers: 3 });
});
