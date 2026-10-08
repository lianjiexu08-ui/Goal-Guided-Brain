import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';
import { createWorkbench } from '../server/index.mjs';
import { sandbox, tick, waitFor } from './helpers/team-helpers.mjs';

void test('team space routes owner messages to the project manager and persists replies', async () => {
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
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const spaces = await request('spaces');
    assert.equal(spaces.status, 200);
    assert.equal(spaces.body.length, 1);
    assert.equal(spaces.body[0].pmRoleId, 'project_manager');
    assert.equal(spaces.body[0].recruitment.phase, 'confirmed');
    assert.equal(spaces.body[0].workspaceMode, 'isolated');
    const message = await request(
      `spaces/${spaces.body[0].id}/messages`,
      {
        clientMessageId: 'first-request',
        content: '评估新产品方向，并安排团队给出开发计划。',
      },
      'POST',
    );
    assert.equal(message.status, 201);
    assert.ok(message.body.taskId);
    assert.ok(message.body.sessionId);
    await waitFor(
      () => runs.length === 1,
      '项目经理任务没有在测试窗口内启动。',
    );
    assert.equal(runs[0].options.assistant.id, 'project_manager');
    assert.match(runs[0].prompt, /评估新产品方向/);
    runs[0].complete();
    await tick();
    const completedTask = app.store
      .tasks()
      .find((item) => item.role === 'project_manager');
    app.store.records.save(
      'artifacts',
      {
        taskId: completedTask.id,
        kind: 'verification',
        status: 'verified',
        verified: true,
      },
      `verification:${completedTask.id}`,
    );
    const detail = await request(`spaces/${spaces.body[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.messages.some((item) => item.kind === 'request'));
    assert.ok(
      detail.body.messages.some(
        (item) => item.kind === 'reply' && /完成汇总/.test(item.content),
      ),
    );
    assert.ok(
      detail.body.tasks.some((item) => item.role === 'project_manager'),
    );
    const taskSummary = detail.body.tasks.find(
      (item) => item.role === 'project_manager',
    );
    assert.equal(taskSummary.workspaceMode, 'isolated');
    assert.equal(taskSummary.artifactCount, 1);
    assert.equal(taskSummary.verificationStatus, 'verified');
    assert.equal(taskSummary.deliveryStatus, 'awaiting-owner');
    assert.ok(Array.isArray(detail.body.timeline));
    assert.deepEqual(
      detail.body.timeline.map((item) => item.at),
      [...detail.body.timeline]
        .map((item) => item.at)
        .sort((a, b) => a.localeCompare(b)),
    );
    assert.ok(
      detail.body.timeline.some(
        (item) => item.type === 'message' && item.messageId,
      ),
    );
    assert.ok(
      detail.body.timeline.some(
        (item) => item.type === 'task' && item.taskId === completedTask.id,
      ),
    );
    assert.ok(
      detail.body.timeline.some(
        (item) =>
          item.type === 'verification' && item.taskId === completedTask.id,
      ),
    );
    app.store.records.save(
      'task-acceptance',
      {
        taskId: completedTask.id,
        spaceId: spaces.body[0].id,
        decision: 'accepted',
        status: 'active',
        note: '项目经理已核对验证结果。',
        requirementVersion: 1,
        verificationId: `verification:${completedTask.id}`,
        decidedAt: new Date().toISOString(),
      },
      completedTask.id,
    );
    const acceptedDetail = await request(`spaces/${spaces.body[0].id}`);
    assert.equal(
      acceptedDetail.body.tasks.find((item) => item.id === completedTask.id)
        .deliveryStatus,
      'accepted',
    );
    assert.ok(
      acceptedDetail.body.timeline.some(
        (item) =>
          item.type === 'acceptance' && item.acceptanceDecision === 'accepted',
      ),
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team autonomy pause and resume gate new team messages', async () => {
  const fixture = sandbox();
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: () => ({ start() {}, cancel() {} }),
  });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = (await request('teams')).body[0];
    const configured = await request(
      `teams/${team.id}`,
      {
        autonomy: {
          mode: 'assist',
          maxDepth: 2,
          maxJobs: 1,
          budgetTokens: 50000,
        },
      },
      'PUT',
    );
    assert.equal(configured.status, 200);
    assert.equal(configured.body.autonomy.mode, 'assist');
    assert.equal(configured.body.autonomy.maxDepth, 2);
    assert.equal(configured.body.autonomy.maxJobs, 1);
    assert.equal(configured.body.autonomy.budgetTokens, 50000);
    const paused = await request(`teams/${team.id}/autonomy/pause`, {}, 'POST');
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
    const rejected = await request(
      `teams/${team.id}/messages`,
      {
        clientMessageId: 'paused-team-message',
        content: '暂停期间不应启动新的项目经理执行。',
      },
      'POST',
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /不可接收新消息/);

    const resumed = await request(
      `teams/${team.id}/autonomy/resume`,
      {},
      'POST',
    );
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'active');
    const accepted = await request(
      `teams/${team.id}/messages`,
      {
        clientMessageId: 'resumed-team-message',
        content: '恢复后可以启动新的项目经理执行。',
      },
      'POST',
    );
    assert.equal(accepted.status, 201);
    assert.ok(accepted.body.taskId);
    app.store.updateTask(accepted.body.taskId, { status: 'completed' });
    const capped = await request(
      `teams/${team.id}/messages`,
      {
        clientMessageId: 'capped-team-message',
        content: '任务上限后不应再启动第二个项目经理执行。',
      },
      'POST',
    );
    assert.equal(capped.status, 409);
    assert.match(capped.body.error, /自治任务上限/);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team token budget pauses autonomous work and records actionable attention', async () => {
  const fixture = sandbox();
  const runs = [];
  let reportedTokens = 2000;
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    usageMeter: () => ({
      totalTokens: reportedTokens,
      outputTokens: 500,
      uncachedInputTokens: reportedTokens - 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    runtimeFactory: (options) => {
      const run = {
        options,
        start() {
          runs.push(run);
        },
        cancel() {
          options.onDone('cancelled', '');
        },
      };
      return run;
    },
  });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = (await request('teams')).body[0];
    const configured = await request(
      `teams/${team.id}`,
      {
        autonomy: { mode: 'auto', maxDepth: 4, maxJobs: 8, budgetTokens: 2500 },
      },
      'PUT',
    );
    assert.equal(configured.status, 200);
    const message = await request(
      `teams/${team.id}/messages`,
      {
        clientMessageId: 'budget-team-message',
        content: '触发团队预算检查。',
      },
      'POST',
    );
    assert.equal(message.status, 201);
    await waitFor(() => runs.length === 1, '团队预算测试任务没有启动。');
    const run = runs[0];
    run.options.onEvent({ type: 'turn/start', data: { turn: 1 } });
    run.options.onEvent({ type: 'step/start', data: { turn: 1, step: 1 } });
    run.options.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: 'done' }],
        },
        usage: { inputTokens: 1500, outputTokens: 500, totalTokens: 2000 },
      },
    });
    run.options.onEvent({ type: 'step/end', data: { turn: 1, step: 1 } });
    await tick();
    const warningState = await request(`teams/${team.id}`);
    assert.equal(warningState.body.status, 'active');
    assert.equal(warningState.body.autonomyUsage.warning, true);
    assert.equal(warningState.body.autonomyUsage.usedTokens, 2000);
    assert.ok(
      app.store.records
        .list('attention')
        .some(
          (item) =>
            item.kind === 'team-budget-warning' && item.teamId === team.id,
        ),
    );

    reportedTokens = 3000;
    run.options.onEvent({ type: 'turn/start', data: { turn: 2 } });
    run.options.onEvent({ type: 'step/start', data: { turn: 2, step: 1 } });
    run.options.onEvent({
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: {
          source: { provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: 'done' }],
        },
        usage: { inputTokens: 2500, outputTokens: 500, totalTokens: 3000 },
      },
    });
    run.options.onEvent({ type: 'step/end', data: { turn: 2, step: 1 } });
    await tick();
    const paused = await request(`teams/${team.id}`);
    assert.equal(paused.body.status, 'paused');
    assert.equal(paused.body.autonomyUsage.exceeded, true);
    const taskMeta = app.store.records.get('task-meta', message.body.taskId);
    assert.equal(
      app.store.records.get('jobs', taskMeta.jobId).status,
      'budget-exceeded',
    );
    assert.ok(
      app.store.records
        .list('attention')
        .some((item) => item.kind === 'team-budget' && item.teamId === team.id),
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team templates save durable configuration and create an isolated team copy', async () => {
  const fixture = sandbox();
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: () => ({ start() {}, cancel() {} }),
  });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const draft = await request(
      'teams',
      {
        name: '尚未确认团队',
        goal: '只用于验证模板来源边界。',
        purpose: '等待招募确认。',
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: { phase: 'discovery' },
      },
      'POST',
    );
    assert.equal(draft.status, 201);
    const draftTemplate = await request(
      'team-templates',
      { sourceTeamId: draft.body.id, name: '不应保存' },
      'POST',
    );
    assert.equal(draftTemplate.status, 400);

    const source = await request(
      'teams',
      {
        name: '平台研发团队',
        goal: '负责平台功能开发、测试和版本交付。',
        purpose: '把需求稳定地交付到线上。',
        teamType: 'development',
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager', 'developer', 'product'],
        workspace: fixture.workspace,
        workspaceMode: 'isolated',
        responsibilities: { developer: '实现功能并运行测试。' },
        memberSettings: {
          developer: { label: '主开发', modelHint: 'dev-model' },
        },
        model: 'team-model',
        providerId: 'team-provider',
        autonomy: {
          mode: 'assist',
          maxDepth: 3,
          maxJobs: 12,
          budgetTokens: 50000,
          requireApprovalKinds: ['deploy'],
        },
        collaboration: {
          enabled: true,
          autoHandoff: true,
          sharedBoard: true,
          allowedTeamIds: ['private-target'],
        },
        recruitment: { phase: 'confirmed' },
      },
      'POST',
    );
    assert.equal(source.status, 201);
    const template = await request(
      'team-templates',
      {
        sourceTeamId: source.body.id,
        name: '标准研发交付模板',
        description: '用于重复创建研发交付团队。',
      },
      'POST',
    );
    assert.equal(template.status, 201);
    assert.equal(template.body.name, '标准研发交付模板');
    assert.equal(template.body.sourceTeamId, source.body.id);
    assert.deepEqual(template.body.memberRoleIds, [
      'project_manager',
      'developer',
      'product',
    ]);
    assert.equal(template.body.model, 'team-model');
    assert.equal(template.body.providerId, 'team-provider');
    assert.deepEqual(template.body.collaboration.allowedTeamIds, []);

    const listed = await request('team-templates');
    assert.ok(listed.body.some((item) => item.id === template.body.id));
    const copied = await request(
      `team-templates/${template.body.id}/apply`,
      {
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
      },
      'POST',
    );
    assert.equal(copied.status, 201);
    assert.notEqual(copied.body.id, source.body.id);
    assert.equal(copied.body.name, '支付研发团队');
    assert.equal(copied.body.goal, '负责支付链路的开发、测试和上线。');
    assert.equal(copied.body.recruitment.phase, 'confirmed');
    assert.equal(copied.body.recruitment.sessionId, null);
    assert.equal(copied.body.recruitment.turns, 0);
    assert.equal(copied.body.recruitment.proposal, null);
    assert.notEqual(
      copied.body.recruitment.confirmedAt,
      '2000-01-01T00:00:00.000Z',
    );
    assert.deepEqual(copied.body.memberRoleIds, source.body.memberRoleIds);
    assert.equal(copied.body.memberSettings.developer.label, '主开发');
    assert.equal(copied.body.model, 'team-model');
    assert.equal(copied.body.providerId, 'team-provider');
    assert.equal(copied.body.autonomy.mode, 'assist');
    assert.deepEqual(copied.body.collaboration.allowedTeamIds, []);
    const detail = await request(`teams/${copied.body.id}`);
    assert.equal(detail.body.messages.length, 0);
    assert.equal(detail.body.tasks.length, 0);

    const removed = await request(
      `team-templates/${template.body.id}`,
      undefined,
      'DELETE',
    );
    assert.deepEqual(removed.body, { ok: true });
    const after = await request('team-templates');
    assert.ok(!after.body.some((item) => item.id === template.body.id));
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team timeline exposes an older page without duplicating the latest window', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const team = (await request('teams')).body[0];
    for (let index = 0; index < 125; index += 1) {
      app.store.saveTeamMessage(
        {
          spaceId: team.id,
          teamId: team.id,
          senderType: 'owner',
          senderId: 'owner',
          kind: 'request',
          content: `分页历史消息 ${index}`,
        },
        `timeline-page-${index}`,
      );
    }
    const detail = await request(`teams/${team.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.timeline.length, 120);
    const latestIds = new Set(detail.body.timeline.map((item) => item.id));
    const cursor = encodeURIComponent(
      `${detail.body.timeline[0].at}|${detail.body.timeline[0].id}`,
    );
    const older = await request(
      `teams/${team.id}/timeline?limit=60&before=${cursor}`,
    );
    assert.equal(older.status, 200);
    assert.equal(older.body.items.length, 5);
    assert.equal(older.body.hasMore, false);
    assert.ok(older.body.items.every((item) => !latestIds.has(item.id)));
    assert.deepEqual(
      older.body.items.map((item) => item.content),
      [
        '分页历史消息 0',
        '分页历史消息 1',
        '分页历史消息 2',
        '分页历史消息 3',
        '分页历史消息 4',
      ],
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('cross-team timeline aggregates confirmed teams with labels and cursor pagination', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const source = (await request('teams')).body[0];
    const target = (
      await request(
        'teams',
        {
          name: '跨团队统一时间线研发团队',
          goal: '验证统一时间线可以标记来源团队。',
          memberRoleIds: ['project_manager'],
        },
        'POST',
      )
    ).body;
    const draft = (
      await request(
        'teams',
        {
          name: '跨团队统一时间线草稿团队',
          goal: '不应出现在跨团队统一时间线。',
          recruitment: { phase: 'discovery' },
          memberRoleIds: ['project_manager'],
        },
        'POST',
      )
    ).body;

    const addMessage = (team, content, suffix) =>
      app.store.saveTeamMessage(
        {
          spaceId: team.id,
          teamId: team.id,
          clientMessageId: `cross-team-timeline-${suffix}`,
          kind: 'reply',
          senderType: 'agent',
          senderId: 'project_manager',
          content,
          status: 'sent',
        },
        `cross-team-timeline-${suffix}`,
      );
    addMessage(source, '统一时间线：项目经理已更新运维计划。', 'source-1');
    addMessage(target, '统一时间线：研发团队已完成接口拆分。', 'target-1');
    addMessage(source, '统一时间线：运维团队开始灰度验证。', 'source-2');
    addMessage(draft, '草稿团队消息不应泄漏到统一时间线。', 'draft-1');

    const first = await request('timeline?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.items.every((item) => item.teamId));
    assert.ok(
      first.body.items.every((item) =>
        [source.id, target.id].includes(item.teamId),
      ),
    );
    assert.ok(first.body.items.every((item) => item.teamName));
    assert.ok(first.body.items.some((item) => item.teamId === source.id));
    assert.ok(first.body.items.some((item) => item.teamId === target.id));
    assert.ok(
      first.body.items.every(
        (item) => !/草稿团队消息/.test(item.content || ''),
      ),
    );

    const cursorItem = first.body.items[first.body.items.length - 1];
    const cursor = encodeURIComponent(`${cursorItem.at}|${cursorItem.id}`);
    const second = await request(`timeline?limit=2&before=${cursor}`);
    assert.equal(second.status, 200);
    assert.ok(Array.isArray(second.body.items));
    const firstIds = new Set(first.body.items.map((item) => item.id));
    assert.ok(second.body.items.every((item) => !firstIds.has(item.id)));
    assert.ok(
      second.body.items.every((item) =>
        [source.id, target.id].includes(item.teamId),
      ),
    );
    assert.ok(second.body.items.every((item) => item.teamName));
    assert.ok(second.body.items.some((item) => item.teamId === source.id));

    const filtered = await request(
      `timeline?teamId=${encodeURIComponent(target.id)}&limit=10`,
    );
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.items.length >= 1);
    assert.ok(filtered.body.items.every((item) => item.teamId === target.id));
    assert.ok(
      filtered.body.items.every((item) => item.teamName === target.name),
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team risks aggregate confirmed teams and support team, kind, and cursor filters', async () => {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false });
  seedConfirmedDefaultTeam(app.store);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const source = (await request('teams')).body[0];
    const target = (
      await request(
        'teams',
        {
          name: '风险聚合目标团队',
          goal: '验证跨团队风险过滤。',
          memberRoleIds: ['project_manager'],
        },
        'POST',
      )
    ).body;
    const pending = (
      await request(
        'teams',
        {
          name: '未确认风险团队',
          goal: '不应出现在跨团队风险收件箱。',
          recruitment: { phase: 'discovery' },
        },
        'POST',
      )
    ).body;
    const createRiskTask = (team, status, error) => {
      const task = app.store.createTask({
        role: 'project_manager',
        prompt: `${team.name} 风险任务`,
        workspace: fixture.workspace,
      });
      app.store.records.save(
        'task-meta',
        {
          spaceId: team.id,
          teamId: team.id,
          workspaceMode: 'isolated',
          attachmentIds: [],
        },
        task.id,
      );
      app.store.updateTask(task.id, { status, error });
      return task;
    };
    const sourceTask = createRiskTask(source, 'failed', '源团队执行失败。');
    const targetTask = createRiskTask(target, 'blocked', '目标团队等待处理。');
    createRiskTask(pending, 'failed', '未确认团队失败。');
    app.store.records.save(
      'attention',
      {
        taskId: targetTask.id,
        teamId: target.id,
        status: 'open',
        kind: 'manual-review',
        title: '目标团队需要确认',
        detail: '请确认目标团队的阻塞原因。',
      },
      'risk-attention-target',
    );
    app.store.records.save(
      'attention',
      {
        taskId: sourceTask.id,
        teamId: source.id,
        status: 'resolved',
        kind: 'manual-review',
        title: '已处理事项',
      },
      'risk-attention-resolved',
    );

    const all = await request('risks?limit=20');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 3);
    assert.deepEqual(
      new Set(all.body.items.map((item) => item.teamId)),
      new Set([source.id, target.id]),
    );
    assert.ok(
      all.body.items.some(
        (item) => item.kind === 'execution' && item.taskId === sourceTask.id,
      ),
    );
    assert.ok(
      all.body.items.some(
        (item) => item.kind === 'attention' && item.taskId === targetTask.id,
      ),
    );
    assert.ok(!all.body.items.some((item) => item.teamId === pending.id));

    const targetOnly = await request(
      `risks?teamId=${encodeURIComponent(target.id)}&kind=execution`,
    );
    assert.equal(targetOnly.body.total, 1);
    assert.equal(targetOnly.body.items[0].taskId, targetTask.id);
    const attentionOnly = await request(
      `risks?teamId=${encodeURIComponent(target.id)}&kind=attention`,
    );
    assert.equal(attentionOnly.body.total, 1);
    assert.equal(attentionOnly.body.items[0].title, '目标团队需要确认');

    const firstPage = await request('risks?limit=1');
    assert.equal(firstPage.body.items.length, 1);
    assert.equal(firstPage.body.hasMore, true);
    const first = firstPage.body.items[0];
    const secondPage = await request(
      `risks?limit=1&before=${encodeURIComponent(`${first.updatedAt}|${first.id}`)}`,
    );
    assert.equal(secondPage.body.items.length, 1);
    assert.notEqual(secondPage.body.items[0].id, first.id);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
