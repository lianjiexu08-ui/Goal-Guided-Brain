import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plan-deadline-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};

void test('overdue team plans create one deduplicated attention and resolve after rescheduling', async () => {
  const fixture = sandbox();
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: () => ({ start() {}, cancel() {} }),
  });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route) => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = app.store.teamSpaces()[0];
    const saved = app.store.saveTeamPlan(team.id, {
      summary: '按期完成首个可交付版本。',
      dueAt: '2020-01-01',
      milestones: [],
    });
    const first = app.platform.checkPlanDeadlines();
    assert.deepEqual(first, { overdue: 1, resolved: 0 });
    app.platform.checkPlanDeadlines();
    const attention = app.store.records
      .list('attention')
      .filter(
        (item) => item.kind === 'plan-overdue' && item.teamId === team.id,
      );
    assert.equal(attention.length, 1);
    const notifications = app.store.records
      .list('notifications')
      .filter(
        (item) => item.kind === 'plan-overdue' && item.spaceId === team.id,
      );
    assert.equal(notifications.length, 1);
    const risks = await request(`risks?kind=plan&teamId=${team.id}`);
    assert.equal(risks.status, 200);
    assert.equal(risks.body.total, 1);
    assert.equal(risks.body.items[0].kind, 'plan');
    assert.equal(risks.body.items[0].status, 'open');

    const rescheduled = app.store.saveTeamPlan(team.id, {
      ...saved,
      dueAt: '2099-01-01',
      revision: saved.revision,
    });
    assert.equal(rescheduled.dueAt, '2099-01-01');
    assert.deepEqual(app.platform.checkPlanDeadlines(), {
      overdue: 0,
      resolved: 1,
    });
    assert.equal(
      app.store.records.get('attention', `plan-overdue:${team.id}`).status,
      'resolved',
    );
    assert.equal(
      app.store.records.get(
        'notifications',
        `attention:plan-overdue:${team.id}`,
      ).read,
      true,
    );

    const overdueAgain = app.store.saveTeamPlan(team.id, {
      ...rescheduled,
      dueAt: '2020-01-01',
      revision: rescheduled.revision,
    });
    assert.equal(overdueAgain.dueAt, '2020-01-01');
    app.platform.checkPlanDeadlines(() => Date.parse('2030-01-01T00:00:00Z'));
    assert.equal(
      app.store.records.get(
        'notifications',
        `attention:plan-overdue:${team.id}`,
      ).read,
      false,
    );
    assert.equal(
      app.store.records.get(
        'notifications',
        `attention:plan-overdue:${team.id}`,
      ).readAt,
      null,
    );
    assert.equal(app.getState().unreadNotificationCount, 1);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
