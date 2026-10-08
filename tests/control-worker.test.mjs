import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {
  NodeClient,
  validateControlUrl,
  runNodeCheck,
} from '../server/node-client.mjs';
import { setup } from './helpers/control-helpers.mjs';

void test('worker rejects insecure remote control, resolves local workspace mapping and retains rejected results', async (t) => {
  const { directory, workspace } = setup(t);
  assert.throws(() => validateControlUrl('http://example.com'), /HTTPS/);
  assert.throws(
    () => validateControlUrl('https://user:secret@example.com'),
    /HTTPS/,
  );
  const client = new NodeClient({
    controlUrl: 'http://127.0.0.1:3089',
    dataDir: path.join(directory, 'node'),
    workspaces: { default: workspace },
    runtimeFactory: () => ({}),
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'Lease expired' }), { status: 409 }),
  });
  t.after(() => client.close());
  const task = {
    task: { id: 'example-task', workspace: '/arbitrary/remote/path' },
    workspaceKey: 'default',
  };
  const prepared = await client.isolatedWorkspace(task);
  assert.ok(prepared.workspace.startsWith(path.join(directory, 'node')));
  assert.notEqual(prepared.workspace, task.task.workspace);
  await assert.rejects(client.isolatedWorkspace(task), /已经存在/);
  await assert.rejects(
    client.isolatedWorkspace({ ...task, workspaceKey: 'missing' }),
    /映射/,
  );
  client.enqueueResult('example-task', 1, {
    status: 'completed',
    result: 'done',
  });
  client.enqueueResult('example-task', 1, {
    status: 'completed',
    result: 'duplicate',
  });
  assert.equal(
    client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,
    1,
  );
  await client.flushOutbox();
  assert.equal(
    client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,
    0,
  );
  assert.equal(
    client.db.prepare('SELECT COUNT(*) AS n FROM rejected_results').get().n,
    1,
  );
});

void test('worker self-stops an expired lease even without a successful controller heartbeat', async (t) => {
  const { directory, workspace } = setup(t);
  let time = 10000,
    cancelled = 0;
  const client = new NodeClient({
    controlUrl: 'http://localhost:3089',
    dataDir: path.join(directory, 'node-stop'),
    workspaces: { default: workspace },
    runtimeFactory: () => ({}),
    now: () => time,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => client.close());
  client.active.set('task', {
    taskId: 'task',
    epoch: 1,
    deadline: 11000,
    done: false,
    stopping: false,
    run: {
      cancel: async () => {
        cancelled++;
      },
    },
  });
  time = 12000;
  await client.stopExpired();
  assert.equal(cancelled, 1);
  assert.equal(client.active.size, 0);
  assert.equal(
    client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,
    1,
  );
});

void test('worker exposes offline and restored connection events while retrying the control plane', async (t) => {
  const { directory, workspace } = setup(t);
  let attempts = 0;
  const events = [];
  const client = new NodeClient({
    controlUrl: 'http://localhost:3089',
    dataDir: path.join(directory, 'node-reconnect'),
    workspaces: { default: workspace },
    runtimeFactory: () => ({}),
    onEvent: (event) => events.push(event),
    fetchImpl: async (url) => {
      attempts += 1;
      if (attempts === 1) throw new Error('控制端暂时不可达');
      const requestUrl =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const endpoint = requestUrl.split('/').pop();
      return new Response(
        JSON.stringify(
          endpoint === 'heartbeat'
            ? { leases: [], serverTime: 10000 }
            : { assignment: null },
        ),
        { status: 200 },
      );
    },
  });
  client.identity = {
    nodeId: 'node-reconnect',
    token: 'fixture-token',
    controlUrl: client.controlUrl,
  };
  t.after(() => client.close());
  await client.tick();
  assert.equal(client.connectionState, 'offline');
  assert.equal(client.connectionFailures, 1);
  await client.tick();
  assert.equal(client.connectionState, 'online');
  assert.equal(client.connectionFailures, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['connection-offline', 'connection-error', 'connection-restored'],
  );
});

void test('HTTP and TCP monitors execute deterministically without a model', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal(
    (await runNodeCheck({ kind: 'http', url: `http://127.0.0.1:${port}` }))
      .status,
    'completed',
  );
  assert.equal(
    (await runNodeCheck({ kind: 'tcp', host: '127.0.0.1', port })).status,
    'completed',
  );
  assert.equal(
    (await runNodeCheck({ kind: 'tcp', host: '127.0.0.1', port: 0 })).status,
    'failed',
  );
});
