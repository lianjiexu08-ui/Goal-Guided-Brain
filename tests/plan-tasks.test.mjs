import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-plan-tasks-'));
  const app = createWorkbench({
    workspace: path.join(dir, 'workspace'),
    dataDir: path.join(dir, 'data'),
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const team = app.store.teamSpaces()[0];
  const other = app.store.saveTeamSpace({
    name: '另一团队',
    goal: '隔离测试',
    workspace: app.store.workspace,
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    recruitment: { phase: 'confirmed' },
  });
  const task = app.store.createTask({
    role: 'developer',
    prompt: '实现并验证',
    workspace: dir,
  });
  app.store.records.save('task-meta', { spaceId: team.id }, task.id);
  const foreign = app.store.createTask({
    role: 'developer',
    prompt: '另一个项目',
    workspace: dir,
  });
  app.store.records.save('task-meta', { spaceId: other.id }, foreign.id);
  const save = async (input) => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/teams/${team.id}/plan`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return { app, team, task, foreign, save };
}

void test('milestones persist same-team task links without accepting or changing execution', async (t) => {
  const { app, team, task, save } = await fixture(t);
  const result = await save({
    revision: 0,
    milestones: [
      {
        id: 'release',
        title: '首版交付',
        status: 'completed',
        taskIds: [task.id, task.id],
      },
    ],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.milestones[0].taskIds, [task.id]);
  assert.equal(app.store.task(task.id).status, task.status);
  assert.equal(app.store.records.get('task-acceptance', task.id), null);
  const loaded = app.store.teamPlan(team.id);
  assert.deepEqual(loaded.milestones[0].taskIds, [task.id]);
  const removed = await save({
    ...loaded,
    milestones: loaded.milestones.map((item) => ({ ...item, taskIds: [] })),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.milestones[0].taskIds, []);
});

void test('foreign, missing and malformed task links reject the entire plan update', async (t) => {
  const { app, team, task, foreign, save } = await fixture(t);
  const original = await save({
    revision: 0,
    milestones: [{ id: 'release', title: '原计划', taskIds: [task.id] }],
  });
  for (const taskIds of [
    [foreign.id],
    ['missing'],
    [null],
    [42],
    [''],
    'task',
    null,
    Array.from({ length: 41 }, (_, i) => `task-${i}`),
  ]) {
    const result = await save({
      ...original.body,
      summary: '不应保存的目标',
      milestones: [{ id: 'release', title: '非法更新', taskIds }],
    });
    assert.equal(result.status, 400);
    assert.deepEqual(app.store.teamPlan(team.id), original.body);
    assert.notEqual(app.store.teamSpace(team.id).goal, '不应保存的目标');
  }
  assert.throws(
    () =>
      app.store.saveTeamPlan(team.id, {
        milestones: [{ title: '绕过 HTTP', taskIds: [foreign.id] }],
      }),
    /本团队/,
  );
});

void test('job-scoped tasks can be linked and stale revisions cannot overwrite newer links', async (t) => {
  const { app, team, task, save } = await fixture(t);
  const job = app.store.records.save('jobs', {
    teamId: team.id,
    status: 'completed',
  });
  app.store.records.save('task-meta', { jobId: job.id }, task.id);
  const original = await save({
    revision: 0,
    milestones: [{ id: 'release', title: '交付阶段', taskIds: [task.id] }],
  });
  assert.equal(original.status, 200);
  const latest = await save({
    ...original.body,
    summary: '来自另一设备的更新',
  });
  const conflict = await save({ ...original.body, milestones: [] });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error, /记录已更新/);
  assert.deepEqual(app.store.teamPlan(team.id), latest.body);
});
