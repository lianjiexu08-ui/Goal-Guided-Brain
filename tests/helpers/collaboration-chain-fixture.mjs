import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../../server/index.mjs';
import { seedConfirmedDefaultTeam } from '../fixtures/confirmed-default-team.mjs';

export async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-chain-'));
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  const source = seedConfirmedDefaultTeam(store);
  store.records.save(
    'nodes',
    { name: 'Chain fixture', status: 'offline' },
    'chain-offline',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Chain manager',
    nodeId: 'chain-offline',
  });
  const makeTeam = (name) =>
    store.saveTeamSpace({
      ...source,
      id: undefined,
      chatId: undefined,
      name,
      pmRoleId: role.id,
      memberRoleIds: [role.id],
    });
  const target = makeTeam('Target');
  const other = makeTeam('Other');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(url, body, token) {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${url}`,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  }
  let counter = 0;
  async function send(parent = null, peer = target, status = 'completed') {
    const sent = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: peer.id,
      content: `Request ${++counter}`,
      clientMessageId: `chain-${counter}`,
      followupMessageId: parent?.sourceMessageId,
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const task = store.updateTask(sent.body.taskId, {
      status,
      result: `Private unshared result ${counter}`,
    });
    const meta = store.records.get('task-meta', task.id);
    const job = store.records.get('jobs', meta.jobId);
    store.records.save('jobs', { ...job, status }, job.id);
    return sent.body;
  }
  const endpoint = (row, team = source) =>
    `teams/${team.id}/collaboration-chain/${encodeURIComponent(row.sourceMessageId)}`;
  return { app, store, source, target, other, request, send, endpoint };
}
