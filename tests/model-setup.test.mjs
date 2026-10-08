import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectModelSetup } from '../server/model-setup.mjs';
import { createWorkbench } from '../server/index.mjs';
const provider = (id, extra = {}) => ({
  id,
  name: id,
  enabled: true,
  protocol: 'openai-completions',
  models: [{ id: 'test-model', tools: true }],
  ...extra,
});
const vault = (initialized = false, unlocked = false, entries = []) => ({
  status: () => ({ initialized, unlocked }),
  list: () => entries,
  get: () => {
    throw Error('Readiness must not read secrets');
  },
});

void test('model setup distinguishes absent, disabled, structured-only, empty and unsupported configurations without requiring optional capabilities', () => {
  for (const [providers, expected] of [
    [[], 'missing'],
    [[provider('disabled', { enabled: false })], 'disabled'],
    [
      [provider('optional', { protocol: 'typesafe-system-one' })],
      'decision-only',
    ],
    [[provider('empty', { models: [] })], 'empty-models'],
    [[provider('unknown', { protocol: 'invalid-protocol' })], 'unsupported'],
    [[provider('local')], 'configured'],
  ])
    assert.equal(
      inspectModelSetup({ providers, vault: vault() }).summary.state,
      expected,
    );
  assert.equal(
    inspectModelSetup({ providers: [], vault: vault(), legacyAvailable: true })
      .summary.state,
    'legacy',
  );
  assert.equal(
    inspectModelSetup({
      providers: [provider('disabled', { enabled: false })],
      vault: vault(),
      legacyAvailable: true,
    }).summary.state,
    'disabled',
  );
});

void test('credential readiness uses metadata only, handles vault lifecycle and keeps selected-provider evidence separate from alternatives', () => {
  const providers = [
    provider('secure', { credentialId: 'secret-id' }),
    provider('public'),
  ];
  for (const [v, expected] of [
    [vault(), 'missing-vault'],
    [vault(true), 'locked'],
    [vault(true, true), 'missing'],
    [vault(true, true, [{ id: 'secret-id', name: 'Metadata' }]), 'ready'],
  ]) {
    const result = inspectModelSetup({ providers, vault: v });
    assert.equal(result.credentialStates.secure, expected);
    assert.equal(result.credentialStates.public, 'not-required');
    assert.equal(result.summary.state, 'configured');
    assert.equal(result.summary.readyProviders, expected === 'ready' ? 2 : 1);
    assert.equal(JSON.stringify(result).includes('secret-id'), false);
  }
  assert.equal(
    inspectModelSetup({ providers: [providers[0]], vault: vault(true) }).summary
      .state,
    'credentials',
  );
});

void test('real state API tracks vault lock/unlock/deletion without returning secrets or claiming a network probe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-model-setup-'));
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { vault: secrets, providers } = app.platform;
  await secrets.initialize('fixture-passphrase');
  const credential = await secrets.put({
    name: 'Fixture credential',
    value: 'not-a-real-model-secret',
  });
  const saved = providers.save({
    name: 'First model',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    credentialId: credential.id,
    models: [{ id: 'fixture-model', tools: true, contextWindow: 8192 }],
  });
  const state = async () => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/state`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      JSON.stringify(body).includes('not-a-real-model-secret'),
      false,
    );
    assert.equal(JSON.stringify(body).includes(credential.id), false);
    assert.equal(
      body.providers.find((row) => row.id === saved.id).health,
      null,
    );
    return body;
  };
  assert.equal((await state()).config.modelSetup.state, 'configured');
  secrets.lock();
  let data = await state();
  assert.equal(data.config.hasApiKey, true);
  assert.equal(data.config.modelSetup.state, 'credentials');
  assert.equal(data.providers[0].credentialState, 'locked');
  await secrets.unlock('fixture-passphrase');
  assert.equal((await state()).config.modelSetup.state, 'configured');
  secrets.remove(credential.id);
  data = await state();
  assert.equal(data.config.modelSetup.state, 'credentials');
  assert.equal(data.providers[0].credentialState, 'missing');
  assert.equal(app.store.tasks().length, 0);
});
