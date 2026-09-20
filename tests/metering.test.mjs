import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import { findDsh } from '../server/runtime.mjs';
import { loadUsageMeter, measureUsage } from '../server/metering.mjs';

function fixture(modelSpec = { inputPrice: 2, outputPrice: 4 }) {
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const records = new Records(db);
  records.save(
    'runtime-snapshots',
    { route: { providerId: 'provider', model: 'fixture-model', modelSpec } },
    'task',
  );
  records.save('task-meta', { groupId: 'group', jobId: 'job' }, 'task');
  let seq = 0;
  const record = (type, data) => {
    const event = { type, data };
    records.save('task-events', { taskId: 'task', ...event }, `event-${++seq}`);
    return event;
  };
  const step = (stepNumber, usage, duplicate = false, turn = 1) => {
    record('step/start', { turn, step: stepNumber });
    record('assistant/chunk', {
      turn,
      step: stepNumber,
      chunk: { type: 'usage', usage },
    });
    if (duplicate)
      record('assistant/chunk', {
        turn,
        step: stepNumber,
        chunk: { type: 'usage', usage: { ...usage } },
      });
    record('assistant/message', {
      turn,
      step: stepNumber,
      message: {
        source: { provider: 'workbench-provider', model: 'fixture-model' },
        content: [{ type: 'text', text: 'Done' }],
      },
      usage,
    });
    return record('step/end', { turn, step: stepNumber });
  };
  return { db, records, record, step };
}

test(
  'native token meter includes cache inputs and replaces partial totals without duplicate billing',
  { skip: !findDsh() },
  async () => {
    const derive = await loadUsageMeter();
    assert.equal(
      typeof derive,
      'function',
      'installed DSH must expose its supported client token meter',
    );
    const f = fixture();
    try {
      f.record('turn/start', { turn: 1 });
      const first = f.step(
        1,
        {
          inputTokens: 10,
          outputTokens: 8,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 43,
        },
        true,
      );
      const partial = measureUsage(f.records, 'task', first, derive);
      assert.equal(partial.inputTokens, 35);
      assert.equal(partial.uncachedInputTokens, 10);
      assert.equal(partial.cacheReadTokens, 20);
      assert.equal(partial.cacheWriteTokens, 5);
      assert.equal(partial.totalTokens, 43);
      assert.equal(partial.partial, true);
      const second = f.step(
        2,
        {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10,
        },
        true,
      );
      assert.equal(
        measureUsage(f.records, 'task', second, derive).totalTokens,
        53,
      );
      const end = f.record('turn/end', { turn: 1 });
      const final = measureUsage(f.records, 'task', end, derive);
      assert.equal(final.totalTokens, 53);
      assert.equal(final.inputTokens, 42);
      assert.equal(final.outputTokens, 11);
      assert.equal(final.cost, (42 * 2 + 11 * 4) / 1e6);
      assert.equal(final.estimated, true);
      assert.equal(final.partial, false);
      assert.equal(final.groupId, 'group');
      measureUsage(f.records, 'task', end, derive);
      assert.equal(f.records.list('usage').length, 1);
      assert.equal(
        f.records
          .list('usage')
          .reduce((sum, item) => sum + item.totalTokens, 0),
        53,
      );
      f.records.remove(
        'task-events',
        f.records.list('task-events').find((item) => item.type === 'turn/end')
          .id,
      );
      assert.equal(
        measureUsage(f.records, 'task', second, derive).partial,
        false,
      );
      assert.equal(f.records.get('usage', 'task:1').totalTokens, 53);
    } finally {
      f.db.close();
    }
  },
);

test(
  'unknown prices remain null and incomplete lifecycle cannot invent usage',
  { skip: !findDsh() },
  async () => {
    const derive = await loadUsageMeter();
    const f = fixture({ inputPrice: null, outputPrice: 4 });
    try {
      f.record('turn/start', { turn: 1 });
      const partial = f.step(1, {
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 3,
      });
      assert.equal(measureUsage(f.records, 'task', partial, derive).cost, null);
      f.record('turn/start', { turn: 2 });
      f.record('assistant/chunk', {
        turn: 2,
        step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
      });
      const incomplete = f.record('turn/end', { turn: 2 });
      assert.equal(measureUsage(f.records, 'task', incomplete, derive), null);
      assert.equal(f.records.get('usage', 'task:2'), null);
      f.record('turn/start', { turn: 3 });
      f.record('step/start', { turn: 3, step: 1 });
      f.record('assistant/message', {
        turn: 3,
        step: 1,
        message: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      f.record('step/end', { turn: 3, step: 1 });
      const malformed = f.record('turn/end', { turn: 3 });
      assert.equal(measureUsage(f.records, 'task', malformed, derive), null);
    } finally {
      f.db.close();
    }
  },
);
