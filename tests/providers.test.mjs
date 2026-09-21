import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../server/vault.mjs';
import { ProviderService } from '../server/providers.mjs';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import {
  childEnvironment,
  runtimePatch,
  secureRuntimePatch,
} from '../server/runtime.mjs';
import { stringify } from 'yaml';
import { validateRole } from '../server/roles.mjs';
import { ROLES } from '../server/store.mjs';

test('vault encrypts credentials and restores with correct passphrase only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vault-'));
  const vault = new Vault(dir);
  try {
    await vault.initialize('fixture-passphrase');
    const entry = await vault.put({
      name: 'test credential',
      value: 'credential-value-never-in-plaintext',
    });
    assert.equal(vault.get(entry.id), 'credential-value-never-in-plaintext');
    assert.ok(!JSON.stringify(vault.list()).includes('credential-value'));
    assert.ok(
      !fs.readFileSync(vault.file, 'utf8').includes('credential-value'),
    );
    assert.equal(fs.statSync(vault.file).mode & 0o777, 0o600);
    vault.lock();
    assert.throws(() => vault.get(entry.id), /解锁/);
    assert.deepEqual(vault.list(), []);
    await assert.rejects(vault.unlock('wrong-passphrase'), /无法解锁/);
    await vault.unlock('fixture-passphrase');
    await vault.put({ name: 'updated', value: 'replacement' }, entry.id);
    const restored = new Vault(dir);
    await restored.unlock('fixture-passphrase');
    assert.equal(restored.get(entry.id), 'replacement');
    restored.remove(entry.id);
    restored.lock();
    await restored.unlock('fixture-passphrase');
    assert.deepEqual(restored.list(), []);
    restored.lock();
  } finally {
    vault.lock();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider probes speak three protocols, retry transient failures and disable rejected credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provider-'));
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const vault = new Vault(dir);
  const requests = [];
  let nextStatuses = [];
  let toolAnswer = true;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, headers: req.headers, body });
    const status = nextStatuses.shift() ?? 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (status !== 200)
      return res.end(JSON.stringify({ error: 'secret-must-not-be-echoed' }));
    const tool = body.tools && toolAnswer;
    res.end(
      JSON.stringify(
        req.url.endsWith('/responses')
          ? {
              output: tool
                ? [
                    {
                      type: 'function_call',
                      name: 'connection_check',
                      arguments: '{"ok":true}',
                    },
                  ]
                : [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: 'OK' }],
                    },
                  ],
            }
          : req.url.endsWith('/messages')
            ? {
                content: tool
                  ? [
                      {
                        type: 'tool_use',
                        name: 'connection_check',
                        input: { ok: true },
                      },
                    ]
                  : [{ type: 'text', text: 'OK' }],
              }
            : {
                choices: [
                  {
                    message: tool
                      ? {
                          tool_calls: [
                            {
                              function: {
                                name: 'connection_check',
                                arguments: '{"ok":true}',
                              },
                            },
                          ],
                        }
                      : { content: 'OK' },
                  },
                ],
              },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await vault.initialize('fixture-passphrase');
    const credential = await vault.put({
      name: 'provider',
      value: 'fixture-api-secret',
    });
    const service = new ProviderService({
      store: { records: new Records(db) },
      vault,
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const saved = [];
    for (const protocol of [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]) {
      const provider = service.save({
        name: protocol,
        protocol,
        baseUrl,
        credentialId: credential.id,
        models: [{ id: 'fixture-model', tools: true }],
      });
      saved.push(provider);
      assert.equal((await service.probe(provider.id)).ok, true);
      assert.equal(
        (await service.probe(provider.id, { toolTest: true })).tools,
        true,
      );
      const call = requests.at(-1);
      assert.equal(
        protocol === 'anthropic-messages'
          ? call.headers['x-api-key']
          : call.headers.authorization,
        protocol === 'anthropic-messages'
          ? 'fixture-api-secret'
          : 'Bearer fixture-api-secret',
      );
    }
    nextStatuses = [429, 503, 200];
    const beforeRetry = requests.length;
    assert.equal((await service.probe(saved[0].id)).ok, true);
    assert.equal(requests.length - beforeRetry, 3);
    toolAnswer = false;
    assert.equal(
      (await service.probe(saved[0].id, { toolTest: true })).ok,
      false,
    );
    assert.equal((await service.probe(saved[0].id)).ok, true);
    nextStatuses = [401];
    const rejected = await service.probe(saved[0].id);
    assert.equal(rejected.status, 401);
    assert.equal(
      service.list().find((item) => item.id === saved[0].id).enabled,
      false,
    );
    const route = service.select({
      model: 'fixture-model',
      providerIds: saved.map((item) => item.id),
      tools: { files: true },
    });
    assert.equal(route.providerId, saved[1].id);
    assert.equal(route.secret, 'fixture-api-secret');
    assert.equal(
      service.select(
        { providerIds: saved.map((item) => item.id) },
        { exclude: [saved[1].id] },
      ).providerId,
      saved[2].id,
    );
    assert.ok(!JSON.stringify(service.list()).includes('fixture-api-secret'));
    assert.throws(
      () =>
        service.save(
          { ...saved[0], baseUrl: 'https://key:secret@example.com' },
          saved[0].id,
        ),
      /地址/,
    );
    vault.lock();
    assert.throws(() => service.select({}), /解锁/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    vault.lock();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TypeSafe decision provider stays out of text routing and returns typed decisions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-typesafe-'));
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const vault = new Vault(dir);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-latest', answers: { urgent: { noul: 0.91, confidence: 0.88 } }, usage: { input_tokens: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); vault.lock(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await vault.initialize('fixture-passphrase');
  const credential = await vault.put({ name: 'typesafe', value: 'typesafe-secret' });
  const service = new ProviderService({ store: { records: new Records(db) }, vault });
  const provider = service.save({ name: 'TypeSafe', protocol: 'typesafe-system-one', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialId: credential.id, models: [{ id: 'jev-latest' }] });
  const chat = service.save({ name: 'Chat', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'chat' }] });
  assert.equal(service.select({ providerIds: [provider.id, chat.id], model: 'chat' }).providerId, chat.id);
  const result = await service.evaluateDecision({ providerId: provider.id, state: { goal: 'ship feature' }, questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } } });
  assert.equal(result.answers.urgent.noul, 0.91);
  assert.equal(result.route.protocol, 'typesafe-system-one');
  assert.equal(requests[0].url, '/v1/systemone');
  assert.equal(requests[0].auth, 'Bearer typesafe-secret');
  assert.deepEqual(requests[0].body.state, { goal: 'ship feature' });
  assert.equal((await service.probe(provider.id)).structured, true);
  await assert.rejects(service.probe(provider.id, { toolTest: true }), /结构化决策/);
});

test('provider model sync uses the remote catalog and removes unsupported modalities', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provider-sync-'));
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const vault = new Vault(dir);
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'gpt-5.4', supported_endpoint_types: ['openai'] },
      { id: 'gpt-5.6', supported_endpoint_types: ['openai'] },
      { id: 'gpt-4o-audio-preview', supported_endpoint_types: ['openai'] },
      { id: 'gpt-image-1', supported_endpoint_types: ['openai'] },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); vault.lock(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await vault.initialize('fixture-passphrase');
  const credential = await vault.put({ name: 'sync', value: 'sync-secret' });
  const service = new ProviderService({ store: { records: new Records(db) }, vault });
  const provider = service.save({
    name: 'Sync fixture',
    protocol: 'openai-completions',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    credentialId: credential.id,
    models: [{ id: 'gpt-5.6', name: 'GPT 5.6', tools: true, contextWindow: 200000 }, { id: 'old-model' }],
  });
  const synced = await service.syncModels(provider.id);
  assert.deepEqual(synced.provider.models.map((model) => model.id), ['gpt-5.4', 'gpt-5.6']);
  assert.equal(synced.provider.models.find((model) => model.id === 'gpt-5.6').tools, true);
  assert.deepEqual(synced.removed, ['old-model']);
  assert.equal(synced.provider.credentialId, credential.id);
});

test('runtime isolates environment and merges installed skill directories', () => {
  process.env.WORKBENCH_TEST_RELEASE_TOKEN = 'do-not-inherit';
  try {
    assert.equal(childEnvironment().WORKBENCH_TEST_RELEASE_TOKEN, undefined);
  } finally {
    delete process.env.WORKBENCH_TEST_RELEASE_TOKEN;
  }
  const role = validateRole({
    ...ROLES.developer,
    providerIds: ['p1', 'p1'],
    capabilityIds: ['c1'],
    nodeId: 'node-1',
  });
  assert.deepEqual(role.providerIds, ['p1']);
  const patch = runtimePatch(
    role,
    '/custom',
    {
      providerName: 'fixture',
      protocol: 'openai-responses',
      baseUrl: 'https://example.com/v1',
      model: 'model',
      secret: 'never-serialized',
    },
    [{ id: 'skill-filesystem', config: { customSkillDirs: ['/installed'] } }],
  );
  const dirs = patch.find((item) => item.id === 'skill-filesystem').config
    .customSkillDirs;
  assert.ok(dirs.includes('/custom') && dirs.includes('/installed'));
  assert.ok(!JSON.stringify(patch).includes('never-serialized'));
  const secured = secureRuntimePatch(
    runtimePatch(role, null, null, [
      {
        id: 'mcp-fixture',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          headers: { Authorization: 'Bearer mcp-secret-value' },
          env: { SERVICE_KEY: 'service-secret-value' },
        },
      },
    ]),
  );
  const yaml = stringify(secured.patch);
  assert.match(yaml, /insert:/);
  assert.match(yaml, /!!js process.env.DSH_RUN_SECRET_0/);
  assert.ok(
    !yaml.includes('mcp-secret-value') &&
      !yaml.includes('service-secret-value'),
  );
  assert.equal(secured.env.DSH_RUN_SECRET_0, 'Bearer mcp-secret-value');
  assert.ok(secured.secrets.includes('mcp-secret-value'));
});
