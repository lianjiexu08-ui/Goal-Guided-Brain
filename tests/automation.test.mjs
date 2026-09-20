import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import {
  AutomationService,
  nextTimes,
  scheduleNextTimes,
  runCheck,
} from '../server/automation.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const records = new Records(db);
  const roles = [{ id: 'planner' }, { id: 'developer' }, { id: 'reviewer' }];
  const store = {
    db,
    records,
    config: { workspace: '/tmp/fixture-workspace' },
    role: (id) => roles.find((role) => role.id === id),
    roles: () => roles,
    task: (id) => records.get('fixture-tasks', id),
  };
  let now = Date.parse('2026-09-10T00:00:00Z');
  const createTask = (input) => {
    if (!store.role(input.role)) throw new Error('助手不存在。');
    return records.save('fixture-tasks', { ...input, status: 'queued' });
  };
  const service = new AutomationService({
    store,
    createTask,
    providers: { probe: async () => ({ ok: true }) },
    checkMcp: async () => ({ ok: true }),
    now: () => now,
  });
  return {
    store,
    records,
    service,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    setTime: (value) => {
      now = Date.parse(value);
    },
    close: () => db.close(),
  };
}

test('cron preserves local wall time across timezones and DST changes', () => {
  assert.deepEqual(
    nextTimes(
      '0 9 * * *',
      'Asia/Shanghai',
      new Date('2026-09-10T00:00:00Z'),
      2,
    ),
    ['2026-09-10T01:00:00.000Z', '2026-09-11T01:00:00.000Z'],
  );
  assert.deepEqual(
    nextTimes(
      '0 9 * * *',
      'America/New_York',
      new Date('2026-03-07T12:00:00Z'),
      3,
    ),
    [
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ],
  );
  assert.deepEqual(
    nextTimes(
      '0 9 * * *',
      'America/New_York',
      new Date('2026-10-31T12:00:00Z'),
      3,
    ),
    [
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ],
  );
  assert.throws(() => nextTimes('invalid cron'));
});

test('schedule previews validate both modes and intervals retain elapsed time through DST', () => {
  const current = new Date('2026-03-08T06:30:00Z');
  assert.deepEqual(
    scheduleNextTimes({ cron: '0 9 * * *', timezone: 'Asia/Shanghai' }, current, 2),
    nextTimes('0 9 * * *', 'Asia/Shanghai', current, 2),
  );
  assert.deepEqual(
    scheduleNextTimes({ mode: 'interval', timezone: 'America/New_York' }, current, 3),
    ['2026-03-08T07:30:00.000Z', '2026-03-08T08:30:00.000Z', '2026-03-08T09:30:00.000Z'],
  );
  assert.equal(scheduleNextTimes({ mode: 'interval', intervalSeconds: 60 }, current, 1)[0], '2026-03-08T06:31:00.000Z');
  assert.equal(scheduleNextTimes({ mode: 'interval', intervalSeconds: 31536000 }, current, 1)[0], '2027-03-08T06:30:00.000Z');
  assert.deepEqual(
    scheduleNextTimes({ mode: 'interval', intervalSeconds: 60, nextRunAt: '2026-03-08T06:29:00Z' }, new Date('2026-03-08T06:30:15Z'), 2),
    ['2026-03-08T06:31:00.000Z', '2026-03-08T06:32:00.000Z'],
  );
  for (const seconds of [0, 59, 60.5, 31536001, Infinity, 'invalid'])
    assert.throws(() => scheduleNextTimes({ mode: 'interval', intervalSeconds: seconds }, current), /执行间隔/);
  assert.throws(() => scheduleNextTimes({ mode: 'unsupported' }, current), /定时模式/);
  assert.throws(() => scheduleNextTimes({ mode: 'interval', timezone: 'Invalid/Zone' }, current));
  assert.throws(() => scheduleNextTimes({ mode: 'interval', nextRunAt: 'invalid' }, current), /下次执行时间/);
  assert.throws(() => scheduleNextTimes({}, 'invalid'), /当前时间/);
  for (const count of [0, 101, 1.5]) assert.throws(() => scheduleNextTimes({}, current, count), /预览数量/);
});

test('schedule edits preserve interval cadence and retain legacy cron records', () => {
  const f = fixture();
  try {
    const interval = f.service.saveSchedule({ name: 'Hourly', role: 'planner', prompt: 'Inspect', mode: 'interval' });
    assert.equal(interval.intervalSeconds, 3600);
    assert.equal(interval.nextRunAt, '2026-09-10T01:00:00.000Z');
    f.advance(15000);
    const renamed = f.service.saveSchedule({ name: 'Renamed' }, interval.id);
    assert.equal(renamed.nextRunAt, interval.nextRunAt);
    const changed = f.service.saveSchedule({ intervalSeconds: 60 }, interval.id);
    assert.equal(changed.nextRunAt, '2026-09-10T00:01:15.000Z');
    const cron = f.service.saveSchedule({ mode: 'cron', cron: '0 9 * * *' }, interval.id);
    assert.equal(cron.nextRunAt, '2026-09-10T01:00:00.000Z');
    const legacy = { ...cron };
    delete legacy.mode;
    delete legacy.intervalSeconds;
    f.records.save('schedules', legacy, legacy.id);
    assert.equal(f.service.saveSchedule({ enabled: true }, legacy.id).nextRunAt, cron.nextRunAt);
    assert.throws(() => f.service.saveSchedule({ mode: 'interval', intervalSeconds: 59 }, interval.id), /执行间隔/);
    assert.equal(f.records.get('schedules', interval.id).mode, 'cron');
  } finally { f.close(); }
});

test('interval misfires catch up at most once with stable slots, deduplication, and overlap protection', async () => {
  for (const misfire of ['skip', 'once']) {
    const f = fixture();
    try {
      const schedule = f.service.saveSchedule({ name: misfire, role: 'planner', prompt: 'Inspect', mode: 'interval', intervalSeconds: 60, enabled: true, misfire });
      f.advance(615000);
      await f.service.tick();
      const first = f.records.list('schedule-runs')[0];
      assert.equal(first.scheduledAt, '2026-09-10T00:01:00.000Z');
      assert.equal(first.status, misfire === 'once' ? 'queued' : 'skipped');
      assert.equal(f.records.get('schedules', schedule.id).nextRunAt, '2026-09-10T00:11:00.000Z');
      assert.equal(f.service.trigger(schedule, schedule.nextRunAt).id, first.id);
      await f.service.tick();
      assert.equal(f.records.list('schedule-runs').length, 1);
      f.setTime('2026-09-10T00:11:00Z');
      await f.service.tick();
      const second = f.records.list('schedule-runs').find(run => run.scheduledAt === '2026-09-10T00:11:00.000Z');
      assert.equal(second.status, misfire === 'once' ? 'skipped' : 'queued');
      assert.equal(f.records.list('fixture-tasks').length, 1);
      for (const task of f.records.list('fixture-tasks')) f.records.save('fixture-tasks', { ...task, status: 'completed' }, task.id);
      f.setTime('2026-09-10T00:12:00Z');
      await f.service.tick();
      assert.equal(f.records.list('fixture-tasks').length, 2);
      assert.equal(f.records.get('schedules', schedule.id).nextRunAt, '2026-09-10T00:13:00.000Z');
    } finally { f.close(); }
  }
});

test('schedule triggers are idempotent and workflow steps retain batch dependencies', async () => {
  const f = fixture();
  try {
    const workflow = f.records.save('workflows', {
      steps: [
        { role: 'planner', prompt: 'Plan' },
        { role: 'developer', prompt: 'Implement' },
        { role: 'reviewer', prompt: 'Review' },
      ],
    });
    const schedule = f.service.saveSchedule({
      name: 'Workflow',
      workflowId: workflow.id,
      cron: '* * * * *',
      enabled: true,
    });
    f.setTime(schedule.nextRunAt);
    await f.service.tick();
    const run = f.records.list('schedule-runs')[0];
    assert.equal(run.taskIds.length, 3);
    assert.equal(f.service.trigger(schedule, schedule.nextRunAt).id, run.id);
    assert.equal(f.records.list('fixture-tasks').length, 3);
    const tasks = run.taskIds.map((id) => f.store.task(id));
    assert.deepEqual(
      tasks.map((task) => task.dependencies),
      [[], [tasks[0].id], [tasks[0].id, tasks[1].id]],
    );
    assert.equal(new Set(tasks.map((task) => task.batchId)).size, 1);
    assert.ok(tasks.every((task) => task.permissions.length === 0));
    f.advance(60000);
    await f.service.tick();
    assert.equal(
      f.records
        .list('schedule-runs')
        .filter((item) => item.status === 'skipped').length,
      1,
    );
    for (const task of tasks)
      f.records.save(
        'fixture-tasks',
        { ...task, status: 'completed' },
        task.id,
      );
    await f.service.tick();
    assert.equal(f.records.get('schedule-runs', run.id).status, 'completed');
  } finally {
    f.close();
  }
});

test('schedule overlap and completion follow replacement attempts and unknown executions', async () => {
  const f = fixture();
  try {
    const rule = f.service.saveSchedule({ name: 'Retry-aware schedule', role: 'planner', prompt: 'Inspect', cron: '* * * * *', enabled: true });
    const run = f.service.trigger(rule, rule.nextRunAt);
    const original = f.store.task(run.taskIds[0]);
    f.records.save('fixture-tasks', { ...original, status: 'failed' }, original.id);
    const replacement = f.records.save('fixture-tasks', { role: 'planner', status: 'state_unknown' });
    const job = f.records.save('jobs', { taskId: replacement.id });
    f.records.save('task-meta', { jobId: job.id }, original.id);
    assert.equal(f.service.trigger(rule, 'next-slot').status, 'skipped');
    await f.service.tick();
    assert.equal(f.records.get('schedule-runs', run.id).status, 'queued');
    f.records.save('fixture-tasks', { ...replacement, status: 'completed' }, replacement.id);
    await f.service.tick();
    assert.equal(f.records.get('schedule-runs', run.id).status, 'completed');
    assert.equal(f.service.trigger(rule, 'after-completion').status, 'queued');
  } finally { f.close(); }
});

test('misfires skip or catch up once and failed workflow creation rolls back', async () => {
  const f = fixture();
  try {
    for (const misfire of ['skip', 'once'])
      f.service.saveSchedule({
        name: misfire,
        role: 'planner',
        prompt: 'Periodic task',
        cron: '* * * * *',
        enabled: true,
        misfire,
      });
    f.advance(3600000);
    await f.service.tick();
    assert.equal(
      f.records.list('schedule-runs').filter((run) => run.status === 'queued')
        .length,
      1,
    );
    assert.equal(
      f.records.list('schedule-runs').filter((run) => run.status === 'skipped')
        .length,
      1,
    );
    await f.service.tick();
    assert.equal(f.records.list('schedule-runs').length, 2);
    const workflow = f.records.save('workflows', {
      steps: [
        { role: 'planner', prompt: 'Plan' },
        { role: 'missing-role', prompt: 'Fail' },
      ],
    });
    const schedule = f.service.saveSchedule({
      name: 'Invalid workflow',
      workflowId: workflow.id,
      enabled: true,
      cron: '* * * * *',
    });
    const count = f.records.list('fixture-tasks').length;
    assert.throws(
      () => f.service.trigger(schedule, schedule.nextRunAt),
      /助手不存在/,
    );
    assert.equal(f.records.list('fixture-tasks').length, count);
    assert.equal(
      f.records
        .list('schedule-runs')
        .some((run) => run.scheduleId === schedule.id),
      false,
    );
  } finally {
    f.close();
  }
});

test('HTTP and TCP checks return actual connection outcomes', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('healthy');
  });
  const tcp = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const port = tcp.address().port;
  try {
    assert.equal(
      (
        await runCheck({
          kind: 'http',
          url: `http://127.0.0.1:${server.address().port}/health`,
        })
      ).ok,
      true,
    );
    assert.equal(
      (await runCheck({ kind: 'tcp', url: `tcp://127.0.0.1:${port}` })).ok,
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
  }
  assert.equal(
    (await runCheck({ kind: 'tcp', url: `tcp://127.0.0.1:${port}` })).ok,
    false,
  );
});

test('monitor changes deduplicate notifications and retry webhook with stable idempotency key', async () => {
  const f = fixture();
  let healthy = false;
  const deliveries = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(healthy ? 200 : 503);
      res.end('health');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    deliveries.push({
      key: req.headers['idempotency-key'],
      body: JSON.parse(body),
    });
    res.writeHead(deliveries.length === 1 ? 503 : 200);
    res.end('delivery');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    f.service.saveMonitor({
      name: 'Local health',
      kind: 'http',
      url: `${base}/health`,
      webhookUrl: `${base}/hook`,
      intervalSeconds: 30,
      enabled: true,
    });
    await f.service.tick();
    assert.equal(f.records.list('notifications').length, 1);
    assert.equal(f.records.list('deliveries')[0].status, 'pending');
    assert.equal(f.records.list('deliveries')[0].attempts, 1);
    await f.service.tick();
    assert.equal(deliveries.length, 1);
    f.advance(2000);
    await f.service.tick();
    assert.equal(f.records.list('deliveries')[0].status, 'delivered');
    assert.equal(deliveries[0].key, deliveries[1].key);
    assert.equal(deliveries[0].body.id, deliveries[1].body.id);
    f.advance(30000);
    await f.service.tick();
    assert.equal(f.records.list('notifications').length, 1);
    healthy = true;
    f.advance(30000);
    await f.service.tick();
    assert.deepEqual(
      f.records
        .list('notifications')
        .map((note) => note.kind)
        .sort(),
      ['failed', 'recovered'],
    );
    assert.equal(deliveries.length, 3);
    await f.service.tick();
    assert.equal(deliveries.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});
