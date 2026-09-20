import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const children = [
  spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit' }),
  spawn(
    process.execPath,
    [
      'node_modules/vinext/dist/cli.js',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(process.env.WORKBENCH_UI_PORT || 3088),
    ],
    { stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 2500);
}
process.on('exit', () => {
  try {
    if (fs.readFileSync(pidFile, 'utf8') === String(process.pid))
      fs.unlinkSync(pidFile);
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
