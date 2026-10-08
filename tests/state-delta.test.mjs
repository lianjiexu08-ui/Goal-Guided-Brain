import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStateDelta, createStateDelta } from '../lib/state-delta.mjs';
import { createStateResponder } from '../server/http-state.mjs';

const state = () => ({
  tasks: [
    { id: 'a', result: 'old' },
    { id: 'b', result: 'unchanged'.repeat(500) },
  ],
  spaces: [{ id: 'team', name: 'Original', messages: [] }],
  config: { model: 'configured-model' },
  obsolete: true,
});

void test('state deltas reproduce updates, insertion, deletion, reordering, empty collections and scalar changes without mutating the base', () => {
  const base = state();
  const original = structuredClone(base);
  const next = {
    tasks: [
      { id: 'c', result: 'new' },
      base.tasks[1],
      { id: 'a', result: 'changed' },
    ],
    spaces: [],
    config: { model: 'next-model' },
    count: 3,
  };
  const applied = applyStateDelta(
    base,
    createStateDelta(base, next, 'base'),
    'base',
  );
  assert.deepEqual(applied, next);
  assert.equal(applied.tasks[1], base.tasks[1]);
  assert.deepEqual(base, original);
  const deleted = { ...next, tasks: [next.tasks[2], next.tasks[1]] };
  assert.deepEqual(
    applyStateDelta(next, createStateDelta(next, deleted, 'next'), 'next'),
    deleted,
  );
  const cleared = { ...deleted, tasks: [] };
  assert.deepEqual(
    applyStateDelta(
      deleted,
      createStateDelta(deleted, cleared, 'delete'),
      'delete',
    ),
    cleared,
  );
  // IDs are data, including strings that are unsafe as object property names.
  const special = { tasks: [{ id: '__proto__', result: 'literal' }] };
  assert.deepEqual(
    applyStateDelta(base, createStateDelta(base, special, 'base'), 'base'),
    special,
  );
});

void test('malformed or mismatched deltas are rejected atomically', () => {
  const base = state();
  const original = structuredClone(base);
  const valid = createStateDelta(
    base,
    { ...base, tasks: [{ id: 'a', result: 'new' }] },
    'base',
  );
  const variants = [
    null,
    {},
    { ...valid, baseEtag: 'stale' },
    { ...valid, format: 'unknown' },
    { ...valid, set: null },
    { ...valid, remove: ['config', 'config'] },
    { ...valid, set: { tasks: [] } },
    { ...valid, set: JSON.parse('{"__proto__":{"polluted":true}}') },
    {
      ...valid,
      rows: { tasks: { upsert: [{ id: 'a' }, { id: 'a' }], remove: [] } },
    },
    { ...valid, rows: { tasks: { upsert: [], remove: ['missing'] } } },
    { ...valid, rows: { tasks: { upsert: [{ id: 'b' }], remove: ['b'] } } },
    {
      ...valid,
      rows: { tasks: { upsert: [], remove: [], order: ['a', 'a'] } },
    },
    { ...valid, rows: { tasks: { upsert: [], remove: [], order: ['a'] } } },
    {
      ...valid,
      rows: { tasks: { upsert: [], remove: [], order: ['a', 'missing'] } },
    },
    { ...valid, rows: { config: { upsert: [], remove: [] } } },
  ];
  for (const delta of variants) {
    assert.throws(() => applyStateDelta(base, delta, 'base'));
    assert.deepEqual(base, original);
  }
  assert.equal({}.polluted, undefined);
});

function request(send, value, etag, accept = true) {
  const headers = {};
  let status;
  let body;
  send(
    {
      headers: {
        ...(etag ? { 'if-none-match': etag } : {}),
        ...(accept ? { 'x-ggb-state-delta': '1' } : {}),
      },
    },
    {
      setHeader(key, value) {
        headers[key.toLowerCase()] = value;
      },
      writeHead(code) {
        status = code;
      },
      end(value = '') {
        body = value;
      },
    },
    value,
  );
  return { headers, status, body, json: body ? JSON.parse(body) : null };
}

void test('delta opt-in preserves full and 304 responses, falls back on unknown bases and isolates responder instances', () => {
  const send = createStateResponder();
  const base = state();
  const initial = request(send, base);
  const tag = initial.headers.etag;
  const unchanged = request(send, base, tag);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, '');
  const next = { ...base, config: { model: 'next' } };
  const changed = request(send, next, tag);
  assert.equal(changed.headers['x-ggb-state-format'], 'delta-v1');
  assert.deepEqual(applyStateDelta(base, changed.json, tag), next);
  assert.equal(changed.headers['cache-control'], 'no-store');
  for (const response of [
    request(send, next, tag, false),
    request(send, next, 'unknown'),
    request(createStateResponder(), next, tag),
  ]) {
    assert.equal(response.headers['x-ggb-state-format'], undefined);
    assert.deepEqual(response.json, next);
  }
  const tiny = request(send, {}, tag);
  assert.deepEqual(tiny.json, {});
  assert.equal(tiny.headers['x-ggb-state-format'], undefined);
});

void test('diff bases expire and are evicted by serialized byte and entry limits, while a restart needs no persisted cache', () => {
  const base = state();
  const next = { ...base, count: 1 };
  let clock = 0;
  const expiring = createStateResponder({ ttlMs: 10, now: () => clock });
  const tag = request(expiring, base).headers.etag;
  clock = 11;
  assert.deepEqual(request(expiring, next, tag).json, next);
  for (const options of [
    { maxEntries: 1 },
    { maxBytes: Buffer.byteLength(JSON.stringify(base)) + 20 },
  ]) {
    const send = createStateResponder(options);
    const first = request(send, base);
    request(send, { ...base, count: 2 });
    assert.deepEqual(request(send, next, first.headers.etag).json, next);
  }
  const small = createStateResponder({ maxBytes: 100 });
  const initial = request(small, base);
  assert.deepEqual(request(small, next, initial.headers.etag).json, next);
});
