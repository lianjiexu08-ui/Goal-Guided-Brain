import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test('team space routes owner messages to the project manager and persists replies', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => {
      const run = {
        options,
        start(prompt) {
          run.prompt = prompt;
          runs.push(run);
        },
        cancel() {
          options.onDone('cancelled', '');
        },
        complete(result = '项目经理已完成汇总') {
          options.onResult(result);
          options.onDone('completed', '');
        },
      };
      return run;
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const spaces = await request('spaces');
    assert.equal(spaces.status, 200);
    assert.equal(spaces.body.length, 1);
    assert.equal(spaces.body[0].pmRoleId, 'project_manager');
    const message = await request(`spaces/${spaces.body[0].id}/messages`, {
      clientMessageId: 'first-request',
      content: '评估新产品方向，并安排团队给出开发计划。',
    }, 'POST');
    assert.equal(message.status, 201);
    assert.ok(message.body.taskId);
    assert.ok(message.body.sessionId);
    await tick();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.assistant.id, 'project_manager');
    assert.match(runs[0].prompt, /评估新产品方向/);
    runs[0].complete();
    await tick();
    const detail = await request(`spaces/${spaces.body[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.messages.some((item) => item.kind === 'request'));
    assert.ok(detail.body.messages.some((item) => item.kind === 'reply' && /完成汇总/.test(item.content)));
    assert.ok(detail.body.tasks.some((item) => item.role === 'project_manager'));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('multiple Chat teams keep independent ownership and can hand work to another team', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => {
      const run = {
        options,
        start(prompt) { run.prompt = prompt; runs.push(run); },
        cancel() { options.onDone('cancelled', ''); },
      };
      return run;
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const existing = await request('teams');
    const source = existing.body[0];
    const created = await request('teams', {
      name: '运维团队',
      goal: '长期维护线上项目和发布稳定性。',
      purpose: '负责监控、故障处理和发布保障。',
      teamType: 'operations',
      memberRoleIds: ['project_manager', 'assistant'],
      collaboration: { allowedTeamIds: [source.id], autoHandoff: true },
    }, 'POST');
    assert.equal(created.status, 201);
    assert.equal(created.body.teamType, 'operations');
    assert.equal(created.body.chatId, created.body.id);
    const teams = await request('teams');
    assert.equal(teams.body.length, 2);
    const collaborators = await request(`teams/${source.id}/collaborators`);
    assert.equal(collaborators.status, 200);
    assert.ok(collaborators.body.some((item) => item.id === created.body.id));

    const waiting = await request('teams', {
      name: '待确认团队',
      goal: '尚未完成招募的团队。',
      recruitment: { phase: 'discovery' },
    }, 'POST');
    const blocked = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: waiting.body.id,
      clientMessageId: 'waiting-1',
      content: '请在确认前接收这条请求。',
    }, 'POST');
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /尚未完成招募/);

    const delegated = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: created.body.id,
      clientMessageId: 'ops-1',
      content: '请建立本项目的发布检查和运行监控清单。',
    }, 'POST');
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.sourceTeamId, source.id);
    assert.equal(delegated.body.targetTeamId, created.body.id);
    assert.ok(delegated.body.taskId);
    await tick();
    assert.equal(runs.length, 1);
    assert.match(runs[0].prompt, /运行监控清单/);
    const detail = await request(`teams/${created.body.id}`);
    assert.equal(detail.body.messages[0].fromTeamId, source.id);
    assert.equal(detail.body.tasks[0].teamId, created.body.id);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team MCP can discover and delegate to an allowed long-lived team', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '目标团队已完成协作') { options.onResult(result); options.onDone('completed', ''); },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const clients = [];
  try {
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '资料团队',
      goal: '整理资料并输出证据摘要。',
      memberRoleIds: ['project_manager', 'assistant'],
      model: 'team-default-model',
      memberSettings: { project_manager: { modelHint: 'pm-routing-model' } },
    }, 'POST')).body;
    const pending = (await request('teams', {
      name: '待招募资料团队',
      goal: '尚未确认成员的资料团队。',
      memberRoleIds: ['project_manager', 'assistant'],
      recruitment: { phase: 'discovery' },
    }, 'POST')).body;
    await request(`teams/${source.id}`, { collaboration: { allowedTeamIds: [target.id, pending.id] } }, 'PUT');
    await request(`teams/${source.id}/messages`, { clientMessageId: 'mcp-source', content: '准备一次跨团队资料协作。' }, 'POST');
    await tick();
    assert.equal(runs.length, 1);
    const patch = runs[0].options.capabilityPatch.find((item) => item.id === 'workbench-orchestration');
    const client = new Client({ name: 'team-mcp-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(patch.config.url), { requestInit: { headers: patch.config.headers } }));
    const listed = JSON.parse((await client.callTool({ name: 'list_teams', arguments: {} })).content[0].text);
    assert.equal(listed.items.length, 2);
    assert.equal(listed.items.find(item => item.id === target.id).memberCount, 2);
    assert.equal(listed.items.find(item => item.id === pending.id).memberCount, 1);
    const delegated = JSON.parse((await client.callTool({ name: 'delegate_to_team', arguments: {
      teamId: target.id,
      prompt: '整理资料并提交来源清单。',
      acceptance: '输出带来源的摘要。',
      idempotencyKey: 'mcp-handoff-1',
    } })).content[0].text);
    assert.equal(delegated.sourceTeamId, source.id);
    assert.equal(delegated.targetTeamId, target.id);
    assert.ok(delegated.taskId);
    assert.equal(app.platform.control.records.get('task-meta', delegated.taskId).modelOverride, 'pm-routing-model');
    assert.equal(runs.length, 2);
    const duplicate = JSON.parse((await client.callTool({ name: 'delegate_to_team', arguments: {
      teamId: target.id,
      prompt: '整理资料并提交来源清单。',
      idempotencyKey: 'mcp-handoff-1',
    } })).content[0].text);
    assert.equal(duplicate.duplicate, true);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
