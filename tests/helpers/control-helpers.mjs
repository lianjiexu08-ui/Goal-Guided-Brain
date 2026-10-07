import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../server/store.mjs';
import { ControlPlane } from '../../server/control.mjs';

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-control-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'data'), workspace);
  let time = 1000000;
  const control = new ControlPlane({ store, now: () => time, ...options });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (route, body = {}, token, method = 'POST') =>
    control.handle({
      method,
      parts: route.split('/'),
      body,
      req: { headers: token ? { authorization: `Bearer ${token}` } : {} },
    });
  return {
    store,
    control,
    request,
    directory,
    workspace,
    advance: (value) => {
      time += value;
    },
  };
}
async function pair(request) {
  const pairing = await request('nodes/pairing');
  const result = await request('nodes/pair', {
    code: pairing.body.code,
    name: 'Test node',
    workspaces: ['default'],
    platform: 'test',
  });
  assert.equal(result.status, 201);
  return { ...result.body, code: pairing.body.code };
}
export { setup, pair };
