import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
};
export { sandbox, tick, waitFor };
