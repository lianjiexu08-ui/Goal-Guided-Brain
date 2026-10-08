import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkbench } from '../server/index.mjs';
import { Records } from '../server/records.mjs';
import { seedStateLoad } from './fixtures/state-load.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-state-read-'));
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: path.join(dir, 'project'),
    requireCredential: false,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.platform.ready;
  return app;
}

void test('state reads each shared collection once as teams and task history grow', async (t) => {
  const app = await fixture(t);
  const seeded = seedStateLoad(app.store, { teams: 8, tasksPerTeam: 12 });
  let scans = {};
  let taskReads = 0;
  let knowledgeReads = 0;
  const list = app.store.records.list.bind(app.store.records);
  const tasks = app.store.tasks.bind(app.store);
  const knowledge = app.store.knowledge.bind(app.store);
  t.mock.method(app.store.records, 'list', (name) => {
    scans[name] = (scans[name] || 0) + 1;
    return list(name);
  });
  t.mock.method(app.store, 'tasks', () => {
    taskReads++;
    return tasks();
  });
  t.mock.method(app.store, 'knowledge', () => {
    knowledgeReads++;
    return knowledge();
  });
  const verify = (count) => {
    scans = {};
    taskReads = knowledgeReads = 0;
    const state = app.getState();
    assert.equal(state.tasks.length, count);
    assert.equal(taskReads, 1);
    assert.equal(knowledgeReads, 1);
    for (const name of [
      'spaces',
      'task-meta',
      'jobs',
      'artifacts',
      'task-acceptance',
      'task-events',
      'space-messages',
      'usage',
      'attention',
      'team-plans',
    ])
      assert.equal(
        scans[name],
        1,
        `${name} must not be rescanned per task/team`,
      );
    for (const space of seeded.spaces) {
      const team = state.spaces.find((item) => item.id === space.id);
      assert.equal(team.messages.length, 12);
      assert.equal(team.timeline.length, 72);
      assert.equal(team.autonomyUsage.usedTokens, 1200);
      assert.equal(state.teamRiskCounts[space.id], 12);
      const owned = state.tasks.filter((task) => task.spaceId === space.id);
      assert.equal(owned.length, 12);
      assert.ok(
        owned.every(
          (task) =>
            task.artifactCount === 3 &&
            task.deliveryStatus === 'awaiting-owner',
        ),
      );
    }
  };
  verify(96);
  seedStateLoad(app.store, { teams: 3, tasksPerTeam: 30 });
  verify(186);
});

void test('HTTP state immediately reflects acceptance, requirements and deletion from another SQLite connection', async (t) => {
  const app = await fixture(t);
  const { spaces, tasks } = seedStateLoad(app.store, {
    teams: 2,
    tasksPerTeam: 1,
  });
  const teamId = spaces[0].id;
  const taskId = tasks[0].id;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const fetchState = async () => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/state`,
    );
    assert.equal(response.status, 200);
    const state = await response.json();
    return {
      state,
      task: state.tasks.find((item) => item.id === taskId),
      team: state.spaces.find((item) => item.id === teamId),
    };
  };
  const initial = await fetchState();
  assert.equal(initial.task.deliveryStatus, 'awaiting-owner');
  assert.equal(initial.state.teamRiskCounts[teamId], 1);
  const db = new DatabaseSync(path.join(app.store.dir, 'workspace.sqlite'));
  try {
    const records = new Records(db);
    records.save(
      'task-acceptance',
      {
        taskId,
        decision: 'accepted',
        verificationId: `${taskId}-0`,
        requirementVersion: 1,
        note: 'External owner review',
      },
      taskId,
    );
    const accepted = await fetchState();
    assert.equal(accepted.task.deliveryStatus, 'accepted');
    assert.equal(accepted.task.acceptanceNote, 'External owner review');
    assert.equal(accepted.state.teamRiskCounts[teamId], 0);
    assert.ok(
      accepted.team.timeline.some(
        (item) =>
          item.type === 'acceptance' && item.acceptanceDecision === 'accepted',
      ),
    );
    assert.equal(
      accepted.team.timeline.find((item) => item.id === `task:${taskId}`)
        .deliveryStatus,
      'accepted',
    );

    records.save(
      'jobs',
      { ...records.get('jobs', taskId), requirementVersion: 2 },
      taskId,
    );
    records.save('usage', { jobId: taskId, totalTokens: 60 });
    records.save('attention', { taskId, status: 'open' }, 'external-attention');
    const changed = await fetchState();
    assert.equal(changed.task.deliveryStatus, 'pending-review');
    assert.equal(changed.task.acceptanceDecision, null);
    assert.equal(changed.task.currentRequirementVersion, 2);
    assert.equal(changed.state.teamRiskCounts[teamId], 2);
    assert.equal(changed.state.openAttentionCount, 1);
    assert.equal(changed.team.autonomyUsage.usedTokens, 160);
    assert.equal(
      changed.state.spaces.find((item) => item.id === spaces[1].id)
        .autonomyUsage.usedTokens,
      100,
    );

    records.remove('artifacts', `${taskId}-0`);
    records.remove('attention', 'external-attention');
    records.remove('space-messages', changed.team.messages[0].id);
    records.remove('task-acceptance', taskId);
    const removed = await fetchState();
    assert.equal(removed.task.artifactCount, 2);
    assert.equal(removed.task.verificationStatus, null);
    assert.equal(removed.state.openAttentionCount, 0);
    assert.equal(removed.state.teamRiskCounts[teamId], 1);
    assert.equal(removed.team.messages.length, 0);
    assert.ok(
      !removed.team.timeline.some((item) =>
        ['verification', 'acceptance', 'message'].includes(item.type),
      ),
    );
    assert.equal(removed.state.tasks.length, 2);
  } finally {
    db.close();
  }
});

void test('indexed timelines preserve team boundaries and paginate equal timestamps without gaps', async (t) => {
  const app = await fixture(t);
  const { spaces, tasks } = seedStateLoad(app.store, {
    teams: 2,
    tasksPerTeam: 2,
  });
  const at = '2026-01-01T00:00:00.000Z';
  app.store.db
    .prepare('UPDATE records SET createdAt=?, updatedAt=?')
    .run(at, at);
  app.store.db.prepare('UPDATE tasks SET createdAt=?, updatedAt=?').run(at, at);
  const teamId = spaces[0].id;
  const ownedIds = new Set(tasks.slice(0, 2).map((task) => task.id));
  const all = app.store.teamTimeline(teamId, 200);
  assert.equal(all.length, 12);
  assert.ok(all.every((item) => item.at === at && ownedIds.has(item.taskId)));
  const pages = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const page = app.store.teamTimeline(teamId, 4, before);
    if (!page.length) break;
    pages.unshift(...page);
    before = `${page[0].at}|${page[0].id}`;
  }
  assert.deepEqual(pages, all);
  assert.deepEqual(
    app.getState().spaces.find((space) => space.id === teamId).timeline,
    all.map((item) =>
      item.type === 'message' ? { ...item, attachments: [] } : item,
    ),
  );
  assert.deepEqual(app.store.teamTimeline('missing-team'), []);
});
