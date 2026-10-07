import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';
import { createOrchestrationServer } from '../server/orchestration-mcp.mjs';
import {
  upsertTeamMilestone,
  teamPlanContext,
} from '../server/team-plan-progress.mjs';
import { createContextFor } from '../server/platform/context.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-plan-mcp-'));
  const store = new Store(path.join(dir, 'data'), dir, {
    seedProjectManager: true,
  });
  const control = new ControlPlane({ store });
  const clients = [];
  t.after(async () => {
    for (const [client, server] of clients) {
      await client.close();
      await server.close();
    }
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const makeTeam = (name = '研发团队', phase = 'confirmed') =>
    store.saveTeamSpace({
      name,
      goal: '交付可验收版本',
      workspace: dir,
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      recruitment: { phase },
    });
  const team = makeTeam();
  const other = makeTeam('另一团队');
  const task = (scope = team.id, role = 'developer') => {
    const row = store.createTask({
      role,
      prompt: `执行 ${scope}`,
      workspace: dir,
    });
    store.records.save(
      'task-meta',
      { spaceId: scope, groupId: row.id, requirementVersion: 1 },
      row.id,
    );
    return row;
  };
  const connect = async (role = 'project_manager', current = team) => {
    const actor = task(current.id, role);
    const claim = control.claimLocal(actor);
    const principal = control.validateInstanceToken(claim.token);
    const server = createOrchestrationServer({ control, token: claim.token });
    const client = new Client({ name: 'plan-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push([client, server]);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: args });
    return { actor, principal, client, call };
  };
  const actor = await connect();
  const accept = (row) => {
    store.updateTask(row.id, { status: 'completed' });
    const proof = store.records.save('artifacts', {
      taskId: row.id,
      kind: 'verification',
      name: 'npm test',
      status: 'verified',
      verified: true,
      requirementVersion: 1,
    });
    store.records.save(
      'task-acceptance',
      {
        taskId: row.id,
        status: 'active',
        decision: 'accepted',
        requirementVersion: 1,
        verificationId: proof.id,
      },
      row.id,
    );
  };
  return {
    store,
    control,
    team,
    other,
    task,
    connect,
    makeTeam,
    accept,
    ...actor,
  };
}
const data = (result) => {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const update = (revision, extra = {}) => ({
  id: 'release',
  title: '可验收阶段',
  expectedRevision: revision,
  note: '按实际任务推进',
  ...extra,
});

test('MCP exposes scoped plans, paginates team tasks and persists audited milestones', async (t) => {
  const f = await fixture(t);
  assert.ok(
    (await f.client.listTools()).tools.some(
      (tool) => tool.name === 'read_team_plan',
    ),
  );
  f.task();
  f.task();
  const foreign = f.task(f.other.id);
  const first = data(await f.call('read_team_plan', { limit: 1 }));
  assert.equal(first.revision, 0);
  assert.equal(first.candidateTasks.length, 1);
  assert.equal(first.hasMoreTasks, true);
  const second = data(
    await f.call('read_team_plan', { limit: 1, before: first.nextTaskCursor }),
  );
  assert.notEqual(second.candidateTasks[0].id, first.candidateTasks[0].id);
  assert.ok(!JSON.stringify(first).includes(foreign.id));
  const created = data(
    await f.call(
      'upsert_team_milestone',
      update(0, { taskIds: [first.candidateTasks[0].id] }),
    ),
  );
  assert.equal(created.plan.revision, 1);
  assert.equal(created.plan.milestones[0].status, 'planned');
  assert.equal(created.plan.lastAgentUpdate.taskId, f.actor.id);
  assert.equal(f.store.records.list('team-plan-events').length, 1);
  assert.equal(
    data(await f.call('read_team_plan')).updates[0].after.id,
    'release',
  );
  const stale = await f.call(
    'upsert_team_milestone',
    update(0, { status: 'active' }),
  );
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /计划已更新/);
  assert.equal(f.store.teamPlan(f.team.id).revision, 1);
});

test('only current-version owner-accepted tasks allow agent completion', async (t) => {
  const f = await fixture(t);
  const child = f.task();
  data(
    await f.call(
      'upsert_team_milestone',
      update(0, { taskIds: [child.id], status: 'active' }),
    ),
  );
  for (const status of ['running', 'failed', 'completed']) {
    f.store.updateTask(child.id, { status });
    const result = await f.call(
      'upsert_team_milestone',
      update(1, { status: 'completed' }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /尚未全部通过/);
  }
  f.accept(child);
  const completed = data(
    await f.call('upsert_team_milestone', update(1, { status: 'completed' })),
  );
  assert.equal(completed.plan.status, 'completed');
  assert.equal(completed.evidence.accepted, 1);
  f.store.records.save(
    'task-meta',
    { ...f.store.records.get('task-meta', child.id), requirementVersion: 2 },
    child.id,
  );
  const stale = data(await f.call('read_team_plan'));
  assert.equal(stale.milestones[0].evidence.canComplete, false);
  assert.equal(
    (await f.call('upsert_team_milestone', update(2, { status: 'completed' })))
      .isError,
    true,
  );
  data(
    await f.call(
      'upsert_team_milestone',
      update(2, { status: 'blocked', note: '需求变化，需要重新验证' }),
    ),
  );
  assert.equal(f.store.teamPlan(f.team.id).status, 'active');
  assert.equal(
    f.store.records.get('task-acceptance', child.id).requirementVersion,
    1,
  );
  assert.equal(
    (
      await f.call(
        'upsert_team_milestone',
        update(3, { id: 'empty', taskIds: [], status: 'completed' }),
      )
    ).isError,
    true,
  );
});

test('team plan tools reject scope forgery, foreign links and protected settings', async (t) => {
  const f = await fixture(t);
  const foreign = f.task(f.other.id);
  for (const args of [
    { teamId: f.other.id },
    { limit: 101 },
    { before: 'invalid' },
  ])
    assert.equal((await f.call('read_team_plan', args)).isError, true);
  for (const extra of [
    { teamId: f.other.id },
    { budgetTokens: 999999 },
    { summary: '改掉目标' },
    { taskIds: [foreign.id] },
    { taskIds: null },
  ])
    assert.equal(
      (await f.call('upsert_team_milestone', update(0, extra))).isError,
      true,
    );
  assert.equal(f.store.teamPlan(f.team.id).revision, 0);
  assert.equal(f.store.records.list('team-plan-events').length, 0);
});

test('members can read but cannot write, and revoked or unconfirmed actors cannot access plans', async (t) => {
  const f = await fixture(t);
  const member = await f.connect('developer');
  assert.equal(data(await member.call('read_team_plan')).teamId, f.team.id);
  assert.equal(
    (await member.call('upsert_team_milestone', update(0))).isError,
    true,
  );
  const removed = await f.connect('assistant');
  assert.equal((await removed.call('read_team_plan')).isError, true);
  const pending = await f.connect(
    'project_manager',
    f.makeTeam('待招募', 'discovery'),
  );
  assert.equal((await pending.call('read_team_plan')).isError, true);
  f.control.revokeExecution(f.actor.id);
  assert.equal((await f.call('read_team_plan')).isError, true);
  assert.equal(
    (await f.call('upsert_team_milestone', update(0))).isError,
    true,
  );
});

test('paused plans and teams remain protected and failed writes roll back audit plus plan', async (t) => {
  const f = await fixture(t);
  f.store.saveTeamPlan(f.team.id, { status: 'paused' });
  assert.equal(
    (await f.call('upsert_team_milestone', update(1))).isError,
    true,
  );
  f.store.saveTeamPlan(f.team.id, { revision: 1, status: 'active' });
  const before = f.store.teamPlan(f.team.id);
  const original = f.store.saveTeamPlan.bind(f.store);
  f.store.saveTeamPlan = (...args) => {
    original(...args);
    throw new Error('模拟写入后失败');
  };
  assert.throws(
    () => upsertTeamMilestone(f.control, update(2), f.principal),
    /模拟写入后失败/,
  );
  f.store.saveTeamPlan = original;
  assert.deepEqual(f.store.teamPlan(f.team.id), before);
  assert.equal(f.store.records.list('team-plan-events').length, 0);
  f.store.saveTeamSpace(
    { ...f.store.teamSpace(f.team.id), status: 'paused' },
    f.team.id,
  );
  assert.equal(
    (await f.call('upsert_team_milestone', update(2))).isError,
    true,
  );
});

test('runtime context contains a bounded real plan and omits unrelated teams', async (t) => {
  const f = await fixture(t);
  f.store.saveTeamPlan(f.team.id, {
    summary: '上下文中的真实目标',
    milestones: Array.from({ length: 12 }, (_, i) => ({
      id: `m-${i}`,
      title: `阶段 ${i}`,
      status: 'planned',
    })),
  });
  f.store.saveTeamPlan(f.other.id, { summary: '不应泄露的其他团队目标' });
  for (const collection of ['checkpoints', 'board']) {
    f.store.records.save(collection, {
      groupId: 'foreign-group',
      content: '不应出现的其他任务组记录',
    });
    f.store.records.save(collection, {
      groupId: f.actor.id,
      content: '本任务组参考记录',
    });
  }
  const contextFor = createContextFor({
    store: f.store,
    records: f.store.records,
    attachments: { list: () => [] },
  });
  const context = contextFor(f.store.task(f.actor.id));
  assert.match(context, /本任务组参考记录/);
  assert.ok(!context.includes('不应出现的其他任务组记录'));
  assert.match(context, /read_team_plan/);
  assert.match(context, /上下文中的真实目标/);
  assert.ok(!context.includes('不应泄露的其他团队目标'));
  const snapshot = JSON.parse(
    context.match(/<团队目标计划>\n[^\n]+\n([^\n]+)\n<\/团队目标计划>/)[1],
  );
  assert.equal(snapshot.milestones.length, 10);
  assert.equal(snapshot.milestoneCount, 12);
  assert.equal(teamPlanContext(f.store, f.task(f.team.id, 'assistant')), '');
});
