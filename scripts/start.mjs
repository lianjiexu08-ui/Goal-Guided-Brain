import { spawn, execFileSync } from 'node:child_process';

// 生产适配器需要连接生命周期补丁（客户端断开时取消上游流）；幂等，可重复运行。
try {
  execFileSync(process.execPath, [fileURLToPath(new URL('./patch-vinext.mjs', import.meta.url))], { stdio: 'inherit' });
} catch (error) {
  console.error('vinext 生命周期补丁失败：', error.message);
}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../server/runtime.mjs';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
process.env.PATH = [
  path.dirname(process.execPath),
  path.join(os.homedir(), '.local/bin'),
  process.env.PATH || '',
].join(path.delimiter);
const dataDir =
  process.env.WORKBENCH_DATA_DIR || path.join(os.homedir(), '.dsh-workbench');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const pidFile = path.join(dataDir, 'service.pid');
if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 0);
      console.error('工作台服务已经运行。');
      process.exit(1);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
const childrenFile = path.join(dataDir, 'service.children.json');
// Spawn with absolute paths: `ps` then shows which checkout a process belongs
// to, so scripts/stop.mjs can verify ownership before terminating anything it
// finds left over.
const apiScript = path.join(process.cwd(), 'server', 'index.mjs');
const uiScript = path.join(process.cwd(), 'node_modules', 'vinext', 'dist', 'cli.js');
const children = [
  spawn(process.execPath, [apiScript], { stdio: 'inherit' }),
  spawn(
    process.execPath,
    [
      uiScript,
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(process.env.WORKBENCH_UI_PORT || 3088),
    ],
    { stdio: 'inherit' },
  ),
];
// The UI child is recorded nowhere else (only the API writes control.lock), so
// without this file an abruptly killed supervisor strands it holding the UI
// port with nothing left pointing at it.  Deliberately *not* removed by the
// exit handler below unless the children are really gone — it has to outlive
// an abnormal exit to be useful.
try {
  fs.writeFileSync(
    childrenFile,
    JSON.stringify(children.map((child, index) => ({
      pid: child.pid,
      script: index === 0 ? apiScript : uiScript,
    }))),
    { mode: 0o600 },
  );
} catch {
  /* Recovery metadata is best-effort; never block startup on it. */
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminateProcessTree(child.pid);
  setTimeout(() => process.exit(code), 2500);
}
process.on('exit', () => {
  try {
    if (fs.readFileSync(pidFile, 'utf8') === String(process.pid))
      fs.unlinkSync(pidFile);
  } catch {}
  // Only drop the child record once the children are really gone; on an
  // abnormal exit it is the sole trace of the orphaned UI process.
  try {
    if (children.every((child) => child.exitCode !== null || child.signalCode))
      fs.unlinkSync(childrenFile);
  } catch {}
});
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
// Closing the terminal sends SIGHUP.  Node's default action terminates the
// process without running stop(), which left the children re-parented to init
// while the exit handler above removed service.pid — a state that neither
// `npm run stop` nor `npm start` could recover from.
process.on('SIGHUP', () => stop());
