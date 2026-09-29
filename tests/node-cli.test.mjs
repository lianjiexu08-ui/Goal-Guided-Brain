import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/node.mjs');

test('node CLI can bootstrap a portable config from direct flags without exposing identity data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-cli-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  try {
    const result = spawnSync(process.execPath, [script, '--control-url', 'https://workbench.example.test',
      '--workspace', `project=${workspace}`, '--data-dir', path.join(directory, 'node-data'),
      '--max-concurrent', '5', '--print-config'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.deepEqual(config, {
      controlUrl: 'https://workbench.example.test',
      dataDir: path.join(directory, 'node-data'),
      workspaces: { project: workspace },
      maxConcurrent: 5,
      name: os.hostname(),
    });
    assert.equal(result.stdout.includes('token'), false);
    assert.equal(result.stdout.includes('identity'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('node CLI rejects incomplete or unsafe bootstrap flags', () => {
  const missing = spawnSync(process.execPath, [script, '--control-url', 'https://workbench.example.test'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--workspace/);
  const invalid = spawnSync(process.execPath, [script, '--control-url', 'https://workbench.example.test',
    '--workspace', 'project=/tmp/project', '--max-concurrent', '17', '--print-config'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /1 到 16/);
});
