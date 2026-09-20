import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recruitment-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('team recruitment keeps one PM session across completed discovery turns', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '已记录本轮招募信息。') { options.onResult(result); options.onDone('completed', ''); },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = (await request('teams')).body[0];
    const first = await request(`teams/${team.id}/messages`, { clientMessageId: 'recruit-1', content: '我想做一个面向小团队的项目协作工具。' }, 'POST');
    assert.equal(first.status, 201);
    await tick();
    assert.equal(runs.length, 1);
    const sessionId = first.body.sessionId;
    runs[0].complete();
    await tick();
    const second = await request(`teams/${team.id}/messages`, { clientMessageId: 'recruit-2', content: '需要网页端、权限控制和可验收的开发计划。' }, 'POST');
    assert.equal(second.status, 201);
    assert.equal(second.body.sessionId, sessionId);
    await tick();
    assert.equal(runs.length, 2);
    assert.match(runs[1].prompt, /网页端、权限控制/);
    assert.match(runs[1].prompt, /小团队的项目协作工具/);
    const detail = await request(`teams/${team.id}`);
    assert.equal(detail.body.recruitment.sessionId, sessionId);
    assert.equal(detail.body.recruitment.turns, 2);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('project manager proposes a Team Charter and owner confirmation materializes members', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
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
    const team = (await request('teams')).body[0];
    const provider = app.platform.providers.save({
      name: '招募测试模型',
      protocol: 'openai-completions',
      baseUrl: 'https://models.example.test/v1',
      models: [{ id: 'recruitment-model', name: '招募测试模型', tools: true }],
      enabled: true,
    });
    const capability = app.platform.control.store.records.save('capabilities', {
      name: '招募测试资料插件',
      kind: 'mcp',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://capability.example.test/mcp',
      tools: ['read_docs'],
    }, 'recruitment-capability');
    await request(`teams/${team.id}/messages`, { clientMessageId: 'recruit-proposal', content: '请根据这个想法给出团队方案。' }, 'POST');
    await tick();
    const patch = runs[0].options.capabilityPatch.find(item => item.id === 'workbench-orchestration');
    assert.ok(patch);
    const client = new Client({ name: 'recruitment-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(patch.config.url), { requestInit: { headers: patch.config.headers } }));
    const proposed = JSON.parse((await client.callTool({ name: 'propose_team', arguments: {
      teamName: '交付小队',
      goal: '交付一个可上线的协作工具 MVP。',
      purpose: '完成需求、实现和资料整理。',
      members: [
        { roleId: 'project_manager', responsibility: '澄清目标并协调交付。', deliverables: ['Team Charter'] },
        { roleId: 'product', responsibility: '整理需求和验收标准。', deliverables: ['需求说明'], tools: ['需要终端执行'] },
        { roleId: 'developer', memberId: 'frontend', name: '前端开发', responsibility: '实现前端功能并运行测试。', deliverables: ['前端代码'], skillIds: ['development-workflow'], capabilityIds: [capability.id], providerIds: [provider.id], modelHint: 'recruitment-model', toolAccess: { files: true, web: false, terminal: true } },
        { roleId: 'developer', memberId: 'backend', name: '后端开发', responsibility: '实现后端功能并运行测试。', deliverables: ['后端代码'], dependencies: ['frontend'] },
      ],
    } })).content[0].text);
    assert.equal(proposed.phase, 'proposed');
    assert.equal(proposed.proposal.size, 4);
    const token = patch.config.headers.Authorization.replace(/^Bearer\s+/i, '');
    const principal = app.platform.control.validateInstanceToken(token);
    assert.throws(() => app.platform.control.createJob({ role: 'developer', prompt: '提前实现功能' }, principal), /尚未确认/);
    const before = await request(`teams/${team.id}`);
    assert.equal(before.body.recruitment.phase, 'proposed');
    assert.deepEqual(before.body.memberRoleIds, ['project_manager', 'product', 'developer', 'assistant']);
    const confirmed = await request(`teams/${team.id}/recruitment/confirm`, {}, 'POST');
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recruitment.phase, 'confirmed');
    assert.equal(confirmed.body.memberRoleIds.length, 4);
    const developerIds = Object.entries(confirmed.body.responsibilities).filter(([, duty]) => duty.includes('并运行测试')).map(([id]) => id);
    assert.equal(developerIds.length, 2);
    assert.notEqual(developerIds[0], developerIds[1]);
    const frontendId = confirmed.body.recruitment.proposal.members.find(member => member.memberId === 'frontend').agentId;
    const frontend = app.platform.control.store.role(frontendId);
    assert.match(frontend.instructions, /实现前端功能并运行测试/);
    assert.ok(frontend.skillIds.includes('development-workflow'));
    assert.ok(frontend.capabilityIds.includes(capability.id));
    assert.deepEqual(frontend.providerIds, [provider.id]);
    assert.equal(frontend.model, 'recruitment-model');
    assert.deepEqual(frontend.tools, { files: true, web: false, terminal: true });
    const productId = confirmed.body.recruitment.proposal.members.find(member => member.roleId === 'product').agentId;
    assert.equal(app.platform.control.store.role(productId).tools.terminal, false);
    const roster = app.platform.control.readTeamRoster(principal);
    const frontendRoster = roster.members.find(member => member.memberId === 'frontend');
    assert.equal(frontendRoster.id, frontendId);
    assert.ok(frontendRoster.capabilityIds.includes(capability.id));
    assert.deepEqual(frontendRoster.runtimeTools, frontend.tools);
    const duplicate = await request(`teams/${team.id}/recruitment/confirm`, {}, 'POST');
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.recruitment.phase, 'confirmed');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team confirmation rejects disabled capabilities and unavailable model hints', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = (await request('teams')).body[0];
    await request(`teams/${team.id}/messages`, { clientMessageId: 'recruit-validation', content: '先准备一个开发团队。' }, 'POST');
    await tick();
    const patch = runs[0].options.capabilityPatch.find(item => item.id === 'workbench-orchestration');
    const token = patch.config.headers.Authorization.replace(/^Bearer\s+/i, '');
    const principal = app.platform.control.validateInstanceToken(token);
    const disabled = app.platform.control.store.records.save('capabilities', {
      name: '未启用插件', kind: 'mcp', enabled: false, transport: 'streamable-http', url: 'https://disabled.example.test/mcp', tools: [],
    }, 'disabled-recruitment-capability');
    app.platform.control.proposeTeam({ teamName: '校验团队', goal: '验证绑定前置条件。', purpose: '避免不可执行成员进入团队。', members: [
      { roleId: 'developer', memberId: 'dev', responsibility: '实现功能。', capabilityIds: [disabled.id] },
    ] }, principal);
    assert.throws(() => app.platform.control.confirmTeamRecruitment(team.id), /未启用的能力/);
    app.platform.control.proposeTeam({ teamName: '校验团队', goal: '验证绑定前置条件。', purpose: '避免不可执行成员进入团队。', members: [
      { roleId: 'developer', memberId: 'dev', responsibility: '实现功能。', modelHint: 'missing-model' },
    ] }, principal);
    assert.throws(() => app.platform.control.confirmTeamRecruitment(team.id), /模型未在可用供应商中配置/);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
