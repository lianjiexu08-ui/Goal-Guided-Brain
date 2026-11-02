import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isControlOwnerCommand,
  isSupervisorCommand,
  processCommand,
  stopWorkbench,
} from '../scripts/stop.mjs';

const root = '/repo';
const startScript = '/repo/scripts/start.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-stop-'));
  return {
    dir,
    writePid: (pid) => fs.writeFileSync(path.join(dir, 'service.pid'), String(pid)),
    writeLock: (body) => fs.writeFileSync(path.join(dir, 'control.lock'), body),
    writeChildren: (entries) => fs.writeFileSync(path.join(dir, 'service.children.json'), JSON.stringify(entries)),
    has: (name) => fs.existsSync(path.join(dir, name)),
  };
}

function run(f, { command, killed = [] } = {}) {
  return stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command,
    terminate: (pid) => killed.push(pid),
  });
}

test('stop terminates the supervisor recorded in service.pid', () => {
  const f = fixture();
  f.writePid(4242);
  const killed = [];
  const result = run(f, { command: () => '/usr/bin/node /repo/scripts/start.mjs', killed });
  assert.equal(result.status, 'stopped');
  assert.equal(result.pid, 4242);
  assert.deepEqual(killed, [4242]);
});

test('stop clears a service.pid whose process is gone without killing anything', () => {
  const f = fixture();
  f.writePid(4242);
  const killed = [];
  const result = run(f, { command: () => '', killed });
  assert.equal(result.status, 'already-stopped');
  assert.deepEqual(killed, []);
  assert.equal(f.has('service.pid'), false);
});

test('stop refuses to kill a recycled pid that is not our supervisor', () => {
  const f = fixture();
  f.writePid(4242);
  const killed = [];
  assert.throws(() => run(f, { command: () => '/usr/bin/postgres -D /var/lib/pg', killed }),
    /已被其他进程使用/);
  assert.deepEqual(killed, []);
  // The record is kept so the operator can inspect it.
  assert.equal(f.has('service.pid'), true);
});

test('stop rejects a malformed service.pid', () => {
  const f = fixture();
  f.writePid('not-a-pid');
  assert.throws(() => run(f, { command: () => '' }), /无效的服务 PID/);
  f.writePid(1);
  assert.throws(() => run(f, { command: () => '' }), /无效的服务 PID/);
});

test('stop recovers an orphaned API child through control.lock when service.pid is gone', () => {
  // The supervisor deletes service.pid from its exit handler but cannot reap
  // its children when it is killed abruptly, so the API keeps the lock and the
  // port while no pid file remains.  Without this fallback neither `npm run
  // stop` nor `npm start` can get the user out of that state.
  const f = fixture();
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = run(f, { command: () => '/usr/bin/node /repo/server/index.mjs', killed });
  assert.equal(result.status, 'stopped-orphan');
  assert.equal(result.pid, 777);
  assert.deepEqual(killed, [777]);
  assert.match(result.message, /777/);
});

test('stop accepts the relative command form the supervisor spawns', () => {
  const f = fixture();
  f.writeLock(JSON.stringify({ pid: 778, token: 'abc' }));
  const killed = [];
  const result = run(f, { command: () => '/usr/bin/node server/index.mjs', killed });
  assert.equal(result.status, 'stopped-orphan');
  assert.deepEqual(killed, [778]);
});

test('stop removes a stale control.lock whose owner is gone', () => {
  const f = fixture();
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = run(f, { command: () => '', killed });
  assert.equal(result.status, 'stale-lock');
  assert.deepEqual(killed, []);
  assert.equal(f.has('control.lock'), false);
});

test('stop refuses to kill a recycled pid recorded in control.lock', () => {
  const f = fixture();
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  assert.throws(() => run(f, { command: () => '/usr/bin/node /other/app/server/main.mjs', killed }),
    /已被其他进程使用/);
  assert.deepEqual(killed, []);
  assert.equal(f.has('control.lock'), true);
});

test('stop ignores an unreadable or malformed control.lock', () => {
  const f = fixture();
  f.writeLock('{ truncated');
  assert.equal(run(f, { command: () => 'x' }).status, 'not-running');
  f.writeLock(JSON.stringify({ pid: 1, token: 'abc' }));
  assert.equal(run(f, { command: () => 'x' }).status, 'not-running');
});

test('stop reports nothing running when neither record exists', () => {
  const f = fixture();
  const result = run(f, { command: () => 'x' });
  assert.equal(result.status, 'not-running');
});

test('service.pid wins over control.lock when both are present', () => {
  const f = fixture();
  f.writePid(4242);
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = run(f, { command: () => '/usr/bin/node /repo/scripts/start.mjs', killed });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(killed, [4242]);
});

test('ownership checks distinguish our processes from lookalikes', () => {
  assert.equal(isSupervisorCommand('node scripts/start.mjs', { startScript }), true);
  assert.equal(isSupervisorCommand('/usr/bin/node /repo/scripts/start.mjs', { startScript }), true);
  assert.equal(isSupervisorCommand('node /elsewhere/scripts/start.mjs.bak', { startScript }), false);

  assert.equal(isControlOwnerCommand('/usr/bin/node /repo/server/index.mjs', { root }), true);
  assert.equal(isControlOwnerCommand('node server/index.mjs', { root }), true);
  assert.equal(isControlOwnerCommand('node /repo/server/index.mjs --flag', { root }), false);
  // A same-named script belonging to some other project must never match,
  // otherwise a recycled pid could get an unrelated service killed.
  assert.equal(isControlOwnerCommand('node /other/server/index.mjs', { root }), false);
  assert.equal(isControlOwnerCommand('node /other/project/server/index.mjs', { root }), false);
});

test('processCommand returns an empty string for a dead pid instead of throwing', () => {
  assert.equal(processCommand(999999, {
    platform: 'linux',
    run: () => { throw new Error('No such process'); },
  }), '');
});

test('processCommand reports a missing PowerShell clearly on Windows', () => {
  assert.throws(() => processCommand(1, {
    platform: 'win32',
    run: () => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; },
  }), /PowerShell 不可用/);
});

test('a dead supervisor does not mask a still-running orphan child', () => {
  // Observed for real: SIGKILL on the supervisor leaves service.pid pointing
  // at a dead pid while the API child keeps the lock and the port.  Clearing
  // the stale record and reporting "已经停止" would strand that child.
  const f = fixture();
  f.writePid(4242);
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command: (pid) => (pid === 777 ? '/usr/bin/node /repo/server/index.mjs' : ''),
    terminate: (pid) => killed.push(pid),
  });
  assert.equal(result.status, 'stopped-orphan');
  assert.deepEqual(killed, [777]);
  assert.equal(f.has('service.pid'), false);
});

test('a dead supervisor with no surviving child still reports stopped', () => {
  const f = fixture();
  f.writePid(4242);
  const killed = [];
  const result = run(f, { command: () => '', killed });
  assert.equal(result.status, 'already-stopped');
  assert.deepEqual(killed, []);
  assert.equal(f.has('service.pid'), false);
});

test('orphaned UI child is reaped from service.children.json', () => {
  // Only the API writes control.lock, so without this record the vinext UI
  // child survives holding the UI port and the next `npm start` dies with
  // EADDRINUSE even though the lock was recovered.
  const f = fixture();
  f.writeChildren([
    { pid: 801, script: '/repo/server/index.mjs' },
    { pid: 802, script: '/repo/node_modules/vinext/dist/cli.js' },
  ]);
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command: (pid) => (pid === 801
      ? '/usr/bin/node /repo/server/index.mjs'
      : '/usr/bin/node /repo/node_modules/vinext/dist/cli.js start --hostname 127.0.0.1 --port 3088'),
    terminate: (pid) => killed.push(pid),
  });
  assert.equal(result.status, 'stopped-orphan');
  assert.deepEqual(killed, [801, 802]);
  assert.equal(f.has('service.children.json'), false);
});

test('child reaping verifies the recorded script before terminating', () => {
  const f = fixture();
  f.writeChildren([
    { pid: 801, script: '/repo/node_modules/vinext/dist/cli.js' },
    { pid: 802, script: '/repo/server/index.mjs' },
  ]);
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    // 801's pid was recycled by something unrelated; 802 is genuinely ours.
    command: (pid) => (pid === 801
      ? '/usr/sbin/sshd -D'
      : '/usr/bin/node /repo/server/index.mjs'),
    terminate: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [802]);
  assert.equal(result.status, 'stopped-orphan');
});

test('child reaping skips malformed entries and dead pids', () => {
  const f = fixture();
  f.writeChildren([
    null,
    { pid: 1, script: '/repo/server/index.mjs' },
    { pid: 803, script: '' },
    { pid: 804, script: '/repo/server/index.mjs' },
  ]);
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command: () => '',
    terminate: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, []);
  assert.equal(result.status, 'not-running');
  assert.equal(f.has('service.children.json'), false);
});

test('the control-lock owner is not terminated twice when also recorded as a child', () => {
  const f = fixture();
  f.writeChildren([{ pid: 777, script: '/repo/server/index.mjs' }]);
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command: () => '/usr/bin/node /repo/server/index.mjs',
    terminate: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [777]);
  assert.equal(result.status, 'stopped-orphan');
});

test('reaping children also clears a lock whose owner already died', () => {
  const f = fixture();
  f.writeChildren([{ pid: 802, script: '/repo/node_modules/vinext/dist/cli.js' }]);
  f.writeLock(JSON.stringify({ pid: 777, token: 'abc' }));
  const killed = [];
  const result = stopWorkbench({
    dataDir: f.dir,
    platform: 'linux',
    root,
    startScript,
    command: (pid) => (pid === 802
      ? '/usr/bin/node /repo/node_modules/vinext/dist/cli.js start --port 3088'
      : ''),
    terminate: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [802]);
  assert.equal(result.status, 'stopped-orphan');
  assert.equal(f.has('control.lock'), false);
});
