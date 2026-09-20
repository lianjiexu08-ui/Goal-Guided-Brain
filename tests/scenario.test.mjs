import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWorkbench } from '../server/index.mjs';
import { command } from '../server/workspaces.mjs';

async function until(predicate, description) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Scenario did not reach ${description}`);
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(
    result.isError,
    true,
    `${name}: ${JSON.stringify(result.content)}`,
  );
  return JSON.parse(result.content[0].text);
}

test(
  'parent delegates isolated frontend/backend work, resumes another model and reviews a tested integration',
  { timeout: 30000 },
  async (t) => {
    const env = {
      WORKBENCH_PUBLIC_URL: undefined,
      WORKBENCH_REQUIRE_AUTH: undefined,
      WORKBENCH_BIND_HOST: undefined,
      WORKBENCH_OWNER_PASSWORD: undefined,
      WORKBENCH_VAULT_PASSWORD: undefined,
      DEEPSEEK_API_KEY: 'scenario-fixture-key',
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scenario-'));
    const source = path.join(directory, 'source');
    const skillSource = path.join(directory, 'skill');
    fs.mkdirSync(source);
    fs.mkdirSync(skillSource);
    const clients = [],
      upstreamSessions = new Set(),
      runs = new Map();
    let app = null,
      upstream = null;
    t.after(async () => {
      for (const client of clients) await client.close();
      await app?.close();
      for (const session of upstreamSessions) await session.close();
      if (upstream?.listening) {
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
      }
      fs.rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    fs.writeFileSync(
      path.join(source, 'acceptance.test.mjs'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { getStatus } from "./backend.mjs";',
        'import { renderStatus } from "./frontend.mjs";',
        'test("frontend renders the backend contract", () => {',
        '  assert.equal(renderStatus(getStatus()), "<p>Status: ready</p>");',
        '});',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(skillSource, 'SKILL.md'),
      '---\nname: contract-review\ndescription: Validate the frontend/backend contract.\n---\nVerify renderStatus(getStatus()) and include the actual test output in delivery evidence.\n',
    );
    await command('git', ['init', '--initial-branch=main'], { cwd: source });
    for (const [key, value] of Object.entries({
      'user.name': 'Scenario',
      'user.email': 'scenario@localhost',
      'commit.gpgsign': 'false',
      'core.hooksPath': '/dev/null',
    }))
      await command('git', ['config', key, value], { cwd: source });
    await command('git', ['add', '--all'], { cwd: source });
    await command('git', ['commit', '-m', 'Define acceptance contract'], {
      cwd: source,
    });
    const baseCommit = (
      await command('git', ['rev-parse', 'HEAD'], { cwd: source })
    ).trim();

    let contractReads = 0;
    upstream = http.createServer(async (req, res) => {
      const server = new McpServer({
        name: 'scenario-contract',
        version: '1.0.0',
      });
      upstreamSessions.add(server);
      server.registerTool(
        'get_contract',
        { inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          contractReads += 1;
          return {
            content: [
              { type: 'text', text: JSON.stringify({ status: 'ready' }) },
            ],
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once('close', () => {
        upstreamSessions.delete(server);
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    app = createWorkbench({
      dataDir: path.join(directory, 'control'),
      workspace: source,
      requireCredential: false,
      runtimeFactory: (options) => ({
        options,
        start(prompt) {
          this.prompt = prompt;
          runs.set(options.task.id, this);
        },
        complete(result) {
          options.onResult(result);
          options.onDone('completed', '');
        },
        cancel() {
          options.onDone('cancelled', '');
        },
      }),
    });
    await app.platform.ready;
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (route, body, method = 'POST') => {
      const response = await fetch(`${baseUrl}/api/${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.ok(
        response.ok,
        `${route}: ${response.status} ${JSON.stringify(result)}`,
      );
      return result;
    };
    const connect = async (run, id = 'workbench-orchestration') => {
      const patch = run.options.capabilityPatch.find((item) => item.id === id);
      assert.ok(patch, `Missing runtime MCP ${id}`);
      const client = new Client({ name: 'scenario-agent', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(patch.config.url), {
          requestInit: { headers: patch.config.headers },
        }),
      );
      return client;
    };

    const primary = await request('providers', {
      name: 'Planning model',
      protocol: 'openai-responses',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'planning-fixture', tools: true }],
      priority: 1,
    });
    const alternate = await request('providers', {
      name: 'Implementation model',
      protocol: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'implementation-fixture', tools: true }],
      priority: 2,
    });
    const skill = await request('capabilities/install', { path: skillSource });
    await request(`capabilities/${skill.id}/enable`, {});
    const mcp = await request('capabilities', {
      name: 'Contract fixture',
      kind: 'mcp',
      enabled: true,
      transport: 'streamable-http',
      url: `http://127.0.0.1:${upstream.address().port}/mcp`,
      tools: ['get_contract'],
    });
    const roles = Object.fromEntries(
      ['coordinator', 'frontend', 'backend'].map((name) => [
        name,
        app.store.saveRole({
          name,
          instructions: `Complete ${name} work and hand over evidence.`,
          workspaceMode: 'isolated',
          tools: { files: true, terminal: true, web: false },
          capabilityIds: [skill.id, mcp.id],
          providerIds: [primary.id],
        }),
      ]),
    );
    const parent = await request('jobs', {
      role: roles.coordinator.id,
      prompt: 'Deliver the status feature with reviewed frontend and backend.',
      acceptance: 'The integrated acceptance test passes.',
      budgetTokens: 10000,
      workspaceMode: 'isolated',
    });
    const parentRun = await until(
      () => runs.get(parent.taskId),
      'parent start',
    );
    const parentMcp = await connect(parentRun);
    const capabilities = await call(parentMcp, 'list_capabilities');
    assert.ok(capabilities.capabilities.some((item) => item.id === skill.id && item.kind === 'skill'));
    assert.deepEqual(
      capabilities.capabilities.find((item) => item.id === mcp.id).tools,
      ['get_contract'],
    );
    assert.doesNotMatch(JSON.stringify(capabilities), /credentialId|envRefs|url|"command"\s*:/);
    const frontend = await call(parentMcp, 'delegate_task', {
      role: roles.frontend.id,
      prompt: 'Implement renderStatus with checkpointed handoff.',
    });
    const backend = await call(parentMcp, 'delegate_task', {
      role: roles.backend.id,
      prompt: 'Implement getStatus from the MCP contract.',
    });
    const frontRun = await until(
      () => runs.get(frontend.taskId),
      'frontend start',
    );
    const backRun = await until(
      () => runs.get(backend.taskId),
      'backend start',
    );
    const frontMcp = await connect(frontRun),
      backMcp = await connect(backRun);
    const directories = [parentRun, frontRun, backRun].map(
      (run) => run.options.task.workspace,
    );
    assert.equal(new Set(directories).size, 3);
    assert.ok(directories.every((directory) => directory !== source));
    for (const job of [parent, frontend, backend]) {
      const workspace = app.store.records.get('workspaces', job.taskId);
      assert.equal(workspace.kind, 'worktree');
      assert.equal(workspace.baseCommit, baseCommit);
      assert.equal(job.groupId, parent.groupId);
    }
    const snapshot = app.store.records.get(
      'runtime-snapshots',
      frontend.taskId,
    );
    assert.equal(
      snapshot.capabilities.find((item) => item.id === skill.id).digest,
      skill.digest,
    );
    assert.match(
      fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8'),
      /renderStatus\(getStatus\(\)\)/,
    );
    const board = await call(parentMcp, 'update_board', {
      title: 'Delivery contract',
      content: 'Frontend and backend use the same status object.',
    });

    const question = {
      toTaskId: backend.taskId,
      toAgentId: roles.backend.id,
      kind: 'question',
      content: 'Confirm the status contract.',
      idempotencyKey: 'status-contract-question',
    };
    const sent = await call(frontMcp, 'send_message', question);
    assert.equal((await call(frontMcp, 'send_message', question)).id, sent.id);
    assert.equal((await call(backMcp, 'read_inbox')).items.length, 1);
    await call(backMcp, 'ack_message', { id: sent.id, status: 'processed' });
    const contractMcp = await connect(backRun, `cap-${mcp.id}`);
    const contract = await call(contractMcp, 'get_contract');
    assert.equal(contractReads, 1);
    const reply = await call(backMcp, 'send_message', {
      toTaskId: frontend.taskId,
      kind: 'reply',
      content: JSON.stringify(contract),
      replyTo: sent.id,
      idempotencyKey: 'status-contract-reply',
    });
    const inbox = await call(frontMcp, 'read_inbox');
    assert.equal(inbox.items[0].fromAgentId, roles.backend.id);
    assert.deepEqual(JSON.parse(inbox.items[0].content), { status: 'ready' });
    await call(frontMcp, 'ack_message', { id: reply.id, status: 'processed' });

    const draftPath = path.join(
      frontRun.options.task.workspace,
      'frontend.mjs',
    );
    fs.writeFileSync(draftPath, 'export const label = "Status";\n');
    const draft = await call(frontMcp, 'submit_artifact', {
      title: 'Frontend draft',
      location: draftPath,
      evidence: 'Label defined; rendering still pending.',
    });
    const checkpoint = await call(frontMcp, 'save_checkpoint', {
      title: 'Frontend handoff',
      content: `Resume from ${draftPath}; contract is ${JSON.stringify(contract)}.`,
      artifacts: [draft.id],
      constraints: ['Preserve the source repository.'],
      decisions: ['Render the shared status property.'],
      nextSteps: ['Finish renderStatus and run acceptance.'],
    });
    const paused = await request(`jobs/${frontend.id}/pause`, {});
    assert.equal(paused.status, 'paused');
    await assert.rejects(frontMcp.listTools(), /401|Unauthorized|撤销|过期/);
    const resumed = await request(`jobs/${frontend.id}/resume`, {
      providerIds: [alternate.id],
    });
    const resumedRun = await until(
      () => runs.get(resumed.taskId),
      'resumed frontend',
    );
    const resumedMcp = await connect(resumedRun);
    assert.notEqual(resumed.taskId, frontend.taskId);
    assert.equal(resumedRun.options.task.role, frontRun.options.task.role);
    assert.notEqual(
      resumedRun.options.task.workspace,
      frontRun.options.task.workspace,
    );
    assert.notEqual(
      app.store.records.get('task-meta', resumed.taskId).batchId,
      app.store.records.get('task-meta', frontend.taskId).batchId,
    );
    assert.equal(resumedRun.options.route.providerId, alternate.id);
    assert.equal(resumedRun.options.route.protocol, 'anthropic-messages');
    assert.match(resumedRun.prompt, new RegExp(checkpoint.id));
    assert.ok(resumedRun.prompt.includes(draftPath));
    const finalFrontPath = path.join(
      resumedRun.options.task.workspace,
      'frontend.mjs',
    );
    fs.writeFileSync(
      finalFrontPath,
      fs.readFileSync(draftPath, 'utf8') +
        'export function renderStatus(value) { return `<p>${label}: ${value.status}</p>`; }\n',
    );
    const finalBackPath = path.join(
      backRun.options.task.workspace,
      'backend.mjs',
    );
    fs.writeFileSync(
      finalBackPath,
      `export function getStatus() { return ${JSON.stringify(contract)}; }\n`,
    );
    assert.equal(
      fs.existsSync(path.join(backRun.options.task.workspace, 'frontend.mjs')),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(resumedRun.options.task.workspace, 'backend.mjs'),
      ),
      false,
    );

    for (const [job, run, client, location, result] of [
      [
        resumed,
        resumedRun,
        resumedMcp,
        finalFrontPath,
        'Frontend completed from its checkpoint on the replacement model.',
      ],
      [
        backend,
        backRun,
        backMcp,
        finalBackPath,
        'Backend completed against the read-only MCP contract.',
      ],
    ]) {
      const commit = await request(`workspaces/${job.taskId}/commit`, {
        message: result,
      });
      const artifact = await call(client, 'submit_artifact', {
        title: result,
        location,
        commit: commit.commit,
        evidence: 'Committed isolated implementation; integrated test pending.',
      });
      await call(client, 'save_checkpoint', {
        title: 'Ready for review',
        content: result,
        artifacts: [artifact.id],
        decisions: ['Use status=ready contract'],
        nextSteps: ['Integrate both commits and run acceptance.'],
      });
      await call(client, 'send_message', {
        toTaskId: parent.taskId,
        kind: 'handoff',
        content: `${result} Artifact ${artifact.id}`,
        idempotencyKey: `handoff-${job.id}`,
      });
      run.complete(result);
    }
    const handoffs = await call(parentMcp, 'read_inbox');
    assert.equal(
      handoffs.items.filter((item) => item.kind === 'handoff').length,
      2,
    );
    for (const message of handoffs.items)
      await call(parentMcp, 'ack_message', {
        id: message.id,
        status: 'processed',
      });
    parentRun.complete(
      'Delegation finished; both implementations need integrated review.',
    );
    const summaryRun = await until(() => {
      const job = app.store.records.get('jobs', parent.id);
      return job.summaryTaskId && runs.get(job.summaryTaskId);
    }, 'review summary');
    const summaryMcp = await connect(summaryRun);
    assert.ok(
      summaryRun.prompt.includes('Frontend completed from its checkpoint'),
    );
    assert.ok(
      summaryRun.prompt.includes(
        'Backend completed against the read-only MCP contract',
      ),
    );
    assert.ok(summaryRun.prompt.includes(checkpoint.id));
    assert.equal(
      (
        await summaryMcp.callTool({
          name: 'delegate_task',
          arguments: {
            role: roles.frontend.id,
            prompt: 'Duplicate implementation',
          },
        })
      ).isError,
      true,
    );

    const integration = await request('workspaces/integrate', {
      taskIds: [resumed.taskId, backend.taskId],
    });
    assert.equal(integration.state, 'ready');
    assert.equal(integration.verified, false);
    const evidence = await command(
      process.execPath,
      ['--test', 'acceptance.test.mjs'],
      { cwd: integration.path },
    );
    assert.match(evidence, /pass 1/);
    assert.match(evidence, /fail 0/);
    const delivery = await call(summaryMcp, 'submit_artifact', {
      title: 'Reviewed status feature',
      location: integration.path,
      evidence,
      commit: (
        await command('git', ['rev-parse', 'HEAD'], { cwd: integration.path })
      ).trim(),
    });
    await call(summaryMcp, 'update_board', {
      id: board.id,
      expectedRevision: board.revision,
      title: 'Delivery contract',
      content: `Reviewed both commits; acceptance passed. Evidence artifact ${delivery.id}.`,
    });
    summaryRun.complete(
      'Delivered the reviewed status feature; integrated acceptance passed (1/1).',
    );
    await until(
      () => app.store.records.get('jobs', parent.id).status === 'completed',
      'final delivery',
    );
    const delivered = await request(`jobs/${parent.id}`, undefined, 'GET');
    assert.equal(delivered.children.length, 2);
    assert.ok(
      delivered.children.every((child) => child.status === 'completed'),
    );
    assert.ok(
      delivered.artifacts.some(
        (artifact) =>
          artifact.id === delivery.id && artifact.evidence.includes('pass 1'),
      ),
    );
    assert.equal(runs.size, 5);
    assert.equal(
      (await command('git', ['rev-parse', 'HEAD'], { cwd: source })).trim(),
      baseCommit,
    );
    assert.equal(
      await command('git', ['status', '--porcelain'], { cwd: source }),
      '',
    );
    assert.equal(fs.existsSync(path.join(source, 'frontend.mjs')), false);
    assert.equal(fs.existsSync(path.join(source, 'backend.mjs')), false);
  },
);
