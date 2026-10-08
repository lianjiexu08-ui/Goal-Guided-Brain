import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';
import { createWorkbench } from '../server/index.mjs';
import { sandbox, tick, waitFor } from './helpers/team-helpers.mjs';

void test('team sessions cannot be reused across teams', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) {
        this.prompt = prompt;
        runs.push(this);
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
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
    const source = (await request('teams')).body[0];
    const target = (
      await request(
        'teams',
        {
          name: '会话隔离目标团队',
          goal: '验证团队会话不会跨空间复用。',
          memberRoleIds: ['project_manager'],
        },
        'POST',
      )
    ).body;
    const sourceMessage = await request(
      `teams/${source.id}/messages`,
      {
        clientMessageId: 'session-scope-source',
        content: '源团队上下文，只能留在源团队。',
      },
      'POST',
    );
    assert.equal(sourceMessage.status, 201);
    await tick();

    const rejected = await request(
      'tasks',
      {
        role: 'project_manager',
        teamId: target.id,
        spaceId: target.id,
        sessionId: sourceMessage.body.sessionId,
        prompt: '不应读取源团队上下文。',
      },
      'POST',
    );
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /另一个团队/);

    const targetDetail = await request(`teams/${target.id}`);
    assert.equal(targetDetail.body.tasks.length, 0);
    assert.equal(targetDetail.body.messages.length, 0);

    const sameTeam = await request(
      'tasks',
      {
        role: 'project_manager',
        teamId: source.id,
        spaceId: source.id,
        sessionId: sourceMessage.body.sessionId,
        prompt: '在源团队继续推进。',
      },
      'POST',
    );
    assert.equal(sameTeam.status, 201);
    const sourceDetail = await request(`teams/${source.id}`);
    assert.equal(sourceDetail.body.tasks.length, 2);
    assert.ok(
      sourceDetail.body.tasks.some(
        (task) => task.prompt === '在源团队继续推进。',
      ),
    );
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('team task handoff keeps the receiving task in the same team', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) {
        this.prompt = prompt;
        runs.push(this);
      },
      cancel() {
        options.onDone('cancelled', '');
      },
      complete(result = '已完成') {
        options.onResult(result);
        options.onDone('completed', '');
      },
    }),
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
    const team = (
      await request(
        'teams',
        {
          name: '团队交接验证组',
          goal: '验证团队内的项目经理可以把任务交给开发成员。',
          memberRoleIds: ['project_manager', 'developer'],
        },
        'POST',
      )
    ).body;
    const source = await request(
      'tasks',
      {
        role: 'project_manager',
        teamId: team.id,
        spaceId: team.id,
        prompt: '先整理团队交付方案。',
      },
      'POST',
    );
    assert.equal(source.status, 201);
    await waitFor(
      () => runs.length === 1,
      '目标团队协作任务没有在测试窗口内启动。',
    );
    runs[0].complete('交付方案已整理。');
    await tick();

    const handoff = await request(
      `tasks/${source.body.id}/handoff`,
      {
        role: 'developer',
        note: '请根据这份方案实现并运行测试。',
      },
      'POST',
    );
    assert.equal(handoff.status, 201);
    await tick();
    const detail = await request(`teams/${team.id}`);
    const received = detail.body.tasks.find(
      (task) => task.id === handoff.body.id,
    );
    assert.ok(received);
    assert.equal(received.teamId, team.id);
    assert.equal(received.role, 'developer');
    assert.equal(received.sourceTaskId, source.body.id);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('multiple Chat teams keep independent ownership and can hand work to another team', async () => {
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
    const existing = await request('teams');
    const source = existing.body[0];
    const created = await request(
      'teams',
      {
        name: '运维团队',
        goal: '长期维护线上项目和发布稳定性。',
        purpose: '负责监控、故障处理和发布保障。',
        teamType: 'operations',
        memberRoleIds: ['project_manager', 'assistant'],
        collaboration: { enabled: true, allowedTeamIds: [], autoHandoff: true },
      },
      'POST',
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.teamType, 'operations');
    assert.equal(created.body.chatId, created.body.id);
    assert.equal(created.body.collaboration.enabled, true);
    assert.deepEqual(created.body.collaboration.allowedTeamIds, []);

    const renamed = await request(
      `teams/${created.body.id}`,
      {
        name: '运维与发布团队',
      },
      'PUT',
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.id, created.body.id);
    assert.equal(renamed.body.name, '运维与发布团队');
    const listedAfterRename = await request('teams');
    assert.equal(
      listedAfterRename.body.find((team) => team.id === created.body.id).name,
      '运维与发布团队',
    );
    const invalidRename = await request(
      `teams/${created.body.id}`,
      {
        name: '   ',
      },
      'PUT',
    );
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

    const future = await request(
      'teams',
      {
        name: '后续项目团队',
        goal: '承接后续专项开发任务。',
        collaboration: { enabled: true, allowedTeamIds: [] },
      },
      'POST',
    );
    assert.equal(future.status, 201);
    const futureCollaborators = await request(
      `teams/${created.body.id}/collaborators`,
    );
    assert.ok(
      futureCollaborators.body.some((item) => item.id === future.body.id),
    );

    const closed = await request(
      'teams',
      {
        name: '封闭团队',
        goal: '仅处理本团队内部任务。',
        collaboration: { enabled: false, allowedTeamIds: [] },
      },
      'POST',
    );
    assert.equal(closed.status, 201);
    assert.deepEqual(
      (await request(`teams/${closed.body.id}/collaborators`)).body,
      [],
    );
    const disabled = await request(
      `teams/${closed.body.id}/collaborate`,
      {
        targetTeamId: source.id,
        clientMessageId: 'closed-1',
        content: '不应发送跨团队请求。',
      },
      'POST',
    );
    assert.equal(disabled.status, 409);
    assert.match(disabled.body.error, /未启用跨团队协作/);

    const waiting = await request(
      'teams',
      {
        name: '待确认团队',
        goal: '尚未完成招募的团队。',
        recruitment: { phase: 'discovery' },
      },
      'POST',
    );
    const visibleCollaborators = await request(
      `teams/${source.id}/collaborators`,
    );
    assert.ok(
      visibleCollaborators.body.some((item) => item.id === created.body.id),
    );
    assert.ok(
      !visibleCollaborators.body.some((item) => item.id === waiting.body.id),
    );
    const blocked = await request(
      `teams/${source.id}/collaborate`,
      {
        targetTeamId: waiting.body.id,
        clientMessageId: 'waiting-1',
        content: '请在确认前接收这条请求。',
      },
      'POST',
    );
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /尚未完成招募/);
    const blockedSource = await request(
      `teams/${waiting.body.id}/collaborate`,
      {
        targetTeamId: source.id,
        clientMessageId: 'waiting-source-1',
        content: '待确认团队不应发起协作。',
      },
      'POST',
    );
    assert.equal(blockedSource.status, 409);
    assert.match(blockedSource.body.error, /尚未完成招募/);
    assert.deepEqual(
      (await request(`teams/${waiting.body.id}/collaborators`)).body,
      [],
    );

    const collaborationAcceptance = '回传发布检查项、风险等级和回滚步骤。';
    const delegated = await request(
      `teams/${source.id}/collaborate`,
      {
        targetTeamId: created.body.id,
        clientMessageId: 'ops-1',
        content: '请建立本项目的发布检查和运行监控清单。',
        acceptance: collaborationAcceptance,
      },
      'POST',
    );
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.sourceTeamId, source.id);
    assert.equal(delegated.body.targetTeamId, created.body.id);
    assert.ok(delegated.body.taskId);
    assert.equal(
      app.store.taskDelivery(app.store.task(delegated.body.taskId))
        .acceptanceCriteria,
      collaborationAcceptance,
    );
    await waitFor(
      () => runs.length === 1,
      '跨团队编排消息对应的项目经理任务没有在测试窗口内启动。',
    );
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
    assert.equal(
      app.platform.control.records.remove('space-messages', sourceTraceId),
      true,
    );
    const retried = await request(
      `teams/${source.id}/collaborate`,
      {
        targetTeamId: created.body.id,
        clientMessageId: 'ops-1',
        content: '请建立本项目的发布检查和运行监控清单。',
      },
      'POST',
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.body.taskId, delegated.body.taskId);
    assert.equal(retried.body.sourceMessageId, sourceTraceId);
    const restoredSource = app.platform.control.records.get(
      'space-messages',
      sourceTraceId,
    );
    assert.equal(restoredSource.relatedMessageId, detail.body.messages[0].id);
    assert.equal(restoredSource.taskId, delegated.body.taskId);
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

void test('twenty alternating messages keep two confirmed teams, models, and tasks isolated', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start() {
        runs.push(this);
      },
      cancel() {
        options.onDone('cancelled', '');
      },
      complete() {
        options.onResult('本地 fixture 回复');
        options.onDone('completed', '');
      },
    }),
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
    const target = (
      await request(
        'teams',
        {
          name: '连续切换验收团队',
          goal: '验证连续切换时上下文和任务归属不串线。',
          memberRoleIds: ['project_manager', 'assistant'],
        },
        'POST',
      )
    ).body;
    for (const [teamId, model] of [
      [source.id, 'team-alpha-model'],
      [target.id, 'team-beta-model'],
    ]) {
      const configured = await request(
        `teams/${teamId}`,
        { model, providerId: provider.id },
        'PUT',
      );
      assert.equal(configured.status, 200);
      assert.equal(configured.body.model, model);
      assert.equal(configured.body.providerId, provider.id);
    }
    const expected = new Map([
      [source.id, 'team-alpha-model'],
      [target.id, 'team-beta-model'],
    ]);
    for (let index = 0; index < 20; index += 1) {
      const team = index % 2 === 0 ? source : target;
      const model = expected.get(team.id);
      const content = `隔离压力消息 ${index} (${team.id})`;
      const sent = await request(
        `teams/${team.id}/messages`,
        {
          clientMessageId: `isolation-${index}`,
          content,
          model,
          providerId: provider.id,
        },
        'POST',
      );
      assert.equal(sent.status, 201);
      assert.ok(sent.body.taskId);
      await waitFor(
        () => runs.length === index + 1,
        `第 ${index + 1} 次切换未启动任务`,
      );
      const run = runs[index];
      const meta = app.platform.control.records.get(
        'task-meta',
        run.options.task.id,
      );
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
      const own = detail.body.messages.filter((message) =>
        message.content?.startsWith('隔离压力消息'),
      );
      assert.equal(own.length, 10);
      assert.ok(
        own.every((message) => message.content.includes(`(${team.id})`)),
      );
      assert.equal(detail.body.tasks.length, 10);
      assert.ok(detail.body.tasks.every((task) => task.teamId === team.id));
    }
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
