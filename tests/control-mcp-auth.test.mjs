import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AuthService } from '../server/auth.mjs';
import { createOrchestrationServer } from '../server/orchestration-mcp.mjs';
import { setup } from './helpers/control-helpers.mjs';

test('owner auth has no public setup endpoint and sessions expire and are revoked on password change', async (t) => {
  const { store, advance } = setup(t);
  let now = 10000;
  const auth = new AuthService({
    store,
    requireAuth: true,
    ownerPassword: 'correct horse battery staple',
    secureCookies: true,
    now: () => now,
  });
  await auth.init();
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.1' } };
  assert.equal(auth.authorize(req).authorized, false);
  assert.equal(
    (
      await auth.handle({
        method: 'POST',
        parts: ['auth', 'setup'],
        body: {},
        req,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await auth.handle({
        method: 'POST',
        parts: ['auth', 'login'],
        body: { password: 'wrong' },
        req,
      })
    ).status,
    401,
  );
  const login = await auth.handle({
    method: 'POST',
    parts: ['auth', 'login'],
    body: { password: 'correct horse battery staple' },
    req,
  });
  assert.equal(login.status, 200);
  assert.match(
    login.headers['Set-Cookie'],
    /HttpOnly; SameSite=Strict.*Secure/,
  );
  const authenticated = {
    ...req,
    headers: { cookie: login.headers['Set-Cookie'].split(';')[0] },
  };
  assert.equal(auth.authorize(authenticated).authorized, true);
  await auth.setPassword('another sufficiently long password');
  assert.equal(auth.authorize(authenticated).authorized, false);
  now += 13 * 60 * 60_000;
  advance(1);
  assert.equal(auth.authorize(authenticated).authorized, false);
});

test('MCP tools derive sender identity from a revocable instance token', async (t) => {
  const { control, store } = setup(t);
  const job = control.createJob({ role: 'assistant', prompt: 'Research' });
  const claim = control.claimLocal(store.task(job.taskId));
  const server = createOrchestrationServer({ control, token: claim.token });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.ok(
    (await client.listTools()).tools.some((tool) => tool.name === 'read_inbox'),
  );
  const response = await client.callTool({
    name: 'save_checkpoint',
    arguments: { title: 'Progress', content: 'Read sources' },
  });
  const checkpoint = JSON.parse(response.content[0].text);
  assert.equal(checkpoint.agentId, 'assistant');
  assert.equal(checkpoint.taskId, job.taskId);
  control.revokeExecution(job.taskId);
  assert.equal(
    (await client.callTool({ name: 'read_inbox', arguments: {} })).isError,
    true,
  );
});

test('MCP can call the optional structured decision backend', async (t) => {
  const { control, store } = setup(t, {
    evaluateDecision: async (input) => ({
      model: input.model || 'jev-latest',
      answers: { urgent: { noul: 0.8, confidence: 0.75 } },
    }),
  });
  const job = control.createJob({ role: 'assistant', prompt: 'Classify' });
  const claim = control.claimLocal(store.task(job.taskId));
  const server = createOrchestrationServer({ control, token: claim.token });
  const client = new Client({ name: 'decision-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const response = await client.callTool({
    name: 'evaluate_decision',
    arguments: {
      state: { goal: 'ship' },
      model: 'jev-latest',
      questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
    },
  });
  assert.equal(JSON.parse(response.content[0].text).answers.urgent.noul, 0.8);
});

test('MCP capability listing is scoped to the running assistant and omits secrets', async (t) => {
  const { control, store } = setup(t);
  store.records.save(
    'capabilities',
    {
      name: 'Private docs',
      kind: 'mcp',
      version: '1.2.3',
      digest: 'sha256-fixture',
      enabled: true,
      tools: ['read_docs'],
      credentialId: 'secret-ref',
      envRefs: { DOCS_TOKEN: 'secret-ref' },
      url: 'https://docs.example.test/mcp',
      health: {
        ok: true,
        checkedAt: '2026-09-20T00:00:00.000Z',
        tools: [{ name: 'read_docs', description: 'Read docs' }],
      },
    },
    'cap-private-docs',
  );
  store.records.save(
    'capabilities',
    {
      name: 'Review plugin',
      kind: 'plugin',
      version: '2.0.0',
      digest: 'sha256-plugin',
      enabled: true,
      source: 'fixture',
      commands: [
        { id: 'review', name: 'review', description: 'Review changes' },
      ],
    },
    'cap-review-plugin',
  );
  store.saveRole(
    {
      name: 'Scoped assistant',
      instructions: 'Inspect docs.',
      skillIds: ['personal-workflow'],
      capabilityIds: ['cap-private-docs'],
    },
    'assistant',
  );
  const job = control.createJob({ role: 'assistant', prompt: 'Inspect docs' });
  const claim = control.claimLocal(store.task(job.taskId));
  const server = createOrchestrationServer({
    control,
    token: claim.token,
    capabilities: {
      components(id) {
        assert.equal(id, 'cap-review-plugin');
        return {
          commands: [
            {
              id: 'command-review',
              name: 'review',
              description: 'Review changes',
              runnable: true,
              userInvocable: true,
            },
          ],
          agents: [],
          mcp: [],
        };
      },
    },
  });
  const client = new Client({ name: 'capability-list-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const response = await client.callTool({
    name: 'list_capabilities',
    arguments: {},
  });
  assert.equal(response.isError, undefined);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result.skills, [
    { id: 'personal-workflow', name: '资料与行动计划', role: 'assistant' },
  ]);
  assert.equal(result.capabilities[0].name, 'Private docs');
  assert.deepEqual(result.capabilities[0].tools, ['read_docs']);
  assert.equal(result.capabilities[0].source, null);
  assert.equal(result.capabilities[0].compatibility, 'compatible');
  assert.equal(result.capabilities[0].risk.level, 'high');
  assert.equal(result.capabilities[0].risk.requiresReview, true);
  assert.ok(
    result.capabilities[0].risk.reasons.some((reason) => /凭据/.test(reason)),
  );
  assert.equal(JSON.stringify(result).includes('credentialId'), false);
  assert.equal(JSON.stringify(result).includes('secret-ref'), false);
  assert.equal(JSON.stringify(result).includes('docs.example.test'), false);
  const catalog = JSON.parse(
    (await client.callTool({ name: 'list_capability_catalog', arguments: {} }))
      .content[0].text,
  );
  const plugin = catalog.capabilities.find(
    (item) => item.id === 'cap-review-plugin',
  );
  assert.deepEqual(plugin.components.commands, [
    {
      id: 'command-review',
      name: 'review',
      description: 'Review changes',
      runnable: true,
      userInvocable: true,
      diagnostics: [],
    },
  ]);
});

test('MCP capability commands require a bound plugin and enqueue a controlled child task', async (t) => {
  const { control, store } = setup(t);
  store.saveRole(
    { ...store.role('assistant'), capabilityIds: ['cap-plugin'] },
    'assistant',
  );
  const parent = control.createJob({
    role: 'assistant',
    prompt: 'Run the approved command',
  });
  const claim = control.claimLocal(store.task(parent.taskId));
  let received;
  control.createTask = (input) => {
    received = input;
    return store.createTask(input);
  };
  const capabilities = {
    commandTask(capabilityId, commandId, input) {
      assert.equal(capabilityId, 'cap-plugin');
      assert.equal(commandId, 'summarize');
      assert.equal(input.arguments, 'docs');
      return {
        role: input.role,
        prompt: 'Summarize docs',
        nodeId: input.nodeId,
        workspaceKey: input.workspaceKey,
        workspaceMode: input.workspaceMode,
        assistantSnapshot: {
          ...store.role(input.role),
          capabilityIds: ['cap-plugin'],
        },
        contextExtra: 'plugin command context',
        capabilityCommand: {
          capabilityId,
          commandId,
          digest: 'sha256-fixture',
        },
      };
    },
  };
  const server = createOrchestrationServer({
    control,
    token: claim.token,
    capabilities,
  });
  const client = new Client({ name: 'capability-command-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const response = await client.callTool({
    name: 'run_capability_command',
    arguments: {
      capabilityId: 'cap-plugin',
      commandId: 'summarize',
      arguments: 'docs',
    },
  });
  assert.equal(response.isError, undefined);
  const child = JSON.parse(response.content[0].text);
  assert.equal(child.parentJobId, parent.id);
  assert.equal(child.role, 'assistant');
  assert.equal(received.capabilityCommand.commandId, 'summarize');
  assert.equal(received.contextExtra, 'plugin command context');
  const denied = await client.callTool({
    name: 'run_capability_command',
    arguments: {
      capabilityId: 'cap-other',
      commandId: 'summarize',
      arguments: 'docs',
    },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /未绑定/);
});
