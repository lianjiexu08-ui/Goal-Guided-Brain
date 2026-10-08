import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-team-workspace-'));
  const roots = Object.fromEntries(
    ['global', 'alpha', 'beta'].map((name) => {
      const root = path.join(dir, name);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'project.txt'), name);
      return [name, root];
    }),
  );
  const runs = new Map();
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: roots.global,
    requireCredential: false,
    runtimeFactory: (options) => ({
      start() {
        runs.set(options.task.id, {
          workspace: options.task.workspace,
          marker: fs.readFileSync(
            path.join(options.task.workspace, 'project.txt'),
            'utf8',
          ),
        });
        options.onResult('verified project directory');
        options.onDone('completed', '');
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await app.platform.ready;
  app.platform.providers.save({
    name: 'directory fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'workspace-fixture', tools: true }],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const completed = async (id) => {
    for (let i = 0; i < 100; i++) {
      if (app.store.task(id)?.status === 'completed') return runs.get(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`task did not complete: ${app.store.task(id)?.status}`);
  };
  const team = (root, workspaceMode = 'shared') =>
    app.store.saveTeamSpace({
      name: `${path.basename(root)} team`,
      goal: 'verify workspace ownership',
      workspace: root,
      workspaceMode,
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      recruitment: { phase: 'confirmed' },
    });
  return {
    app,
    roots,
    runs,
    request,
    completed,
    team,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

void test('team member tasks use the team directory; history retains its directory and cannot cross teams', async () => {
  const f = await fixture();
  try {
    const alpha = f.team(f.roots.alpha);
    const beta = f.team(f.roots.beta);
    const create = (teamId, sessionId) =>
      f.request('tasks', {
        role: 'developer',
        prompt: 'check project',
        teamId,
        sessionId,
      });
    const a = await create(alpha.id);
    assert.equal(a.status, 201);
    assert.equal(a.body.workspace, f.roots.alpha);
    assert.equal((await f.completed(a.body.id)).marker, 'alpha');
    const b = await create(beta.id);
    assert.equal(b.status, 201);
    assert.equal(b.body.workspace, f.roots.beta);
    assert.equal((await f.completed(b.body.id)).marker, 'beta');
    assert.equal((await create(beta.id, a.body.sessionId)).status, 409);
    assert.equal((await create(undefined, a.body.sessionId)).status, 409);
    assert.equal(
      (
        await f.request(
          `spaces/${alpha.id}`,
          { workspace: f.roots.beta },
          'PUT',
        )
      ).status,
      200,
    );
    const continued = await create(alpha.id, a.body.sessionId);
    assert.equal(continued.status, 201);
    assert.equal((await f.completed(continued.body.id)).marker, 'alpha');
    const fresh = await create(alpha.id);
    assert.equal(fresh.status, 201);
    assert.equal((await f.completed(fresh.body.id)).marker, 'beta');
    const standalone = await create();
    assert.equal(standalone.status, 201);
    assert.equal((await f.completed(standalone.body.id)).marker, 'global');
  } finally {
    await f.close();
  }
});

void test('PM messages start a new session after directory changes and isolated execution copies the correct project', async () => {
  const f = await fixture();
  try {
    const team = f.team(f.roots.alpha, 'isolated');
    const send = (clientMessageId) =>
      f.request(`spaces/${team.id}/messages`, {
        clientMessageId,
        content: 'check project directory',
      });
    const first = await send('first');
    assert.equal(first.status, 201);
    const firstRun = await f.completed(first.body.taskId);
    assert.equal(firstRun.marker, 'alpha');
    assert.notEqual(firstRun.workspace, f.roots.alpha);
    assert.equal(f.app.store.task(first.body.taskId).workspace, f.roots.alpha);
    assert.equal(
      (await f.request(`spaces/${team.id}`, { workspace: f.roots.beta }, 'PUT'))
        .status,
      200,
    );
    const next = await send('next');
    assert.equal(next.status, 201);
    const nextRun = await f.completed(next.body.taskId);
    assert.equal(nextRun.marker, 'beta');
    assert.notEqual(nextRun.workspace, f.roots.beta);
    assert.notEqual(next.body.sessionId, first.body.sessionId);
    assert.equal(f.app.store.task(first.body.taskId).workspace, f.roots.alpha);
    const continued = await send('continued');
    assert.equal(continued.status, 201);
    assert.equal((await f.completed(continued.body.taskId)).marker, 'beta');
    assert.equal(continued.body.sessionId, next.body.sessionId);
  } finally {
    await f.close();
  }
});
