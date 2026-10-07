import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbench-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
export { sandbox, tick };
