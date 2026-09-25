import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-browser-e2e-'));
const cli = path.resolve('node_modules/@playwright/test/cli.js');
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
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 1 : code ?? 1);
});
