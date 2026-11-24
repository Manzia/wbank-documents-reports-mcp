// node --test scripts/checks/skeleton.test.mjs  (no network: pure helpers only)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkToolList, classifyEvent, createSseParser, maxGap, rpcError } from './skeleton.mjs';

test('createSseParser yields data events and comment pings across chunk boundaries', () => {
  const ev = [];
  const feed = createSseParser((e) => ev.push(e));
  feed('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":0}}\r\n\r\n:');
  feed('\n\ndata: {"jsonrpc":"2.0",');
  assert.equal(ev.length, 2);
  feed('"id":1,"result":{}}\n\n');
  assert.deepEqual(ev[1], { ping: true });
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.map((e) => classifyEvent(e).kind), ['progress', 'ping', 'result']);
});

test('classifyEvent tells errors, other notifications and junk apart', () => {
  assert.equal(classifyEvent({ data: '{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"x"}}' }).code, -32002);
  assert.equal(classifyEvent({ data: '{"jsonrpc":"2.0","method":"notifications/message"}' }).kind, 'notification');
  assert.equal(classifyEvent({ data: 'not json' }).kind, 'other');
});

test('maxGap includes the silence before the first event and after the last', () => {
  assert.equal(maxGap([0.3, 10.2, 15.1, 20.3], 90.4), 70.1);
  assert.equal(maxGap([45, 50], 51), 45);
  assert.equal(maxGap([], 12), 12);
});

const tool = (name, annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }) => ({ name, annotations });
const six = ['diagnostic', 'get_project', 'read_document', 'retrieve_skill', 'search_documents', 'search_projects'].map((t) => tool(`wb___${t}`));

test('checkToolList accepts the six prefixed read-only tools', () => {
  assert.deepEqual(checkToolList(six).problems, []);
});

test('checkToolList reports missing, extra and non-read-only tools', () => {
  const tools = [...six.slice(1), tool('wb___write_thing', { readOnlyHint: false, destructiveHint: true })];
  assert.deepEqual(checkToolList(tools).problems, [
    'missing wb___diagnostic',
    'unexpected wb___write_thing',
    'wb___write_thing: readOnlyHint false',
    'wb___write_thing: destructiveHint true',
  ]);
});

test('rpcError reads JSON and SSE bodies', () => {
  assert.deepEqual(rpcError('{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Forbidden"}}'), { code: -32002, message: 'Forbidden' });
  assert.deepEqual(rpcError('data: {"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Forbidden"}}'), { code: -32002, message: 'Forbidden' });
  assert.equal(rpcError('{"jsonrpc":"2.0","id":1,"result":{}}'), null);
});
