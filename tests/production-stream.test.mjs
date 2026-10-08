import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { startProdServer } from 'vinext/server/prod-server';

async function loadProxy() {
  const source = fs.readFileSync(
    new URL('../app/api/[...path]/route.ts', import.meta.url),
    'utf8',
  );
  const routeModule = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  );
  return { forward: routeModule.GET };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Connection lifecycle timed out')),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function production(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-stream-'));
  const key = `ggb-${randomUUID()}`;
  globalThis[key] = handler;
  fs.mkdirSync(path.join(root, 'client'));
  const entry = path.join(root, 'entry.mjs');
  fs.writeFileSync(
    entry,
    `export default (request) => globalThis[${JSON.stringify(key)}](request);`,
  );
  const app = await startProdServer({
    port: 0,
    host: '127.0.0.1',
    outDir: root,
    rscEntryPath: entry,
    silent: true,
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    delete globalThis[key];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...app, url: `http://127.0.0.1:${app.port}` };
}
function connect(url) {
  const client = http.get(url);
  client.on('error', () => {});
  return client;
}

void test('production aborts pending Web Requests when the client leaves before headers', async (t) => {
  const entered = deferred();
  const aborted = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const app = await production(t, async (request) => {
    request.signal.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    });
    entered.resolve();
    await release.promise;
    return new Response('late response');
  });
  const client = connect(app.url);
  await within(entered.promise);
  client.destroy();
  await within(aborted.promise);
  release.resolve();
});

void test('production cancels late response bodies without closed-stream errors', async (t) => {
  const entered = deferred();
  const disconnected = deferred();
  const release = deferred();
  const cancelled = deferred();
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const app = await production(t, async () => {
    entered.resolve();
    await release.promise;
    return new Response(
      new ReadableStream({ cancel: () => cancelled.resolve() }),
    );
  });
  app.server.prependListener('request', (_req, res) =>
    res.once('close', disconnected.resolve),
  );
  const client = connect(app.url);
  await within(entered.promise);
  client.destroy();
  await within(disconnected.promise);
  release.resolve();
  await within(cancelled.promise);
  assert.deepEqual(errors, []);
});

void test('production proxy releases upstream connections before and after SSE headers and preserves resume cursors', async (t) => {
  const { forward } = await loadProxy();
  const pending = new Map();
  let active = 0;
  const received = [];
  const backend = http.createServer((req, res) => {
    active++;
    const stage = pending.get(req.url);
    res.once('close', () => {
      active--;
      stage?.closed.resolve();
    });
    received.push(req.headers['last-event-id']);
    if (req.url.startsWith('/api/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
    }
    stage?.entered.resolve();
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const previous = {
    ui: process.env.WORKBENCH_UI_PORT,
    api: process.env.WORKBENCH_API_PORT,
  };
  t.after(async () => {
    for (const [name, value] of [
      ['WORKBENCH_UI_PORT', previous.ui],
      ['WORKBENCH_API_PORT', previous.api],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  });
  process.env.WORKBENCH_API_PORT = String(backend.address().port);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const app = await production(t, forward);
  process.env.WORKBENCH_UI_PORT = String(app.port);
  for (let i = 0; i < 12; i++) {
    const route = `/api/${i % 2 ? 'stream' : 'pending'}?cycle=${i}`;
    const stage = { entered: deferred(), closed: deferred() };
    pending.set(route, stage);
    const client = http.get(app.url + route, {
      headers: { 'Last-Event-ID': `cursor-${i}` },
    });
    client.on('error', () => {});
    const data = deferred();
    client.on('response', (res) => res.once('data', data.resolve));
    await within(stage.entered.promise);
    if (i % 2) await within(data.promise);
    client.destroy();
    await within(stage.closed.promise);
    assert.equal(active, 0);
  }
  assert.deepEqual(
    received,
    Array.from({ length: 12 }, (_, i) => `cursor-${i}`),
  );
  assert.deepEqual(errors, []);
});

void test('production keeps normal requests alive, cleans listeners, and reports genuine handler failures', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const signals = [];
  const completions = [];
  const app = await production(t, async (request) => {
    signals.push(request.signal);
    if (new URL(request.url).pathname === '/failure')
      throw Error('fixture handler failure');
    const body = await request.text();
    return new Response(body || 'healthy', {
      status: 201,
      headers: { 'Content-Type': 'text/plain' },
    });
  });
  app.server.prependListener('request', (req, res) => {
    const complete = deferred();
    completions.push(complete.promise);
    res.once('finish', () =>
      setImmediate(() => {
        complete.resolve({
          request: req.listenerCount('aborted'),
          response: res.listenerCount('close'),
        });
      }),
    );
  });
  const response = await fetch(app.url, {
    method: 'POST',
    body: 'request body',
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'request body');
  assert.equal((await fetch(app.url + '/failure')).status, 500);
  const listeners = await Promise.all(completions.map(within));
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.ok(listeners.every((counts) => counts.request === 0));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /fixture handler failure/);
});

void test('dependency patch rejects changed versions, edited or partially patched adapters', async () => {
  const { patchVinext } =
    await import('../scripts/patches/vinext-lifecycle.mjs');
  const source = fs.readFileSync(
    new URL(import.meta.resolve('vinext/server/prod-server')),
    'utf8',
  );
  assert.equal(patchVinext(source, '1.0.0-beta.9'), source);
  assert.throws(() => patchVinext(source, '1.0.0-beta.10'), /Review/);
  assert.throws(
    () => patchVinext(source + '\n// changed', '1.0.0-beta.9'),
    /Unexpected/,
  );
  const partial = source.replace(
    'authorizeOnDemandRevalidate, signal) {',
    'authorizeOnDemandRevalidate) {',
  );
  assert.notEqual(partial, source);
  assert.throws(() => patchVinext(partial, '1.0.0-beta.9'), /Incomplete/);
});

void test('API proxy preserves authentication, state metadata, cookies and attachment bytes', async (t) => {
  const { forward } = await loadProxy();
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 42]);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, init });
    return new Response(bytes, {
      status: 206,
      headers: [
        ['Content-Type', 'application/octet-stream'],
        ['Content-Disposition', 'attachment; filename="fixture.bin"'],
        ['ETag', '"fixture"'],
        ['X-GGB-State-Format', 'delta'],
        ['Vary', 'X-GGB-State-View'],
        ['Set-Cookie', 'a=1; HttpOnly'],
        ['Set-Cookie', 'b=2; HttpOnly'],
      ],
    });
  });
  const request = new Request(
    'http://127.0.0.1:3088/api/attachments/file?download=1',
    {
      headers: {
        Cookie: 'session=fixture',
        Authorization: 'Bearer fixture',
        'If-None-Match': '"old"',
        'X-GGB-State-View': 'workspace',
        'X-GGB-State-Delta': '1',
        Origin: 'http://127.0.0.1:3088',
        'Mcp-Session-Id': 'fixture-session',
      },
    },
  );
  const response = await forward(request);
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.match(response.headers.get('content-disposition'), /fixture.bin/);
  assert.equal(response.headers.get('etag'), '"fixture"');
  assert.equal(response.headers.get('x-ggb-state-format'), 'delta');
  assert.equal(response.headers.get('vary'), 'X-GGB-State-View');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(response.headers.getSetCookie(), [
    'a=1; HttpOnly',
    'b=2; HttpOnly',
  ]);
  for (const [key, value] of request.headers)
    assert.equal(seen[0].init.headers.get(key), value);
  assert.equal(seen[0].init.signal, request.signal);
  assert.match(seen[0].url, /\/api\/attachments\/file\?download=1$/);
  assert.equal(
    (await forward(new Request('https://untrusted.invalid/api/state'))).status,
    403,
  );
  assert.equal(seen.length, 1);
});

void test('API proxy discards expected client cancellation but still rejects unrelated failures', async (t) => {
  const { forward } = await loadProxy();
  const controller = new AbortController();
  const request = new Request('http://127.0.0.1:3088/api/state', {
    signal: controller.signal,
  });
  controller.abort(new DOMException('Fixture disconnect', 'AbortError'));
  t.mock.method(globalThis, 'fetch', async () => {
    throw request.signal.reason;
  });
  const cancelled = await forward(request);
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.body, null);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('Unrelated upstream failure');
  });
  await assert.rejects(forward(request), /Unrelated upstream failure/);
});

void test('incomplete POST disconnect releases request body without contacting the upstream API', async (t) => {
  const { forward } = await loadProxy();
  const entered = deferred();
  const completed = deferred();
  const errors = [];
  const previous = process.env.WORKBENCH_UI_PORT;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKBENCH_UI_PORT;
    else process.env.WORKBENCH_UI_PORT = previous;
  });
  t.mock.method(console, 'error', (...args) => errors.push(args));
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstreamCalls++;
    throw Error('Incomplete body must not reach API');
  });
  const app = await production(t, async (request) => {
    entered.resolve();
    try {
      return await forward(request);
    } finally {
      completed.resolve();
    }
  });
  process.env.WORKBENCH_UI_PORT = String(app.port);
  const client = http.request(app.url + '/api/attachments', {
    method: 'POST',
    headers: { 'Content-Length': '10000' },
  });
  client.on('error', () => {});
  client.write('partial-body');
  await within(entered.promise);
  client.destroy();
  await within(completed.promise);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(errors, []);
});
