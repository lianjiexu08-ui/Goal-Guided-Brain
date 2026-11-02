import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { modelMetrics } from '../server/metrics.mjs';

// server/metrics.mjs drives the numbers the model-management page shows:
// attempts, logical tasks, completion, tokens, cost, latency, verification and
// acceptance. It had no test coverage before this file.

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-metrics-'));
  const store = new Store(path.join(dir, 'data'), dir);
  return {
    store,
    save: (collection, input) => store.records.save(collection, input),
    close() {
      try {
        store.close();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const query = (params = {}) => new URLSearchParams(params);

function task(f, { status = 'completed', teamId, role = 'developer' } = {}) {
  const created = f.store.createTask({ role, prompt: 'fixture', teamId });
  if (status !== 'queued') f.store.updateTask(created.id, { status });
  return created;
}

const NO_COST = Symbol('no-cost');

function usage(f, taskId, {
  providerId = 'p1',
  model = 'm1',
  input = 10,
  output = 5,
  total,
  cost = 0.01,
} = {}) {
  return f.save('usage', {
    taskId,
    providerId,
    model,
    inputTokens: input,
    outputTokens: output,
    ...(total === undefined ? {} : { totalTokens: total }),
    // A default parameter cannot distinguish "caller omitted cost" from
    // "caller passed undefined", so unpriced rows opt out explicitly.
    ...(cost === NO_COST ? {} : { cost }),
  });
}

test('aggregates attempts, tokens and a known cost per provider and model', () => {
  const f = fixture();
  try {
    const a = task(f);
    const b = task(f);
    usage(f, a.id, { input: 10, output: 5, cost: 0.01 });
    usage(f, b.id, { input: 20, output: 8, cost: 0.02 });

    const result = modelMetrics(f.store, query());
    assert.equal(result.items.length, 1);
    const [item] = result.items;
    assert.equal(item.providerId, 'p1');
    assert.equal(item.model, 'm1');
    assert.equal(item.attempts, 2);
    assert.equal(item.inputTokens, 30);
    assert.equal(item.outputTokens, 13);
    assert.equal(item.totalTokens, 43);
    assert.equal(item.costKnown, true);
    assert.equal(item.cost.toFixed(4), '0.0300');

    assert.equal(result.totals.attempts, 2);
    assert.equal(result.totals.totalTokens, 43);
    assert.equal(result.totals.costFixed === undefined, true);
    assert.equal(result.totals.cost.toFixed(4), '0.0300');
    assert.equal(result.totals.costKnown, true);
  } finally {
    f.close();
  }
});

test('totals cost stays unknown when one usage row has no price', () => {
  const f = fixture();
  try {
    const a = task(f);
    const b = task(f);
    usage(f, a.id, { cost: 0.01 });
    usage(f, b.id, { cost: NO_COST });

    const result = modelMetrics(f.store, query());
    assert.equal(result.items[0].costKnown, false);
    assert.equal(result.items[0].cost, null);
    // A partially priced window must not be reported as a number: the UI would
    // show a total that silently omits the unpriced row.
    assert.equal(result.totals.costKnown, false);
    assert.equal(result.totals.cost, null);
  } finally {
    f.close();
  }
});

test('an explicit totalTokens wins over the input+output fallback', () => {
  const f = fixture();
  try {
    const a = task(f);
    usage(f, a.id, { input: 10, output: 5, total: 100 });
    const [item] = modelMetrics(f.store, query()).items;
    assert.equal(item.totalTokens, 100);
  } finally {
    f.close();
  }
});

test('retries sharing a groupId collapse into one logical task', () => {
  const f = fixture();
  try {
    const retry1 = task(f, { status: 'failed' });
    const retry2 = task(f);
    f.save('task-meta', { id: retry1.id, groupId: 'g1' });
    f.save('task-meta', { id: retry2.id, groupId: 'g1' });
    usage(f, retry1.id, { input: 1 });
    usage(f, retry2.id, { input: 2 });

    const result = modelMetrics(f.store, query());
    assert.equal(result.items[0].attempts, 2, '两次执行尝试');
    assert.equal(result.items[0].logicalTasks, 1, '同一个逻辑任务');
    assert.equal(result.totals.attempts, 2);
    assert.equal(result.totals.logicalTasks, 1);
  } finally {
    f.close();
  }
});

test('completion counts only terminal states of the final attempt', () => {
  const f = fixture();
  try {
    const done = task(f, { status: 'completed' });
    const failed = task(f, { status: 'failed' });
    const running = task(f, { status: 'running' });
    const other = task(f, { status: 'completed' });
    f.save('task-meta', { id: failed.id, groupId: 'failed-group' });
    f.save('task-meta', { id: running.id, groupId: 'running-group' });
    f.save('task-meta', { id: other.id, groupId: 'retried-group' });
    usage(f, done.id);
    usage(f, failed.id);
    usage(f, running.id);
    usage(f, other.id);

    const result = modelMetrics(f.store, query());
    assert.equal(result.totals.completed, 2);
    assert.equal(result.totals.failed, 1);
    assert.equal(result.items[0].completed, 2);
    assert.equal(result.items[0].failed, 1);
  } finally {
    f.close();
  }
});

test('fallback events are counted on the source and target route', () => {
  const f = fixture();
  try {
    const t = task(f);
    usage(f, t.id, { providerId: 'p1', model: 'm1' });
    f.save('task-events', {
      id: 'evt-1',
      taskId: t.id,
      type: 'routing/fallback',
      data: { from: { providerId: 'p1', model: 'm1' }, to: { providerId: 'p2', model: 'm2' } },
    });

    const result = modelMetrics(f.store, query());
    const byModel = new Map(result.items.map((item) => [item.model, item]));
    assert.equal(byModel.get('m1').fallbacks, 1);
    assert.equal(byModel.get('m2').fallbackTargets, 1);
    assert.equal(result.totals.fallbacks, 1);
  } finally {
    f.close();
  }
});

test('filters by team and role narrow both buckets and totals', () => {
  const f = fixture();
  try {
    f.save('spaces', { id: 'team-a', name: '团队 A', status: 'active' });
    f.save('spaces', { id: 'team-b', name: '团队 B', status: 'active' });
    const inA = task(f, { teamId: 'team-a' });
    const inB = task(f, { teamId: 'team-b', role: 'developer' });
    // createTask keeps the scope on the task-meta record written at dispatch
    // time; the tasks table itself has no team column.
    f.save('task-meta', { id: inA.id, teamId: 'team-a' });
    f.save('task-meta', { id: inB.id, teamId: 'team-b' });
    usage(f, inA.id, { input: 100 });
    usage(f, inB.id, { input: 7 });

    const all = modelMetrics(f.store, query());
    assert.equal(all.totals.attempts, 2);

    const onlyA = modelMetrics(f.store, query({ teamId: 'team-a' }));
    assert.equal(onlyA.totals.attempts, 1);
    assert.equal(onlyA.totals.inputTokens, 100);
    assert.equal(onlyA.items[0].teamId, 'team-a');
    assert.equal(onlyA.items[0].teamName, '团队 A');

    const onlyB = modelMetrics(f.store, query({ teamId: 'team-b' }));
    assert.equal(onlyB.totals.attempts, 1);
    assert.equal(onlyB.totals.inputTokens, 7);

    const nobody = modelMetrics(f.store, query({ teamId: 'team-missing' }));
    assert.equal(nobody.totals.attempts, 0);
    assert.deepEqual(nobody.items, []);
  } finally {
    f.close();
  }
});

test('filters by provider and model select the matching route only', () => {
  const f = fixture();
  try {
    const t = task(f);
    usage(f, t.id, { providerId: 'p1', model: 'm1', input: 10 });
    usage(f, t.id, { providerId: 'p2', model: 'm2', input: 20 });

    const byProvider = modelMetrics(f.store, query({ providerId: 'p2' }));
    assert.equal(byProvider.items.length, 1);
    assert.equal(byProvider.items[0].model, 'm2');
    assert.equal(byProvider.totals.inputTokens, 20);

    const byModel = modelMetrics(f.store, query({ model: 'm1' }));
    assert.equal(byModel.items.length, 1);
    assert.equal(byModel.totals.inputTokens, 10);
  } finally {
    f.close();
  }
});

test('the time window filters tasks by createdAt', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 3600_000).toISOString();
    const t = task(f);
    usage(f, t.id);
    f.store.db.prepare('UPDATE tasks SET createdAt=? WHERE id=?').run(old, t.id);

    const since = new Date(now - 24 * 3600_000).toISOString();
    const recent = modelMetrics(f.store, query({ since }));
    assert.equal(recent.totals.attempts, 0, '十天前的任务不应落在最近 24 小时窗口');

    const wide = modelMetrics(f.store, query({ since: new Date(now - 30 * 24 * 3600_000).toISOString() }));
    assert.equal(wide.totals.attempts, 1);

    const until = modelMetrics(f.store, query({ until: new Date(now - 5 * 24 * 3600_000).toISOString() }));
    assert.equal(until.totals.attempts, 1, 'until 落在任务之后应包含它');
  } finally {
    f.close();
  }
});

test('a task with no usable timestamp counts in every window', () => {
  // withinWindow() returns true when neither createdAt nor updatedAt parses.
  // That is a deliberate trade-off: an undated row is more likely a data
  // problem than an ancient task, and silently dropping real usage from every
  // query would hide it.  This test pins the behaviour so changing it is a
  // conscious decision rather than an accident.
  const f = fixture();
  try {
    const t = task(f);
    usage(f, t.id);
    f.store.db
      .prepare('UPDATE tasks SET createdAt=?, updatedAt=? WHERE id=?')
      .run('not-a-date', 'not-a-date', t.id);

    const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const past = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
    assert.equal(modelMetrics(f.store, query({ since: future })).totals.attempts, 1);
    assert.equal(modelMetrics(f.store, query({ until: past })).totals.attempts, 1);
  } finally {
    f.close();
  }
});

test('rejects an invalid or inverted window instead of guessing', () => {
  const f = fixture();
  try {
    assert.throws(() => modelMetrics(f.store, query({ since: 'not-a-date' })), /since 必须是有效的 ISO 时间/);
    assert.throws(() => modelMetrics(f.store, query({ until: 'nope' })), /until 必须是有效的 ISO 时间/);
    assert.throws(
      () => modelMetrics(f.store, query({
        since: '2026-06-01T00:00:00Z',
        until: '2026-05-01T00:00:00Z',
      })),
      /since 不能晚于 until/,
    );
  } finally {
    f.close();
  }
});

test('latency comes from the execution record and ignores inverted timestamps', () => {
  const f = fixture();
  try {
    const fast = task(f);
    const slow = task(f);
    const broken = task(f);
    usage(f, fast.id);
    usage(f, slow.id);
    usage(f, broken.id);
    f.save('executions', { id: fast.id, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' });
    f.save('executions', { id: slow.id, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:03.000Z' });
    // finishedAt 早于 startedAt：时钟回拨，不能算出负数延迟。
    f.save('executions', { id: broken.id, startedAt: '2026-01-01T00:00:05.000Z', finishedAt: '2026-01-01T00:00:01.000Z' });

    const result = modelMetrics(f.store, query());
    assert.equal(result.items[0].avgLatencyMs, 2000);
    assert.equal(result.items[0].p50LatencyMs, 2000);
    assert.equal(result.totals.avgLatencyMs, 2000);
  } finally {
    f.close();
  }
});

test('verification and acceptance counts require current, matching evidence', () => {
  const f = fixture();
  try {
    const verified = task(f);
    const accepted = task(f);
    const stale = task(f);
    usage(f, verified.id);
    usage(f, accepted.id);
    usage(f, stale.id);

    f.save('artifacts', {
      id: 'v1', taskId: verified.id, kind: 'verification',
      status: 'verified', requirementVersion: 1, finishedAt: '2026-01-02T00:00:00.000Z',
    });
    f.save('artifacts', {
      id: 'v2', taskId: accepted.id, kind: 'verification',
      status: 'verified', requirementVersion: 1, finishedAt: '2026-01-02T00:00:00.000Z',
    });
    f.save('task-acceptance', {
      id: accepted.id, status: 'accepted', decision: 'accepted',
      requirementVersion: 1, verificationId: 'v2',
    });
    // 需求升到版本 2 后，版本 1 的验证与验收都不再算数。
    f.save('artifacts', {
      id: 'v3', taskId: stale.id, kind: 'verification',
      status: 'verified', requirementVersion: 1, finishedAt: '2026-01-02T00:00:00.000Z',
    });
    f.save('task-meta', { id: stale.id, requirementVersion: 2 });
    f.save('task-acceptance', {
      id: stale.id, status: 'accepted', decision: 'accepted',
      requirementVersion: 1, verificationId: 'v3',
    });

    const result = modelMetrics(f.store, query());
    assert.equal(result.totals.verificationPassed, 2, '只有版本匹配的两条算通过');
    assert.equal(result.totals.accepted, 1);
    // verified 尚未验收，stale 的验收因需求版本失效，都计入待处理。
    assert.equal(result.totals.pending, 2);
  } finally {
    f.close();
  }
});

test('routing candidates are surfaced with a bounded reason', () => {
  const f = fixture();
  try {
    const t = task(f);
    usage(f, t.id, { providerId: 'p1', model: 'm1' });
    f.save('runtime-snapshots', {
      id: t.id,
      route: {
        providerId: 'p1',
        model: 'm1',
        routingCandidates: [
          { providerId: 'p1', providerName: 'P1', model: 'm1', status: 'selected', reason: 'primary' },
          { providerId: 'p1', model: 'm1', status: 'skipped', reason: 'x'.repeat(900) },
        ],
      },
    });
    const [item] = modelMetrics(f.store, query()).items;
    const byStatus = new Map(item.candidateDecisions.map((candidate) => [candidate.status, candidate]));
    assert.equal(byStatus.get('selected').count, 1);
    assert.equal(byStatus.get('skipped').reason.length, 500, '长原因要截断，避免撑爆响应');
  } finally {
    f.close();
  }
});

test('tasks carrying no route at all do not create phantom buckets', () => {
  const f = fixture();
  try {
    task(f);
    const result = modelMetrics(f.store, query());
    assert.deepEqual(result.items, []);
    assert.equal(result.totals.attempts, 0);
  } finally {
    f.close();
  }
});
