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
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
};

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
    assert.equal(spaces.body[0].recruitment.phase, 'confirmed');
    assert.equal(spaces.body[0].workspaceMode, 'isolated');
    const message = await request(`spaces/${spaces.body[0].id}/messages`, {
      clientMessageId: 'first-request',
      content: '评估新产品方向，并安排团队给出开发计划。',
    }, 'POST');
    assert.equal(message.status, 201);
    assert.ok(message.body.taskId);
    assert.ok(message.body.sessionId);
    await waitFor(() => runs.length === 1, '项目经理任务没有在测试窗口内启动。');
    assert.equal(runs[0].options.assistant.id, 'project_manager');
    assert.match(runs[0].prompt, /评估新产品方向/);
    runs[0].complete();
    await tick();
    const completedTask = app.store.tasks().find((item) => item.role === 'project_manager');
    app.store.records.save('artifacts', {
      taskId: completedTask.id,
      kind: 'verification',
      status: 'verified',
      verified: true,
    }, `verification:${completedTask.id}`);
    const detail = await request(`spaces/${spaces.body[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.messages.some((item) => item.kind === 'request'));
    assert.ok(detail.body.messages.some((item) => item.kind === 'reply' && /完成汇总/.test(item.content)));
    assert.ok(detail.body.tasks.some((item) => item.role === 'project_manager'));
    const taskSummary = detail.body.tasks.find((item) => item.role === 'project_manager');
    assert.equal(taskSummary.workspaceMode, 'isolated');
    assert.equal(taskSummary.artifactCount, 1);
    assert.equal(taskSummary.verificationStatus, 'verified');
    assert.equal(taskSummary.deliveryStatus, 'awaiting-owner');
    assert.ok(Array.isArray(detail.body.timeline));
    assert.deepEqual(
      detail.body.timeline.map((item) => item.at),
      [...detail.body.timeline].map((item) => item.at).sort((a, b) => a.localeCompare(b)),
    );
    assert.ok(detail.body.timeline.some((item) => item.type === 'message' && item.messageId));
    assert.ok(detail.body.timeline.some((item) => item.type === 'task' && item.taskId === completedTask.id));
    assert.ok(detail.body.timeline.some((item) => item.type === 'verification' && item.taskId === completedTask.id));
    app.store.records.save('task-acceptance', {
      taskId: completedTask.id,
      spaceId: spaces.body[0].id,
      decision: 'accepted',
      status: 'active',
      note: '项目经理已核对验证结果。',
      requirementVersion: 1,
      verificationId: `verification:${completedTask.id}`,
      decidedAt: new Date().toISOString(),
    }, completedTask.id);
    const acceptedDetail = await request(`spaces/${spaces.body[0].id}`);
    assert.equal(acceptedDetail.body.tasks.find((item) => item.id === completedTask.id).deliveryStatus, 'accepted');
    assert.ok(acceptedDetail.body.timeline.some((item) => item.type === 'acceptance' && item.acceptanceDecision === 'accepted'));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team templates save durable configuration and create an isolated team copy', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false, runtimeFactory: () => ({ start() {}, cancel() {} }) });
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
    const draft = await request('teams', {
      name: '尚未确认团队',
      goal: '只用于验证模板来源边界。',
      purpose: '等待招募确认。',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'discovery' },
    }, 'POST');
    assert.equal(draft.status, 201);
    const draftTemplate = await request('team-templates', { sourceTeamId: draft.body.id, name: '不应保存' }, 'POST');
    assert.equal(draftTemplate.status, 400);

    const source = await request('teams', {
      name: '平台研发团队',
      goal: '负责平台功能开发、测试和版本交付。',
      purpose: '把需求稳定地交付到线上。',
      teamType: 'development',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer', 'product'],
      workspace: fixture.workspace,
      workspaceMode: 'isolated',
      responsibilities: { developer: '实现功能并运行测试。' },
      memberSettings: { developer: { label: '主开发', modelHint: 'dev-model' } },
      model: 'team-model',
      providerId: 'team-provider',
      autonomy: { mode: 'assist', maxDepth: 3, maxJobs: 12, budgetTokens: 50000, requireApprovalKinds: ['deploy'] },
      collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: ['private-target'] },
      recruitment: { phase: 'confirmed' },
    }, 'POST');
    assert.equal(source.status, 201);
    const template = await request('team-templates', {
      sourceTeamId: source.body.id,
      name: '标准研发交付模板',
      description: '用于重复创建研发交付团队。',
    }, 'POST');
    assert.equal(template.status, 201);
    assert.equal(template.body.name, '标准研发交付模板');
    assert.equal(template.body.sourceTeamId, source.body.id);
    assert.deepEqual(template.body.memberRoleIds, ['project_manager', 'developer', 'product']);
    assert.equal(template.body.model, 'team-model');
    assert.equal(template.body.providerId, 'team-provider');
    assert.deepEqual(template.body.collaboration.allowedTeamIds, []);

    const listed = await request('team-templates');
    assert.ok(listed.body.some((item) => item.id === template.body.id));
    const copied = await request(`team-templates/${template.body.id}/apply`, {
      name: '支付研发团队',
      goal: '负责支付链路的开发、测试和上线。',
      workspace: fixture.workspace,
      recruitment: {
        phase: 'confirmed',
        sessionId: 'source-session-must-not-copy',
        turns: 99,
        proposal: { teamName: '旧方案' },
        confirmedAt: '2000-01-01T00:00:00.000Z',
      },
    }, 'POST');
    assert.equal(copied.status, 201);
    assert.notEqual(copied.body.id, source.body.id);
    assert.equal(copied.body.name, '支付研发团队');
    assert.equal(copied.body.goal, '负责支付链路的开发、测试和上线。');
    assert.equal(copied.body.recruitment.phase, 'confirmed');
    assert.equal(copied.body.recruitment.sessionId, null);
    assert.equal(copied.body.recruitment.turns, 0);
    assert.equal(copied.body.recruitment.proposal, null);
    assert.notEqual(copied.body.recruitment.confirmedAt, '2000-01-01T00:00:00.000Z');
    assert.deepEqual(copied.body.memberRoleIds, source.body.memberRoleIds);
    assert.equal(copied.body.memberSettings.developer.label, '主开发');
    assert.equal(copied.body.model, 'team-model');
    assert.equal(copied.body.providerId, 'team-provider');
    assert.equal(copied.body.autonomy.mode, 'assist');
    assert.deepEqual(copied.body.collaboration.allowedTeamIds, []);
    const detail = await request(`teams/${copied.body.id}`);
    assert.equal(detail.body.messages.length, 0);
    assert.equal(detail.body.tasks.length, 0);

    const removed = await request(`team-templates/${template.body.id}`, undefined, 'DELETE');
    assert.deepEqual(removed.body, { ok: true });
    const after = await request('team-templates');
    assert.ok(!after.body.some((item) => item.id === template.body.id));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team timeline exposes an older page without duplicating the latest window', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
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
    const team = (await request('teams')).body[0];
    for (let index = 0; index < 125; index += 1) {
      app.store.saveTeamMessage({
        spaceId: team.id,
        teamId: team.id,
        senderType: 'owner',
        senderId: 'owner',
        kind: 'request',
        content: `分页历史消息 ${index}`,
      }, `timeline-page-${index}`);
    }
    const detail = await request(`teams/${team.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.timeline.length, 120);
    const latestIds = new Set(detail.body.timeline.map((item) => item.id));
    const cursor = encodeURIComponent(`${detail.body.timeline[0].at}|${detail.body.timeline[0].id}`);
    const older = await request(`teams/${team.id}/timeline?limit=60&before=${cursor}`);
    assert.equal(older.status, 200);
    assert.equal(older.body.items.length, 5);
    assert.equal(older.body.hasMore, false);
    assert.ok(older.body.items.every((item) => !latestIds.has(item.id)));
    assert.deepEqual(
      older.body.items.map((item) => item.content),
      ['分页历史消息 0', '分页历史消息 1', '分页历史消息 2', '分页历史消息 3', '分页历史消息 4'],
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('cross-team timeline aggregates confirmed teams with labels and cursor pagination', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
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
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '跨团队统一时间线研发团队',
      goal: '验证统一时间线可以标记来源团队。',
      memberRoleIds: ['project_manager'],
    }, 'POST')).body;
    const draft = (await request('teams', {
      name: '跨团队统一时间线草稿团队',
      goal: '不应出现在跨团队统一时间线。',
      recruitment: { phase: 'discovery' },
      memberRoleIds: ['project_manager'],
    }, 'POST')).body;

    const addMessage = (team, content, suffix) => app.store.saveTeamMessage({
      spaceId: team.id,
      teamId: team.id,
      clientMessageId: `cross-team-timeline-${suffix}`,
      kind: 'reply',
      senderType: 'agent',
      senderId: 'project_manager',
      content,
      status: 'sent',
    }, `cross-team-timeline-${suffix}`);
    addMessage(source, '统一时间线：项目经理已更新运维计划。', 'source-1');
    addMessage(target, '统一时间线：研发团队已完成接口拆分。', 'target-1');
    addMessage(source, '统一时间线：运维团队开始灰度验证。', 'source-2');
    addMessage(draft, '草稿团队消息不应泄漏到统一时间线。', 'draft-1');

    const first = await request('timeline?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.items.every((item) => item.teamId));
    assert.ok(first.body.items.every((item) => [source.id, target.id].includes(item.teamId)));
    assert.ok(first.body.items.every((item) => item.teamName));
    assert.ok(first.body.items.some((item) => item.teamId === source.id));
    assert.ok(first.body.items.some((item) => item.teamId === target.id));
    assert.ok(first.body.items.every((item) => !/草稿团队消息/.test(item.content || '')));

    const cursorItem = first.body.items[first.body.items.length - 1];
    const cursor = encodeURIComponent(`${cursorItem.at}|${cursorItem.id}`);
    const second = await request(`timeline?limit=2&before=${cursor}`);
    assert.equal(second.status, 200);
    assert.ok(Array.isArray(second.body.items));
    const firstIds = new Set(first.body.items.map((item) => item.id));
    assert.ok(second.body.items.every((item) => !firstIds.has(item.id)));
    assert.ok(second.body.items.every((item) => [source.id, target.id].includes(item.teamId)));
    assert.ok(second.body.items.every((item) => item.teamName));
    assert.ok(second.body.items.some((item) => item.teamId === source.id));

    const filtered = await request(`timeline?teamId=${encodeURIComponent(target.id)}&limit=10`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.items.length >= 1);
    assert.ok(filtered.body.items.every((item) => item.teamId === target.id));
    assert.ok(filtered.body.items.every((item) => item.teamName === target.name));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team risks aggregate confirmed teams and support team, kind, and cursor filters', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
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
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '风险聚合目标团队',
      goal: '验证跨团队风险过滤。',
      memberRoleIds: ['project_manager'],
    }, 'POST')).body;
    const pending = (await request('teams', {
      name: '未确认风险团队',
      goal: '不应出现在跨团队风险收件箱。',
      recruitment: { phase: 'discovery' },
    }, 'POST')).body;
    const createRiskTask = (team, status, error) => {
      const task = app.store.createTask({
        role: 'project_manager',
        prompt: `${team.name} 风险任务`,
        workspace: fixture.workspace,
      });
      app.store.records.save('task-meta', {
        spaceId: team.id,
        teamId: team.id,
        workspaceMode: 'isolated',
        attachmentIds: [],
      }, task.id);
      app.store.updateTask(task.id, { status, error });
      return task;
    };
    const sourceTask = createRiskTask(source, 'failed', '源团队执行失败。');
    const targetTask = createRiskTask(target, 'blocked', '目标团队等待处理。');
    createRiskTask(pending, 'failed', '未确认团队失败。');
    app.store.records.save('attention', {
      taskId: targetTask.id,
      teamId: target.id,
      status: 'open',
      kind: 'manual-review',
      title: '目标团队需要确认',
      detail: '请确认目标团队的阻塞原因。',
    }, 'risk-attention-target');
    app.store.records.save('attention', {
      taskId: sourceTask.id,
      teamId: source.id,
      status: 'resolved',
      kind: 'manual-review',
      title: '已处理事项',
    }, 'risk-attention-resolved');

    const all = await request('risks?limit=20');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 3);
    assert.deepEqual(new Set(all.body.items.map((item) => item.teamId)), new Set([source.id, target.id]));
    assert.ok(all.body.items.some((item) => item.kind === 'execution' && item.taskId === sourceTask.id));
    assert.ok(all.body.items.some((item) => item.kind === 'attention' && item.taskId === targetTask.id));
    assert.ok(!all.body.items.some((item) => item.teamId === pending.id));

    const targetOnly = await request(`risks?teamId=${encodeURIComponent(target.id)}&kind=execution`);
    assert.equal(targetOnly.body.total, 1);
    assert.equal(targetOnly.body.items[0].taskId, targetTask.id);
    const attentionOnly = await request(`risks?teamId=${encodeURIComponent(target.id)}&kind=attention`);
    assert.equal(attentionOnly.body.total, 1);
    assert.equal(attentionOnly.body.items[0].title, '目标团队需要确认');

    const firstPage = await request('risks?limit=1');
    assert.equal(firstPage.body.items.length, 1);
    assert.equal(firstPage.body.hasMore, true);
    const first = firstPage.body.items[0];
    const secondPage = await request(`risks?limit=1&before=${encodeURIComponent(`${first.updatedAt}|${first.id}`)}`);
    assert.equal(secondPage.body.items.length, 1);
    assert.notEqual(secondPage.body.items[0].id, first.id);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team sessions cannot be reused across teams', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
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
  try {
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '会话隔离目标团队',
      goal: '验证团队会话不会跨空间复用。',
      memberRoleIds: ['project_manager'],
    }, 'POST')).body;
    const sourceMessage = await request(`teams/${source.id}/messages`, {
      clientMessageId: 'session-scope-source',
      content: '源团队上下文，只能留在源团队。',
    }, 'POST');
    assert.equal(sourceMessage.status, 201);
    await tick();

    const rejected = await request('tasks', {
      role: 'project_manager',
      teamId: target.id,
      spaceId: target.id,
      sessionId: sourceMessage.body.sessionId,
      prompt: '不应读取源团队上下文。',
    }, 'POST');
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /另一个团队/);

    const targetDetail = await request(`teams/${target.id}`);
    assert.equal(targetDetail.body.tasks.length, 0);
    assert.equal(targetDetail.body.messages.length, 0);

    const sameTeam = await request('tasks', {
      role: 'project_manager',
      teamId: source.id,
      spaceId: source.id,
      sessionId: sourceMessage.body.sessionId,
      prompt: '在源团队继续推进。',
    }, 'POST');
    assert.equal(sameTeam.status, 201);
    const sourceDetail = await request(`teams/${source.id}`);
    assert.equal(sourceDetail.body.tasks.length, 2);
    assert.ok(sourceDetail.body.tasks.some((task) => task.prompt === '在源团队继续推进。'));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('team task handoff keeps the receiving task in the same team', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '已完成') {
        options.onResult(result);
        options.onDone('completed', '');
      },
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
  try {
    const team = (await request('teams', {
      name: '团队交接验证组',
      goal: '验证团队内的项目经理可以把任务交给开发成员。',
      memberRoleIds: ['project_manager', 'developer'],
    }, 'POST')).body;
    const source = await request('tasks', {
      role: 'project_manager',
      teamId: team.id,
      spaceId: team.id,
      prompt: '先整理团队交付方案。',
    }, 'POST');
    assert.equal(source.status, 201);
    await waitFor(() => runs.length === 1, '目标团队协作任务没有在测试窗口内启动。');
    runs[0].complete('交付方案已整理。');
    await tick();

    const handoff = await request(`tasks/${source.body.id}/handoff`, {
      role: 'developer',
      note: '请根据这份方案实现并运行测试。',
    }, 'POST');
    assert.equal(handoff.status, 201);
    await tick();
    const detail = await request(`teams/${team.id}`);
    const received = detail.body.tasks.find((task) => task.id === handoff.body.id);
    assert.ok(received);
    assert.equal(received.teamId, team.id);
    assert.equal(received.role, 'developer');
    assert.equal(received.sourceTaskId, source.body.id);
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
      collaboration: { enabled: true, allowedTeamIds: [], autoHandoff: true },
    }, 'POST');
    assert.equal(created.status, 201);
    assert.equal(created.body.teamType, 'operations');
    assert.equal(created.body.chatId, created.body.id);
    assert.equal(created.body.collaboration.enabled, true);
    assert.deepEqual(created.body.collaboration.allowedTeamIds, []);

    const renamed = await request(`teams/${created.body.id}`, {
      name: '运维与发布团队',
    }, 'PUT');
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.id, created.body.id);
    assert.equal(renamed.body.name, '运维与发布团队');
    const listedAfterRename = await request('teams');
    assert.equal(
      listedAfterRename.body.find((team) => team.id === created.body.id).name,
      '运维与发布团队',
    );
    const invalidRename = await request(`teams/${created.body.id}`, {
      name: '   ',
    }, 'PUT');
    assert.equal(invalidRename.status, 400);
    assert.equal(
      (await request(`teams/${created.body.id}`)).body.name,
      '运维与发布团队',
    );

    const teams = await request('teams');
    assert.equal(teams.body.length, 2);
    const collaborators = await request(`teams/${source.id}/collaborators`);
    assert.equal(collaborators.status, 200);
    assert.ok(collaborators.body.some((item) => item.id === created.body.id));

    const future = await request('teams', {
      name: '后续项目团队',
      goal: '承接后续专项开发任务。',
      collaboration: { enabled: true, allowedTeamIds: [] },
    }, 'POST');
    assert.equal(future.status, 201);
    const futureCollaborators = await request(`teams/${created.body.id}/collaborators`);
    assert.ok(futureCollaborators.body.some((item) => item.id === future.body.id));

    const closed = await request('teams', {
      name: '封闭团队',
      goal: '仅处理本团队内部任务。',
      collaboration: { enabled: false, allowedTeamIds: [] },
    }, 'POST');
    assert.equal(closed.status, 201);
    assert.deepEqual((await request(`teams/${closed.body.id}/collaborators`)).body, []);
    const disabled = await request(`teams/${closed.body.id}/collaborate`, {
      targetTeamId: source.id,
      clientMessageId: 'closed-1',
      content: '不应发送跨团队请求。',
    }, 'POST');
    assert.equal(disabled.status, 409);
    assert.match(disabled.body.error, /未启用跨团队协作/);

    const waiting = await request('teams', {
      name: '待确认团队',
      goal: '尚未完成招募的团队。',
      recruitment: { phase: 'discovery' },
    }, 'POST');
    const visibleCollaborators = await request(`teams/${source.id}/collaborators`);
    assert.ok(visibleCollaborators.body.some((item) => item.id === created.body.id));
    assert.ok(!visibleCollaborators.body.some((item) => item.id === waiting.body.id));
    const blocked = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: waiting.body.id,
      clientMessageId: 'waiting-1',
      content: '请在确认前接收这条请求。',
    }, 'POST');
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /尚未完成招募/);
    const blockedSource = await request(`teams/${waiting.body.id}/collaborate`, {
      targetTeamId: source.id,
      clientMessageId: 'waiting-source-1',
      content: '待确认团队不应发起协作。',
    }, 'POST');
    assert.equal(blockedSource.status, 409);
    assert.match(blockedSource.body.error, /尚未完成招募/);
    assert.deepEqual((await request(`teams/${waiting.body.id}/collaborators`)).body, []);

    const collaborationAcceptance = '回传发布检查项、风险等级和回滚步骤。';
    const delegated = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: created.body.id,
      clientMessageId: 'ops-1',
      content: '请建立本项目的发布检查和运行监控清单。',
      acceptance: collaborationAcceptance,
    }, 'POST');
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.sourceTeamId, source.id);
    assert.equal(delegated.body.targetTeamId, created.body.id);
    assert.ok(delegated.body.taskId);
    assert.equal(app.store.taskDelivery(app.store.task(delegated.body.taskId)).acceptanceCriteria, collaborationAcceptance);
    await waitFor(() => runs.length === 1, '跨团队编排消息对应的项目经理任务没有在测试窗口内启动。');
    assert.match(runs[0].prompt, /运行监控清单/);
    const detail = await request(`teams/${created.body.id}`);
    assert.equal(detail.body.messages[0].fromTeamId, source.id);
    assert.equal(detail.body.tasks[0].teamId, created.body.id);
    const sourceDetail = await request(`teams/${source.id}`);
    const outgoing = sourceDetail.body.messages.find(
      (message) =>
        message.kind === 'handoff' &&
        message.toTeamId === created.body.id &&
        message.taskId === delegated.body.taskId,
    );
    assert.ok(outgoing);
    assert.equal(outgoing.relatedMessageId, detail.body.messages[0].id);

    // A retry must repair a missing source trace instead of creating a second target task.
    const sourceTraceId = `handoff:${source.id}:${created.body.id}:ops-1:source`;
    assert.equal(app.platform.control.records.remove('space-messages', sourceTraceId), true);
    const retried = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: created.body.id,
      clientMessageId: 'ops-1',
      content: '请建立本项目的发布检查和运行监控清单。',
    }, 'POST');
    assert.equal(retried.status, 200);
    assert.equal(retried.body.taskId, delegated.body.taskId);
    assert.equal(retried.body.sourceMessageId, sourceTraceId);
    const restoredSource = app.platform.control.records.get('space-messages', sourceTraceId);
    assert.equal(restoredSource.relatedMessageId, detail.body.messages[0].id);
    assert.equal(restoredSource.taskId, delegated.body.taskId);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('twenty alternating messages keep two confirmed teams, models, and tasks isolated', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start() { runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete() { options.onResult('本地 fixture 回复'); options.onDone('completed', ''); },
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
  try {
    const provider = app.platform.providers.save({
      name: 'Team isolation fixture',
      protocol: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [
        { id: 'team-alpha-model', tools: true },
        { id: 'team-beta-model', tools: true },
      ],
      priority: 1,
    });
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '连续切换验收团队',
      goal: '验证连续切换时上下文和任务归属不串线。',
      memberRoleIds: ['project_manager', 'assistant'],
    }, 'POST')).body;
    for (const [teamId, model] of [[source.id, 'team-alpha-model'], [target.id, 'team-beta-model']]) {
      const configured = await request(`teams/${teamId}`, { model, providerId: provider.id }, 'PUT');
      assert.equal(configured.status, 200);
      assert.equal(configured.body.model, model);
      assert.equal(configured.body.providerId, provider.id);
    }
    const expected = new Map([[source.id, 'team-alpha-model'], [target.id, 'team-beta-model']]);
    for (let index = 0; index < 20; index += 1) {
      const team = index % 2 === 0 ? source : target;
      const model = expected.get(team.id);
      const content = `隔离压力消息 ${index} (${team.id})`;
      const sent = await request(`teams/${team.id}/messages`, {
        clientMessageId: `isolation-${index}`,
        content,
        model,
        providerId: provider.id,
      }, 'POST');
      assert.equal(sent.status, 201);
      assert.ok(sent.body.taskId);
      await waitFor(() => runs.length === index + 1, `第 ${index + 1} 次切换未启动任务`);
      const run = runs[index];
      const meta = app.platform.control.records.get('task-meta', run.options.task.id);
      assert.equal(meta.teamId, team.id);
      assert.equal(meta.spaceId, team.id);
      assert.equal(meta.modelOverride, model);
      assert.deepEqual(meta.providerIds, [provider.id]);
      assert.equal(run.options.route.model, model);
      assert.equal(run.options.route.providerId, provider.id);
      run.complete();
    }
    for (const team of [source, target]) {
      const detail = await request(`teams/${team.id}`);
      assert.equal(detail.status, 200);
      const own = detail.body.messages.filter((message) => message.content?.startsWith('隔离压力消息'));
      assert.equal(own.length, 10);
      assert.ok(own.every((message) => message.content.includes(`(${team.id})`)));
      assert.equal(detail.body.tasks.length, 10);
      assert.ok(detail.body.tasks.every((task) => task.teamId === team.id));
    }
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
    await waitFor(() => runs.length === 1, '团队消息对应的项目经理任务没有在测试窗口内启动。');
    const patch = runs[0].options.capabilityPatch.find((item) => item.id === 'workbench-orchestration');
    const client = new Client({ name: 'team-mcp-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(patch.config.url), { requestInit: { headers: patch.config.headers } }));
    const listed = JSON.parse((await client.callTool({ name: 'list_teams', arguments: {} })).content[0].text);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items.find(item => item.id === target.id).memberCount, 2);
    assert.equal(listed.items.find(item => item.id === pending.id), undefined);
    const delegated = JSON.parse((await client.callTool({ name: 'delegate_to_team', arguments: {
      teamId: target.id,
      prompt: '整理资料并提交来源清单。',
      acceptance: '输出带来源的摘要。',
      idempotencyKey: 'mcp-handoff-1',
    } })).content[0].text);
    assert.equal(delegated.sourceTeamId, source.id);
    assert.equal(delegated.targetTeamId, target.id);
    assert.ok(delegated.taskId);
    assert.ok(delegated.sourceMessageId);
    assert.equal(app.platform.control.records.get('task-meta', delegated.taskId).modelOverride, 'pm-routing-model');
    const sourceHandoff = app.store.teamMessages(source.id).find(
      (message) =>
        message.kind === 'handoff' &&
        message.toTeamId === target.id &&
        message.taskId === delegated.taskId,
    );
    assert.equal(sourceHandoff.id, delegated.sourceMessageId);
    assert.equal(sourceHandoff.relatedMessageId, delegated.messageId);
    await waitFor(() => runs.length === 2, '目标团队执行实例未启动。');
    const duplicate = JSON.parse((await client.callTool({ name: 'delegate_to_team', arguments: {
      teamId: target.id,
      prompt: '整理资料并提交来源清单。',
      idempotencyKey: 'mcp-handoff-1',
    } })).content[0].text);
    assert.equal(duplicate.duplicate, true);

    runs[1].complete('资料团队已整理来源清单并提交摘要。');
    await tick();
    const sourceReply = app.store.teamMessages(source.id).find(
      (message) => message.kind === 'reply' && message.taskId === delegated.taskId,
    );
    assert.ok(sourceReply);
    assert.equal(sourceReply.senderType, 'team');
    assert.equal(sourceReply.fromTeamId, target.id);
    assert.equal(sourceReply.relatedMessageId, sourceHandoff.id);
    assert.match(sourceReply.content, /已整理来源清单/);
    assert.equal(app.store.records.get('space-messages', sourceHandoff.id).status, 'answered');
    const read = JSON.parse((await client.callTool({ name: 'read_team_task', arguments: { taskId: delegated.taskId } })).content[0].text);
    assert.equal(read.delivery.deliveryStatus, 'pending-review');
    assert.equal(read.delivery.acceptanceDecision, null);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
