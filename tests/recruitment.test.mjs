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
        { roleId: 'product', responsibility: '整理需求和验收标准。', deliverables: ['需求说明'] },
        { roleId: 'developer', responsibility: '实现功能并运行测试。', deliverables: ['可验证代码'] },
      ],
    } })).content[0].text);
    assert.equal(proposed.phase, 'proposed');
    assert.equal(proposed.proposal.size, 3);
    const before = await request(`teams/${team.id}`);
    assert.equal(before.body.recruitment.phase, 'proposed');
    assert.deepEqual(before.body.memberRoleIds, ['project_manager', 'product', 'developer', 'assistant']);
    const confirmed = await request(`teams/${team.id}/recruitment/confirm`, {}, 'POST');
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recruitment.phase, 'confirmed');
    assert.deepEqual(confirmed.body.memberRoleIds, ['project_manager', 'product', 'developer']);
    assert.equal(confirmed.body.responsibilities.developer, '实现功能并运行测试。');
    const duplicate = await request(`teams/${team.id}/recruitment/confirm`, {}, 'POST');
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.recruitment.phase, 'confirmed');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
