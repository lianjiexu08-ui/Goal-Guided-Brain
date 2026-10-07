import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, pair } from './helpers/control-helpers.mjs';

test('open attention creates one durable notification without resurrecting a read item', (t) => {
  const { control, store } = setup(t);
  const first = control.attention(
    {
      taskId: 'task-1',
      kind: 'execution',
      title: '任务需要检查',
      detail: '执行节点失联。',
    },
    'task-1-offline',
  );
  assert.equal(first.status, 'open');
  const notificationId = 'attention:task-1-offline';
  const notification = store.records.get('notifications', notificationId);
  assert.equal(notification.name, '任务需要检查');
  assert.equal(notification.message, '执行节点失联。');
  assert.equal(notification.attentionId, 'task-1-offline');
  assert.equal(notification.read, false);

  store.records.save(
    'notifications',
    { ...notification, read: true, readAt: '2026-09-30T00:00:00.000Z' },
    notificationId,
  );
  control.attention(
    {
      taskId: 'task-1',
      kind: 'execution',
      title: '任务需要检查',
      detail: '节点仍未恢复。',
    },
    'task-1-offline',
  );
  assert.equal(store.records.list('notifications').length, 1);
  const updated = store.records.get('notifications', notificationId);
  assert.equal(updated.message, '节点仍未恢复。');
  assert.equal(updated.read, true);
  assert.equal(updated.readAt, '2026-09-30T00:00:00.000Z');
});

test('pair codes are single use, node tokens are hashed and revoked nodes cannot claim', async (t) => {
  const { store, request } = setup(t);
  const paired = await pair(request);
  assert.equal(
    (
      await request('nodes/pair', {
        code: paired.code,
        name: 'Duplicate',
        workspaces: ['default'],
      })
    ).status,
    401,
  );
  assert.equal(
    JSON.stringify(store.records.list('nodes')).includes(paired.token),
    false,
  );
  const list = await request('nodes', {}, undefined, 'GET');
  assert.equal(JSON.stringify(list.body).includes('tokenHash'), false);
  await request(`nodes/${paired.node.id}/revoke`);
  assert.equal((await request('nodes/claim', {}, paired.token)).status, 401);
});

test('node list and detail expose the same live status and active executions', async (t) => {
  const { control, request, advance } = setup(t);
  const paired = await pair(request);
  const job = control.createJob({
    role: 'developer',
    prompt: 'Inspect node lifecycle',
    nodeId: paired.node.id,
  });
  await request('nodes/claim', {}, paired.token);

  const listed = await request('nodes', {}, undefined, 'GET');
  const listedNode = listed.body.items.find(
    (node) => node.id === paired.node.id,
  );
  assert.equal(listedNode.status, 'online');
  assert.equal(listedNode.activeExecutions[0].taskId, job.taskId);
  assert.equal(Object.hasOwn(listedNode, 'tokenHash'), false);

  const detail = await request(`nodes/${paired.node.id}`, {}, undefined, 'GET');
  assert.equal(detail.body.status, listedNode.status);
  assert.deepEqual(detail.body.activeExecutions, listedNode.activeExecutions);

  advance(61000);
  const offline = await request(
    `nodes/${paired.node.id}`,
    {},
    undefined,
    'GET',
  );
  assert.equal(offline.body.status, 'offline');
  assert.equal(offline.body.activeExecutions[0].taskId, job.taskId);

  await request(`nodes/${paired.node.id}/revoke`);
  const revoked = await request(
    `nodes/${paired.node.id}`,
    {},
    undefined,
    'GET',
  );
  assert.equal(revoked.body.status, 'revoked');
  assert.equal(Object.hasOwn(revoked.body, 'tokenHash'), false);
});

test('node liveness transitions create deduplicated notifications and recover on heartbeat', async (t) => {
  const { control, store, request, advance } = setup(t);
  const paired = await pair(request);
  advance(61000);

  const first = control.reconcileNodes();
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'offline');
  const offline = store.records.get('nodes', paired.node.id);
  assert.equal(offline.status, 'offline');
  assert.equal(offline.offlineSince, 1061000);
  const attentionId = `node:${paired.node.id}:offline`;
  const attention = store.records.get('attention', attentionId);
  assert.equal(attention.kind, 'node-offline');
  assert.equal(attention.status, 'open');
  const notification = store.records.get(
    'notifications',
    `attention:${attentionId}`,
  );
  assert.equal(notification.read, false);
  assert.equal(store.records.list('attention').length, 1);
  assert.equal(control.reconcileNodes().length, 0);
  assert.equal(store.records.list('notifications').length, 1);

  await request('nodes/heartbeat', { executions: [] }, paired.token);
  const recovered = store.records.get('nodes', paired.node.id);
  assert.equal(recovered.status, 'online');
  assert.equal(recovered.offlineSince, null);
  assert.equal(recovered.recoveredAt, 1061000);
  assert.equal(store.records.get('attention', attentionId).status, 'resolved');
  const resolvedNotification = store.records.get(
    'notifications',
    `attention:${attentionId}`,
  );
  assert.equal(resolvedNotification.read, true);
  assert.ok(resolvedNotification.readAt);

  advance(61000);
  control.reconcileNodes();
  assert.equal(store.records.get('attention', attentionId).status, 'open');
  assert.equal(
    store.records.get('notifications', `attention:${attentionId}`).read,
    false,
  );
  assert.equal(store.records.list('notifications').length, 1);
});

test('remote leases claim once, reject wrong nodes, accept a result exactly once and reject late results', async (t) => {
  const { store, request, control, advance } = setup(t);
  const first = await pair(request),
    other = await pair(request);
  const job = control.createJob({
    role: 'developer',
    prompt: 'Inspect code',
    nodeId: first.node.id,
  });
  const response = await request('nodes/claim', {}, first.token);
  const assignment = response.body.assignment;
  assert.equal(assignment.task.id, job.taskId);
  assert.equal(
    (await request('nodes/claim', {}, first.token)).body.assignment,
    null,
  );
  const report = {
    taskId: job.taskId,
    epoch: 1,
    eventId: 'result-1',
    status: 'completed',
    result: 'done',
  };
  assert.equal(
    (await request('nodes/report', report, other.token)).status,
    403,
  );
  assert.equal(
    (await request('nodes/report', report, first.token)).body.duplicate,
    false,
  );
  assert.equal(
    (await request('nodes/report', report, first.token)).body.duplicate,
    true,
  );
  assert.equal(store.task(job.taskId).result, 'done');
  const expired = control.createJob({
    role: 'assistant',
    prompt: 'More work',
    nodeId: first.node.id,
  });
  await request('nodes/claim', {}, first.token);
  advance(61000);
  control.reconcile();
  assert.equal(store.task(expired.taskId).status, 'state_unknown');
  assert.equal(
    (
      await request(
        'nodes/report',
        { ...report, taskId: expired.taskId },
        first.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request('nodes/claim', {}, first.token)).body.assignment,
    null,
  );
});

test('remote event receipts deduplicate tool activity before the completion hook runs', async (t) => {
  const { store, control, request } = setup(t);
  const paired = await pair(request);
  const job = control.createJob({
    role: 'developer',
    prompt: 'Remote tool',
    nodeId: paired.node.id,
  });
  await request('nodes/claim', {}, paired.token);
  let events = 0,
    completions = 0;
  control.onEvent = () => {
    events++;
  };
  control.onRemoteDone = (task) => {
    completions++;
    assert.equal(store.records.get('task-meta', task.id).toolActivity, true);
  };
  const event = {
    taskId: job.taskId,
    epoch: 1,
    kind: 'event',
    eventId: 'tool1',
    event: { type: 'tool/call', data: { name: 'read_file' } },
  };
  assert.equal(
    (await request('nodes/report', event, paired.token)).body.duplicate,
    false,
  );
  assert.equal(
    (await request('nodes/report', event, paired.token)).body.duplicate,
    true,
  );
  const result = {
    taskId: job.taskId,
    epoch: 1,
    status: 'completed',
    eventId: 'final',
    result: 'done',
  };
  await request('nodes/report', result, paired.token);
  await request('nodes/report', result, paired.token);
  assert.equal(events, 1);
  assert.equal(completions, 1);
});

test('child budgets inherit group limits and exhausted groups cannot claim new work', (t) => {
  const { store, control } = setup(t);
  const parent = control.createJob({
    role: 'product',
    prompt: 'Budgeted project',
    budgetTokens: 5000,
    maxDurationMinutes: 10,
  });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob(
    { role: 'developer', prompt: 'Implement', budgetTokens: 500000 },
    control.validateInstanceToken(claimed.token),
  );
  assert.equal(child.budgetTokens, 5000);
  assert.equal(child.maxDurationMinutes, 10);
  store.records.save(
    'jobs',
    { ...store.records.get('jobs', parent.id), status: 'budget-exceeded' },
    parent.id,
  );
  assert.equal(control.eligible(store.task(child.taskId), 'local'), false);
  assert.equal(control.claimLocal(store.task(child.taskId)), null);
});

test('paused team blocks new jobs and local claims until autonomy resumes', (t) => {
  const { store, control } = setup(t);
  const team = store.saveTeamSpace({
    name: '自治暂停回归团队',
    goal: '验证团队暂停会阻止新任务。',
    workspace: store.config.workspace,
    pmRoleId: 'developer',
    memberRoleIds: ['developer'],
    recruitment: { phase: 'confirmed' },
  });
  const job = control.createJob({
    role: team.pmRoleId,
    prompt: '团队自治暂停回归',
    teamId: team.id,
  });
  const task = store.task(job.taskId);
  assert.equal(control.eligible(task, 'local'), true);

  const paused = control.setTeamStatus(team.id, 'paused');
  assert.equal(paused.status, 'paused');
  assert.equal(control.eligible(task, 'local'), false);
  assert.equal(control.claimLocal(task), null);
  assert.throws(
    () =>
      control.createJob({
        role: team.pmRoleId,
        prompt: '暂停期间不应创建',
        teamId: team.id,
      }),
    /自治已暂停/,
  );

  const resumed = control.setTeamStatus(team.id, 'active');
  assert.equal(resumed.status, 'active');
  assert.equal(control.eligible(task, 'local'), true);
});

test('team autonomy limits cap active jobs and nested task depth', (t) => {
  const { store, control } = setup(t);
  const jobsTeam = store.saveTeamSpace({
    name: '任务上限回归团队',
    goal: '验证团队活跃任务限额。',
    workspace: store.config.workspace,
    pmRoleId: 'developer',
    memberRoleIds: ['developer'],
    recruitment: { phase: 'confirmed' },
    autonomy: { mode: 'auto', maxDepth: 4, maxJobs: 1, budgetTokens: 50000 },
  });
  const first = control.createJob({
    role: 'developer',
    prompt: '第一个任务',
    teamId: jobsTeam.id,
  });
  assert.throws(
    () =>
      control.createJob({
        role: 'developer',
        prompt: '超过上限的任务',
        teamId: jobsTeam.id,
      }),
    /自治任务上限/,
  );
  const execution = control.claimLocal(store.task(first.taskId));
  control.finishLocal(first.taskId, execution.execution.epoch, {
    status: 'completed',
    result: 'done',
  });
  assert.doesNotThrow(() =>
    control.createJob({
      role: 'developer',
      prompt: '释放限额后的任务',
      teamId: jobsTeam.id,
    }),
  );

  const depthTeam = store.saveTeamSpace({
    name: '拆解层级回归团队',
    goal: '验证团队任务拆解层级。',
    workspace: store.config.workspace,
    pmRoleId: 'developer',
    memberRoleIds: ['developer'],
    recruitment: { phase: 'confirmed' },
    autonomy: { mode: 'auto', maxDepth: 1, maxJobs: 8, budgetTokens: 50000 },
  });
  const root = control.createJob({
    role: 'developer',
    prompt: '根任务',
    teamId: depthTeam.id,
  });
  const rootExecution = control.claimLocal(store.task(root.taskId));
  const child = control.createJob(
    { role: 'developer', prompt: '允许的一层子任务' },
    control.validateInstanceToken(rootExecution.token),
  );
  const childExecution = control.claimLocal(store.task(child.taskId));
  assert.throws(
    () =>
      control.createJob(
        { role: 'developer', prompt: '超出团队层级的任务' },
        control.validateInstanceToken(childExecution.token),
      ),
    /最多允许 1 层任务拆解/,
  );
});

test('owner budget increase pauses an exhausted group until explicit resume and propagates limits', async (t) => {
  const { store, control, request } = setup(t);
  const parent = control.createJob({
    role: 'product',
    prompt: 'Budgeted project',
    budgetTokens: 1000,
  });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob(
    { role: 'developer', prompt: 'Implement' },
    control.validateInstanceToken(claimed.token),
  );
  for (const job of [parent, child])
    store.records.save(
      'jobs',
      {
        ...store.records.get('jobs', job.id),
        status: 'budget-exceeded',
        budgetExceeded: true,
      },
      job.id,
    );
  store.records.save('usage', {
    taskId: parent.taskId,
    groupId: parent.groupId,
    totalTokens: 1200,
  });
  const before = store.tasks().length;
  assert.equal(
    (
      await request(
        `jobs/${parent.id}`,
        { budgetTokens: 3000, maxDurationMinutes: 15 },
        undefined,
        'PUT',
      )
    ).status,
    200,
  );
  for (const job of [parent, child]) {
    const updated = store.records.get('jobs', job.id);
    assert.equal(updated.budgetTokens, 3000);
    assert.equal(updated.maxDurationMinutes, 15);
    assert.equal(updated.budgetExceeded, false);
    assert.equal(updated.status, 'paused');
  }
  assert.equal(store.tasks().length, before);
  assert.equal(
    (
      await request(
        `jobs/${child.id}`,
        { budgetTokens: 5000 },
        undefined,
        'PUT',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `jobs/${parent.id}`,
        { budgetTokens: 999 },
        undefined,
        'PUT',
      )
    ).status,
    400,
  );
});

test('workflow dependencies follow the latest successful attempt after a failed provider attempt', (t) => {
  const { store, control } = setup(t);
  const dependency = control.createJob({
    role: 'assistant',
    prompt: 'Research',
  });
  control.claimLocal(store.task(dependency.taskId));
  control.finishLocal(dependency.taskId, 1, { status: 'failed', error: '401' });
  const next = control.createJob({ role: 'developer', prompt: 'Implement' });
  store.records.save(
    'task-meta',
    {
      ...store.records.get('task-meta', next.taskId),
      dependencies: [dependency.taskId],
    },
    next.taskId,
  );
  assert.equal(control.eligible(store.task(next.taskId), 'local'), false);
  const retry = store.createTask({
    role: 'assistant',
    prompt: 'Research',
    sourceTaskId: dependency.taskId,
  });
  store.records.save(
    'task-meta',
    { jobId: dependency.id, groupId: dependency.groupId },
    retry.id,
  );
  store.records.save(
    'jobs',
    {
      ...store.records.get('jobs', dependency.id),
      taskId: retry.id,
      status: 'queued',
    },
    dependency.id,
  );
  control.claimLocal(retry);
  control.finishLocal(retry.id, 1, {
    status: 'completed',
    result: 'Research ready',
  });
  assert.equal(control.eligible(store.task(next.taskId), 'local'), true);
  assert.ok(control.claimLocal(store.task(next.taskId)));
});

test('successful child retry clears only automatic child-failure blocking and schedules parent summary', async (t) => {
  const { store, control, request } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Deliver' });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob(
    { role: 'developer', prompt: 'Implement' },
    control.validateInstanceToken(claimed.token),
  );
  control.claimLocal(store.task(child.taskId));
  control.finishLocal(parent.taskId, 1, {
    status: 'completed',
    result: 'Delegated',
  });
  control.finishLocal(child.taskId, 1, {
    status: 'failed',
    error: 'Provider unavailable',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'blocked');
  const retry = await request(`jobs/${child.id}/retry`);
  control.claimLocal(store.task(retry.body.taskId));
  control.finishLocal(retry.body.taskId, 1, {
    status: 'completed',
    result: 'Implementation ready',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'queued');
  assert.ok(store.records.get('jobs', parent.id).summaryTaskId);
  assert.equal(
    store.records.get('attention', `children:${parent.id}`).status,
    'resolved',
  );
});

test('resume uses a new isolated attempt and retains the requested route and frozen assistant', async (t) => {
  const { store, control, request } = setup(t);
  const job = control.createJob({ role: 'assistant', prompt: 'Research' });
  const snapshot = store.role('assistant');
  store.records.save(
    'task-meta',
    {
      ...store.records.get('task-meta', job.taskId),
      allowedProviderIds: ['provider-one'],
      assistantSnapshot: snapshot,
    },
    job.taskId,
  );
  store.records.save(
    'jobs',
    { ...job, status: 'paused', requirementVersion: 3 },
    job.id,
  );
  let received;
  control.createTask = (input) => {
    received = input;
    return store.createTask(input);
  };
  assert.equal(
    (await request(`jobs/${job.id}/resume`, { providerIds: ['provider-two'] }))
      .status,
    201,
  );
  assert.equal(received.workspaceMode, 'isolated');
  assert.deepEqual(received.providerIds, ['provider-two']);
  assert.equal(received.requirementVersion, 3);
  assert.deepEqual(received.assistantSnapshot, snapshot);
});

test('instance inbox is scoped, idempotent and survives reconnection without exposing another group', async (t) => {
  const { control, store } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Plan' });
  const parentClaim = control.claimLocal(store.task(parent.taskId));
  const sender = control.validateInstanceToken(parentClaim.token);
  const child = control.createJob(
    { role: 'developer', prompt: 'Implement', permissions: ['deploy'] },
    sender,
  );
  const childClaim = control.claimLocal(store.task(child.taskId));
  const receiver = control.validateInstanceToken(childClaim.token);
  assert.deepEqual(receiver.permissions, []);
  const body = {
    toTaskId: child.taskId,
    content: 'Use version one',
    idempotencyKey: 'contract-1',
    kind: 'notice',
  };
  const message = control.sendMessage(body, sender);
  assert.equal(control.sendMessage(body, sender).id, message.id);
  assert.throws(
    () =>
      control.sendMessage({ ...body, content: 'Different content' }, sender),
    /幂等键/,
  );
  assert.equal(
    control.readMessages(child.taskId, receiver)[0].status,
    'received',
  );
  assert.throws(() => control.readMessages(child.taskId, sender), /自己的/);
  assert.equal(
    control.acknowledge(message.id, { status: 'processed' }, receiver).status,
    'processed',
  );
  assert.equal(
    control.acknowledge(message.id, { status: 'received' }, receiver).status,
    'processed',
  );
  const outside = control.createJob({
    role: 'assistant',
    prompt: 'Private task',
  });
  assert.throws(
    () => control.sendMessage({ ...body, toTaskId: outside.taskId }, sender),
    /其他任务组/,
  );
  control.revokeExecution(parent.taskId);
  assert.throws(() => control.validateInstanceToken(parentClaim.token), /撤销/);
});

test('stable assistant mailbox waits for a new instance without waking an archived assistant', (t) => {
  const { control, store } = setup(t);
  store.archiveRole('assistant', true);
  const message = control.sendMessage(
    { toAgentId: 'assistant', content: 'For the next run' },
    { type: 'owner' },
  );
  assert.equal(message.toTaskId, null);
  assert.equal(store.tasks().length, 0);
  store.archiveRole('assistant', false);
  const job = control.createJob({ role: 'assistant', prompt: 'Continue' });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  assert.equal(control.readMessages(job.taskId, principal)[0].id, message.id);
});

test('shared board detects concurrent edits and external operation grants cannot be escalated', async (t) => {
  const { control, store } = setup(t);
  const job = control.createJob({
    role: 'developer',
    prompt: 'Implement',
    permissions: ['push'],
  });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  const board = control.saveScoped(
    'board',
    { title: 'Contract', content: 'v1' },
    principal,
  );
  control.saveScoped(
    'board',
    { title: 'Contract', content: 'v2', expectedRevision: board.revision },
    principal,
    board.id,
  );
  assert.throws(
    () =>
      control.saveScoped(
        'board',
        { title: 'Contract', content: 'v3', expectedRevision: board.revision },
        principal,
        board.id,
      ),
    /已更新/,
  );
  assert.throws(
    () =>
      control.operation(
        { action: 'deploy', idempotencyKey: 'deploy1', intent: 'production' },
        principal,
      ),
    /没有/,
  );
  const operation = {
    action: 'push',
    idempotencyKey: 'push1',
    intent: 'review branch',
  };
  const started = control.operation(operation, principal);
  assert.equal(started.canExecute, true);
  assert.equal(control.operation(operation, principal).canExecute, false);
  await control.handle({
    method: 'POST',
    parts: ['operations', started.id, 'result'],
    principal,
    body: {
      status: 'unknown',
      evidence: 'Connection dropped after submission',
    },
  });
  assert.equal(control.operation(operation, principal).status, 'unknown');
  assert.equal(control.operation(operation, principal).canExecute, false);
});

test('parent waits for children and enqueues one summary attempt after all children complete', (t) => {
  const { control, store } = setup(t);
  const parent = control.createJob({
    role: 'product',
    prompt: 'Deliver feature',
  });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const principal = control.validateInstanceToken(claimed.token);
  const one = control.createJob(
    { role: 'developer', prompt: 'Backend' },
    principal,
  );
  const two = control.createJob(
    { role: 'assistant', prompt: 'Review' },
    principal,
  );
  control.claimLocal(store.task(one.taskId));
  control.claimLocal(store.task(two.taskId));
  control.finishLocal(parent.taskId, 1, {
    status: 'completed',
    result: 'Delegated',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'waiting_children');
  control.finishLocal(one.taskId, 1, {
    status: 'completed',
    result: 'Backend ready',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'waiting_children');
  control.finishLocal(two.taskId, 1, {
    status: 'completed',
    result: 'Review ready',
  });
  const summary = store.records.get('jobs', parent.id);
  assert.notEqual(summary.taskId, parent.taskId);
  assert.equal(summary.taskId, summary.summaryTaskId);
  const summaryClaim = control.claimLocal(store.task(summary.taskId));
  assert.throws(
    () =>
      control.createJob(
        { role: 'developer', prompt: 'Infinite loop' },
        control.validateInstanceToken(summaryClaim.token),
      ),
    /汇总/,
  );
  control.finishLocal(summary.taskId, 1, {
    status: 'completed',
    result: 'Verified delivery',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'completed');
  assert.equal(store.tasks().length, 4);
});

test('paused team defers parent summary until autonomy resumes', (t) => {
  const { store, control } = setup(t);
  const team = store.saveTeamSpace({
    name: '自治汇总暂停团队',
    goal: '验证暂停期间不创建新的汇总执行。',
    workspace: store.config.workspace,
    pmRoleId: 'product',
    memberRoleIds: ['product', 'developer', 'assistant'],
    recruitment: { phase: 'confirmed' },
  });
  const parent = control.createJob({
    role: 'product',
    prompt: '暂停期间等待汇总',
    teamId: team.id,
  });
  const parentClaim = control.claimLocal(store.task(parent.taskId));
  const principal = control.validateInstanceToken(parentClaim.token);
  const child = control.createJob(
    { role: 'developer', prompt: '完成子任务' },
    principal,
  );
  control.claimLocal(store.task(child.taskId));
  control.finishLocal(parent.taskId, 1, {
    status: 'completed',
    result: '已分派',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'waiting_children');

  control.setTeamStatus(team.id, 'paused');
  control.finishLocal(child.taskId, 1, {
    status: 'completed',
    result: '子任务已完成',
  });
  assert.equal(store.records.get('jobs', parent.id).status, 'paused');
  assert.equal(
    store.records.get('jobs', parent.id).blockedReason,
    'team-paused',
  );
  assert.equal(store.records.get('jobs', parent.id).summaryTaskId, undefined);

  control.setTeamStatus(team.id, 'active');
  const resumed = store.records.get('jobs', parent.id);
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.summaryTaskId, resumed.taskId);
});

test('pause revokes descendants and resume creates a new instance preserving checkpoint context', async (t) => {
  const { control, store, request } = setup(t);
  const job = control.createJob({ role: 'developer', prompt: 'Implement' });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  const child = control.createJob(
    { role: 'assistant', prompt: 'Research' },
    principal,
  );
  const childClaim = control.claimLocal(store.task(child.taskId));
  control.saveScoped(
    'checkpoints',
    { title: 'Halfway', content: 'Tests remain', nextSteps: ['Test'] },
    principal,
  );
  assert.equal((await request(`jobs/${job.id}/pause`)).status, 200);
  assert.throws(() => control.validateInstanceToken(childClaim.token), /撤销/);
  const resumed = await request(`jobs/${job.id}/resume`);
  assert.equal(resumed.status, 201);
  assert.notEqual(resumed.body.taskId, job.taskId);
  assert.equal(store.task(resumed.body.taskId).sourceTaskId, job.taskId);
});

test('requirement changes notify the whole group and older artifacts stay marked until the agent acknowledges', async (t) => {
  const { control, store, request } = setup(t);
  const job = control.createJob({ role: 'product', prompt: 'Version one' });
  const parent = control.claimLocal(store.task(job.taskId));
  const child = control.createJob(
    { role: 'developer', prompt: 'Implementation' },
    control.validateInstanceToken(parent.token),
  );
  const claimed = control.claimLocal(store.task(child.taskId));
  store.records.save(
    'task-acceptance',
    {
      taskId: child.taskId,
      groupId: job.groupId,
      decision: 'accepted',
      status: 'active',
      requirementVersion: 1,
    },
    child.taskId,
  );
  await request(`jobs/${job.id}`, { goal: 'Version two' }, undefined, 'PUT');
  let principal = control.validateInstanceToken(claimed.token);
  assert.equal(principal.requirementVersion, 1);
  assert.equal(store.records.get('jobs', child.id).requirementVersion, 2);
  assert.equal(
    store.records.get('task-acceptance', child.taskId).status,
    'stale',
  );
  const artifact = control.saveScoped(
    'artifacts',
    { title: 'Old result', location: 'output.md', evidence: 'Tested v1' },
    principal,
  );
  assert.equal(artifact.status, 'needs-review');
  const inbox = control.readMessages(child.taskId, principal);
  const update = inbox.find((message) => message.requirementUpdate);
  assert.equal(update.requirementVersion, 2);
  control.acknowledge(update.id, { status: 'processed' }, principal);
  principal = control.validateInstanceToken(claimed.token);
  assert.equal(principal.requirementVersion, 2);
  const current = control.saveScoped(
    'artifacts',
    {
      title: 'Current result',
      location: 'output-v2.md',
      evidence: 'Tested v2',
    },
    principal,
  );
  assert.equal(current.status, 'submitted');
});
