import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-browser-e2e-'));
const cli = path.resolve('node_modules/@playwright/test/cli.js');
const vinextLock = path.resolve('.vinext/dev/lock.json');
let savedVinextLock = null;
try {
  const current = JSON.parse(fs.readFileSync(vinextLock, 'utf8'));
  if (Number.isInteger(current.pid) && current.pid > 1) {
    try {
      process.kill(current.pid, 0);
      savedVinextLock = fs.readFileSync(vinextLock);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (savedVinextLock) fs.rmSync(vinextLock, { force: true });
const environment = {
  ...process.env,
  GGB_E2E_DATA_DIR: dataDir,
};
const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
});
let stopping = false;
const cleanup = () => {
  if (stopping) return;
  stopping = true;
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (savedVinextLock) {
    fs.mkdirSync(path.dirname(vinextLock), { recursive: true });
    fs.writeFileSync(vinextLock, savedVinextLock, { mode: 0o600 });
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 1 : code ?? 1);
});
