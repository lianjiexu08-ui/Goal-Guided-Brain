import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

test('全局搜索：跨任务/团队消息/知识库分组检索', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-search-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const app = createWorkbench({
    dir,
    workspace,
    dataDir: path.join(dir, 'data'),
    requireCredential: false,
    runtimeFactory: options => ({ options, start() {}, cancel() { options.onDone('cancelled', ''); } }),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // 两个团队：任务、消息、知识库分别含关键词"登录"
  const alpha = app.store.saveTeamSpace({ name: 'Alpha 支付团队', goal: '支付', purpose: 'p', workspace: path.join(app.store.config.workspace), pmRoleId: 'project_manager' });
  const beta = app.store.saveTeamSpace({ name: 'Beta 内容团队', goal: '内容', purpose: 'p', workspace: path.join(app.store.config.workspace), pmRoleId: 'project_manager' });

  const task = app.store.createTask({ role: 'developer', prompt: '实现登录页' });
  app.store.updateTask(task.id, { title: '登录页开发', result: '登录流程已完成', status: 'completed' });
  const meta = app.store.records.get('task-meta', task.id) || {};
  app.store.records.save('task-meta', { ...meta, spaceId: alpha.id, teamId: alpha.id }, task.id);

  app.store.saveTeamMessage({
    spaceId: beta.id, teamId: beta.id, clientMessageId: 'm1', kind: 'request',
    senderType: 'owner', senderId: 'owner', content: '请优化登录流程的文案', status: 'sent',
  }, 'm1');
  app.store.saveTeamMessage({
    spaceId: beta.id, teamId: beta.id, clientMessageId: 'm2', kind: 'request',
    senderType: 'owner', senderId: 'owner', content: '无关消息', status: 'sent',
  }, 'm2');

  app.store.saveKnowledge({ title: '登录接口约定', content: '登录接口使用 JWT，团队 Alpha 维护。', scope: 'project', state: 'confirmed', source: 'fixture' });
  app.store.saveKnowledge({ title: '部署手册', content: '与登录无关的内容', scope: 'project', state: 'confirmed', source: 'fixture' });

  const res = await (await fetch(`${base}/api/search?q=${encodeURIComponent('登录')}`)).json();
  assert.equal(res.query, '登录');
  assert.ok(res.tasks.some(item => item.id === task.id && item.teamName === 'Alpha 支付团队'), '任务应带团队上下文');
  assert.ok(res.messages.some(item => item.content.includes('登录流程的文案') && item.spaceId === beta.id), '消息应分组到 Beta');
  assert.ok(!res.messages.some(item => item.content === '无关消息'), '不匹配的消息不应出现');
  assert.ok(res.knowledge.some(item => item.title === '登录接口约定'));

  // 空查询 → 三组皆空
  const empty = await (await fetch(`${base}/api/search?q=`)).json();
  assert.deepEqual(empty, { query: '', tasks: [], messages: [], knowledge: [] });

  // 大小写不敏感
  const caseSearch = await (await fetch(`${base}/api/search?q=${encodeURIComponent('JWT')}`)).json();
  assert.ok(caseSearch.knowledge.length >= 1);
});
