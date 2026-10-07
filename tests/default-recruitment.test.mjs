import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';

test('a new workspace starts with one PM recruitment draft and cannot delegate before confirmation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-first-run-'));
  let store;
  try {
    store = new Store(dir, dir, { seedProjectManager: true });
    const [draft] = store.teamSpaces();
    assert.equal(store.teamSpaces().length, 1);
    assert.equal(draft.recruitment.phase, 'discovery');
    assert.equal(draft.recruitment.confirmedAt, null);
    assert.deepEqual(draft.memberRoleIds, ['project_manager']);
    const task = store.createTask({
      role: draft.pmRoleId,
      prompt: '澄清需求',
      workspace: dir,
    });
    store.records.save(
      'task-meta',
      { spaceId: draft.id, groupId: task.id },
      task.id,
    );
    const control = new ControlPlane({ store });
    const claim = control.claimLocal(task);
    const principal = control.validateInstanceToken(claim.token);
    assert.throws(
      () =>
        control.createJob({ role: 'developer', prompt: '提前实现' }, principal),
      /尚未确认/,
    );
    store.close();
    store = new Store(dir, dir, { seedProjectManager: true });
    assert.equal(store.teamSpaces().length, 1);
    assert.equal(store.teamSpaces()[0].id, draft.id);
    assert.equal(store.teamSpaces()[0].recruitment.phase, 'discovery');
  } finally {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initialization preserves existing confirmed teams and their members', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-existing-team-'));
  let store;
  try {
    store = new Store(dir, dir, { seedProjectManager: true });
    const [draft] = store.teamSpaces();
    const confirmed = store.saveTeamSpace(
      {
        ...draft,
        name: '已有研发团队',
        memberRoleIds: ['project_manager', 'developer'],
        recruitment: {
          ...draft.recruitment,
          phase: 'confirmed',
          confirmedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      draft.id,
    );
    store.close();
    store = new Store(dir, dir, { seedProjectManager: true });
    assert.deepEqual(store.teamSpaces(), [confirmed]);
  } finally {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
