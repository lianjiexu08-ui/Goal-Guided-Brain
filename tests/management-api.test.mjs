import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-management-api-'));
  const workspace = path.join(dir, 'workspace'),
    dataDir = path.join(dir, 'data');
  const app = createWorkbench({ workspace, dataDir, requireCredential: false });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (
    route,
    body,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await fetch(`${url}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { app, request, url, dataDir, workspace };
}

test('health endpoint supports HEAD probes without a response body', async (t) => {
  const { request } = await fixture(t);
  const response = await request('health', undefined, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
});

test('TypeSafe-only configuration does not masquerade as a chat model', async (t) => {
  const { app, request } = await fixture(t);
  app.platform.providers.save({
    name: 'TypeSafe decisions',
    protocol: 'typesafe-system-one',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'jev-latest' }],
  });
  assert.equal((await request('state')).body.config.hasApiKey, false);
  app.platform.providers.save({
    name: 'Chat fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'chat-fixture' }],
  });
  assert.equal((await request('state')).body.config.hasApiKey, true);
});

test('management API synchronizes a provider catalog without exposing its credential', async (t) => {
  const { app, request } = await fixture(t);
  let authorization = '';
  const remote = http.createServer((req, res) => {
    authorization = req.headers.authorization || '';
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'catalog-model', context_window: 64000 },
      { id: 'catalog-audio', modalities: ['audio'] },
    ] }));
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => remote.close());
  await request('vault/initialize', { passphrase: 'fixture-vault-password-123' });
  const credential = await app.platform.vault.put({ name: 'catalog', value: 'catalog-secret' });
  const created = await request('providers', {
    name: 'Catalog fixture',
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${remote.address().port}/v1`,
    credentialId: credential.id,
    models: [{ id: 'old-model', tools: true }],
  });
  assert.equal(created.status, 200);
  const synced = await request(`providers/${created.body.id}/sync-models`, {}, 'POST');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.body.provider.models.map((model) => model.id), ['catalog-model']);
  assert.deepEqual(synced.body.removed, ['old-model']);
  assert.equal(authorization, 'Bearer catalog-secret');
  assert.equal(JSON.stringify(synced.body).includes('catalog-secret'), false);
});

test('legacy key migration preserves the old file until encrypted storage succeeds and wires the provider', async (t) => {
  const { app, request, dataDir } = await fixture(t);
  const filename = path.join(dataDir, 'secrets.json'),
    secret = 'fixture-old-private-token';
  fs.writeFileSync(filename, JSON.stringify({ apiKey: secret }), {
    mode: 0o600,
  });
  assert.equal((await request('vault/import-legacy', {})).status, 400);
  assert.equal(fs.existsSync(filename), true);
  assert.equal(
    (
      await request('vault/initialize', {
        passphrase: 'fixture-vault-password-123',
      })
    ).status,
    200,
  );
  const migrated = await request('vault/import-legacy', {});
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.removedLegacyFile, true);
  assert.equal(fs.existsSync(filename), false);
  assert.equal(
    app.platform.vault.get(migrated.body.provider.credentialId),
    secret,
  );
  assert.equal(
    app.platform.providers.select({ requiredTools: true }).secret,
    secret,
  );
  assert.equal(JSON.stringify(migrated.body).includes(secret), false);
  assert.equal(
    JSON.stringify((await request('manage')).body).includes(secret),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8').includes(secret),
    false,
  );
});

test('custom skill details preserve frontmatter and keep previous pinned versions on edit', async (t) => {
  const { app, request } = await fixture(t);
  const content =
    '---\nname: fixture-skill\ndescription: Deterministic fixture\n---\n\nOriginal instructions';
  const created = await request('capabilities', {
    kind: 'skill',
    name: 'Fixture',
    content,
  });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal((await request(`capabilities/${id}`)).body.content, content);
  assert.equal(
    fs.readFileSync(created.body.path + '/SKILL.md', 'utf8'),
    content,
  );
  const edited = await request(
    `capabilities/${id}`,
    { kind: 'skill', name: 'Edited', content: 'Updated instructions' },
    'PUT',
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.history[0].digest, created.body.digest);
  assert.notEqual(edited.body.digest, created.body.digest);
  await request(`capabilities/${id}/rollback`, {});
  const current = app.store.records.get('capabilities', id);
  assert.equal(current.digest, created.body.digest);
  assert.equal(current.enabled, false);
});

test('knowledge changes and deletion retain versioned source snapshots', async (t) => {
  const { request, dataDir } = await fixture(t);
  const original = {
    title: 'Server location',
    content: 'First address',
    scope: 'personal',
    state: 'confirmed',
    source: 'Owner',
  };
  const created = await request('knowledge', original);
  await request(
    `knowledge/${created.body.id}`,
    { ...original, content: 'Updated address' },
    'PUT',
  );
  let history = (await request(`knowledge/${created.body.id}/history`)).body;
  assert.deepEqual(
    history.map((entry) => entry.snapshot.content),
    ['Updated address', 'First address'],
  );
  assert.equal(
    (await request(`knowledge/${created.body.id}`, {}, 'DELETE')).body.ok,
    true,
  );
  assert.equal(
    fs.existsSync(path.join(dataDir, 'knowledge', `${created.body.id}.md`)),
    false,
  );
  history = (await request(`knowledge/${created.body.id}/history`)).body;
  assert.equal(history[0].action, 'deleted');
  assert.equal(history[0].snapshot.source, 'Owner');
  assert.equal((await request('state')).body.knowledge.length, 0);
});

test('persisted assistant requirements constrain provider selection after editing', async t => {
  const { app, request } = await fixture(t);
  const small = await request('providers', { name: 'Small', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'small', tools: true, vision: false, contextWindow: 1024 }] });
  const large = await request('providers', { name: 'Large vision', protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'large', tools: true, vision: true, contextWindow: 16000 }] });
  const role = await request('roles', { name: 'Image reviewer', instructions: 'Review the supplied evidence', providerIds: [small.body.id, large.body.id], requiredContextWindow: 8000, requiresVision: true });
  assert.equal(role.status, 201);
  await request(`roles/${role.body.id}`, { name: 'Renamed reviewer' }, 'PUT');
  const saved = app.store.role(role.body.id);
  assert.equal(saved.requiresVision, true);
  assert.equal(saved.requiredContextWindow, 8000);
  assert.equal(app.platform.providers.select(saved).providerId, large.body.id);
});

test('manual monitor checks keep disabled rules disabled and record history', async (t) => {
  const { request, url } = await fixture(t);
  const created = await request('monitors', {
    name: 'Local fixture',
    kind: 'http',
    url: `${url}/api/health`,
    enabled: false,
  });
  const checked = await request(`monitors/${created.body.id}/check`, {});
  assert.equal(checked.status, 200);
  assert.equal(checked.body.enabled, false);
  assert.equal(checked.body.lastResult.ok, true);
  assert.equal(checked.body.manualCheck, false);
  assert.equal(
    (await request(`monitors/${created.body.id}`)).body.runs.length,
    1,
  );
});

test('resource and credential probes validate project paths and tcp connection', async (t) => {
  const { request, workspace } = await fixture(t);
  
  // 1. 测试项目目录探测
  const projectProbe = await request('resources/probe', {
    kind: 'project',
    path: workspace,
  });
  assert.equal(projectProbe.status, 200);
  assert.equal(projectProbe.body.ok, true);

  // 2. 测试不存在的目录探测
  const invalidProject = await request('resources/probe', {
    kind: 'project',
    path: path.join(workspace, 'non-existent-dir-12345'),
  });
  assert.equal(invalidProject.status, 200);
  assert.equal(invalidProject.body.ok, false);

  // 3. 测试凭据格式校验（如 SSH 私钥）
  const sshProbe = await request('credentials/probe', {
    kind: 'ssh_key',
    value: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
  });
  assert.equal(sshProbe.status, 200);
  assert.equal(sshProbe.body.ok, true);
});
