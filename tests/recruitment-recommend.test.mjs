import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Hub 源在模块加载时读取环境变量：先把三个源都指向本地 fixture 服务器，
// 再动态导入服务端模块，让推荐测试完全离线、确定性（不再依赖 GitHub API）。
const hubServer = http.createServer((request, response) => {
  if (request.url?.startsWith('/contents/catalog.json') || request.url?.startsWith('/catalog.json')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      skills: [{
        id: 'hub-fixture-contract-review',
        title: '合同条款审查',
        name: 'contract-review',
        description: '审阅合同条款并识别法律与合规风险。',
        category: 'legal',
        categoryLabel: '法务',
        installUrl: 'skills.sh/fixture/contract-review',
      }],
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise(resolve => hubServer.listen(0, '127.0.0.1', resolve));
const hubBase = `http://127.0.0.1:${hubServer.address().port}`;
process.env.WORKBENCH_SKILL_HUB = hubBase;
process.env.WORKBENCH_SKILL_HUB_API = hubBase;
process.env.WORKBENCH_SKILL_HUB_CDN = hubBase;

const { createWorkbench } = await import('../server/index.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-rec-rec-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const runs = [];
  const app = createWorkbench({
    dir,
    dataDir: path.join(dir, 'data'),
    workspace,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
    }),
  });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, runs };
}

test('propose_team 自动填充推荐：内置进 skillIds、Hub 只作建议', async t => {
  // 本地 fixture Hub，不再需要网络可达性预检。
  const { app, runs } = sandbox(t);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`${base}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const clients = [];
  try {
    // 使用新的 discovery 草稿（种子团队已确认，不能再招募）。
    const team = (await request('teams', {
      name: '招募推荐测试',
      goal: '处理法务与质量问题。',
      purpose: '验证自动推荐填充。',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'discovery' },
    }, 'POST')).body;
    await request(`teams/${team.id}/messages`, { clientMessageId: 'rec-rec', content: '准备一个团队。' }, 'POST');
    // 轮询等待 PM 执行实例启动（固定 30ms 睡眠在并行负载下会失败）。
    for (let at = 0; at < 250 && !runs.length; at++)
      await new Promise(resolve => setTimeout(resolve, 40));
    const patch = runs[0].options.capabilityPatch.find(item => item.id === 'workbench-orchestration');
    const client = new Client({ name: 'rec-rec', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(patch.config.url), {
      requestInit: { headers: patch.config.headers },
    }));

    const proposed = JSON.parse((await client.callTool({
      name: 'propose_team',
      arguments: {
        teamName: '合同与质量小组',
        goal: '审阅合同并保证测试质量。',
        purpose: '处理法务与质量问题。',
        members: [
          { roleId: 'developer', memberId: 'reviewer', responsibility: '审阅合同条款并识别风险，同时维护不稳定的测试。' },
        ],
      },
    })).content[0].text);

    const member = proposed.proposal.members.find(item => item.memberId === 'reviewer');
    assert.ok(member, '应包含成员');
    // 职责涉及合同/风险/测试：内置 Skill 应有命中（如 code-review / bug-fix 等）。
    assert.ok(Array.isArray(member.skillIds), '应自动填充 skillIds');
    assert.ok(member.skillIds.length > 0, `未自动填充内置 Skill：${JSON.stringify(member.skillIds)}`);
    // Hub 建议只作为提示，不得写入 capabilityIds。
    assert.ok(Array.isArray(member.recommendations?.hub), '应返回 Hub 建议列表');
    assert.ok(member.recommendations.hub.length > 0, '应推荐未安装的 Hub 技能');
    for (const suggestion of member.recommendations.hub) {
      assert.ok(suggestion.id, '建议项需要有 id');
      assert.ok(!(member.capabilityIds || []).includes(suggestion.id), 'Hub 建议不得写入权限');
    }

    // autoRecommend=false 时不填充
    const manual = JSON.parse((await client.callTool({
      name: 'propose_team',
      arguments: {
        autoRecommend: false,
        teamName: '手工小组',
        goal: 'g',
        purpose: 'p',
        members: [{ roleId: 'developer', memberId: 'x', responsibility: '写代码。' }],
      },
    })).content[0].text);
    const manualMember = manual.proposal.members.find(item => item.memberId === 'x');
    assert.deepEqual(manualMember.skillIds, []);
    assert.equal(manualMember.recommendations, null);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
});

test('关闭 fixture Hub 服务器', () => {
  hubServer.close();
});
