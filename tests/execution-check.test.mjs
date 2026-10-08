import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLocalExecution } from '../server/execution-check.mjs';
import { findDsh } from '../server/runtime.mjs';
import { createWorkbench } from '../server/index.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-execution-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const discover = () => '';

test('execution inspection reads existing directories without creating files, running engines or resolving relative paths', async (t) => {
  const root = directory(t);
  const executable = path.join(root, 'engine');
  fs.writeFileSync(executable, '#!/bin/sh\ntouch should-not-run\n', {
    mode: 0o700,
  });
  const cases = [
    [root, 'pass', '可以读取和进入'],
    [path.join(root, 'absent'), 'fail', '目录不存在'],
    [executable, 'fail', '这个路径是文件'],
    ['relative-folder', 'fail', '绝对路径'],
    ['', 'fail', '绝对路径'],
    [root + '\0bad', 'fail', '绝对路径'],
  ];
  const before = fs.readdirSync(root);
  for (const [workspace, status, message] of cases) {
    const report = await inspectLocalExecution(workspace, {
      discover: () => executable,
    });
    assert.equal(report.checks[0].status, status);
    assert.ok(report.checks[0].detail.includes(message));
    assert.equal(report.checks[1].status, 'pass');
  }
  const home = await inspectLocalExecution('~/child', {
    home: root,
    discover,
    io: {
      stat: async (value) => {
        assert.equal(value, path.join(root, 'child'));
        return { isDirectory: () => true };
      },
      access: async () => {},
    },
  });
  assert.equal(home.checks[0].status, 'pass');
  assert.equal(home.checks[1].status, 'fail');
  assert.deepEqual(fs.readdirSync(root), before);
  await assert.rejects(inspectLocalExecution(null), /工作目录/);
  await assert.rejects(inspectLocalExecution('a'.repeat(2001)), /2000/);
});

test('execution inspection distinguishes unreadable, read-only and inaccessible volumes', async () => {
  for (const [code, message] of [
    ['EACCES', '目录权限'],
    ['ENOTDIR', '目录不存在'],
    ['EIO', '磁盘可访问'],
  ]) {
    const report = await inspectLocalExecution(process.cwd(), {
      discover,
      io: {
        stat: async () => {
          throw Object.assign(new Error('fixture'), { code });
        },
      },
    });
    assert.equal(report.checks[0].status, 'fail');
    assert.ok(report.checks[0].detail.includes(message));
  }
  const report = await inspectLocalExecution(process.cwd(), {
    discover,
    io: {
      stat: async () => ({ isDirectory: () => true }),
      access: async (_path, mode) => {
        if (mode === fs.constants.W_OK)
          throw Object.assign(new Error('readonly'), { code: 'EACCES' });
      },
    },
  });
  assert.equal(report.checks[0].status, 'warn');
  assert.match(report.checks[0].detail, /没有写入权限/);
});

test('runtime discovery rejects searchable directories and accepts regular executables and file symlinks', (t) => {
  const root = directory(t);
  const options = { homeDir: root, pathValue: '', configured: root };
  assert.equal(findDsh(options), '');
  const executable = path.join(root, 'runtime');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(findDsh({ ...options, configured: executable }), executable);
  if (process.platform !== 'win32') {
    fs.chmodSync(executable, 0o600);
    assert.equal(findDsh({ ...options, configured: executable }), '');
    fs.chmodSync(executable, 0o700);
    const link = path.join(root, 'link');
    fs.symlinkSync(executable, link);
    assert.equal(findDsh({ ...options, configured: link }), link);
    fs.unlinkSync(executable);
    assert.equal(findDsh({ ...options, configured: link }), '');
  }
});

test('execution check HTTP requires owner access, validates requests and leaves configuration and tasks unchanged', async (t) => {
  const root = directory(t);
  let runs = 0;
  const app = createWorkbench({
    dataDir: path.join(root, 'data'),
    workspace: root,
    runtimeFactory: () => {
      runs++;
      throw Error('Must not run');
    },
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}/api/execution-check`;
  const send = (body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  app.platform.auth.requireAuth = true;
  assert.equal((await send({ workspace: root })).status, 401);
  app.platform.auth.requireAuth = false;
  const config = structuredClone(app.store.config);
  const response = await send({ workspace: path.join(root, 'missing') });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checks[0].status, 'fail');
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  assert.equal((await send({ workspace: root })).status, 200);
  assert.equal((await send({ workspace: {} })).status, 400);
  assert.deepEqual(app.store.config, config);
  assert.equal(app.store.tasks().length, 0);
  assert.equal(runs, 0);
});
