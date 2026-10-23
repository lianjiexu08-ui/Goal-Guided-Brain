import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autonomous-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'data'), workspace, { seedProjectManager: true });
  const time = 1000000;
  const control = new ControlPlane({ store, now: () => time, ...options });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, control, directory, workspace };
}

// 建立一个团队与其项目经理实例 principal。phase 控制招募阶段（招募测试用 'discovery'）。
function confirmedTeam(t, options = {}, phase = 'confirmed') {
  const fixture = setup(t, options);
  const { store, control } = fixture;
  const created = store.saveTeamSpace({
    name: '自治团队', goal: '自动招募并交付。', purpose: '验证自治招募。',
    workspace: fixture.workspace, pmRoleId: 'project_manager',
  });
  // 先以已确认团队创建项目经理实例（createJob 要求团队已确认），再切到目标招募阶段。
  const job = control.createJob({ role: created.pmRoleId, prompt: '组建团队', teamId: created.id, spaceId: created.id });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  const team = phase === 'confirmed'
    ? store.teamSpace(created.id)
    : store.saveTeamSpace({ ...store.teamSpace(created.id), recruitment: { ...store.teamSpace(created.id).recruitment, phase } }, created.id);
  return { ...fixture, team, principal };
}

test('自治招募：关闭审核后无疑问的方案自动确认并创建成员', t => {
  const { store, control, team, principal } = confirmedTeam(t, {}, 'discovery');
  // 默认需要人工审核：propose 后保持 proposed，不创建成员。
  control.proposeTeam({ teamName: '手动团队', goal: '需要审核。', purpose: '验证默认人工确认。', members: [
    { roleId: 'developer', memberId: 'dev', responsibility: '实现功能。' },
  ] }, principal);
  let current = store.teamSpace(team.id);
  assert.equal(current.requireReview, true);
  assert.equal(current.recruitment.phase, 'proposed');

  // 关闭招募审核后，重新 propose 一个无疑问的方案应自动确认。
  store.saveTeamSpace({ ...current, requireReview: false }, team.id);
  const proposed = control.proposeTeam({ teamName: '自治交付队', goal: '自动组建并交付。', purpose: '验证自动确认。', members: [
    { roleId: 'developer', memberId: 'dev', responsibility: '实现并测试功能。', deliverables: ['代码'] },
    { roleId: 'product', memberId: 'pm2', responsibility: '整理验收标准。', deliverables: ['验收标准'] },
  ] }, principal);
  assert.equal(proposed.phase, 'confirmed');
  assert.equal(proposed.autoConfirmed, true);
  current = store.teamSpace(team.id);
  assert.equal(current.recruitment.phase, 'confirmed');
  assert.ok(current.memberRoleIds.length >= 3); // manager + dev + product
  // 自动确认留有可追溯的系统消息。
  assert.ok(store.teamMessages(team.id).some(message => message.senderType === 'system' && /自动创建/.test(message.content)));
});

test('自治招募：自动确认失败时回写待确认问题，不中断流程', t => {
  const { store, control, team, principal } = confirmedTeam(t, {}, 'discovery');
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false }, team.id);
  // 绑定一个已注册但未启用的能力，触发确认前校验失败。
  store.records.save('capabilities', { name: '未启用插件', kind: 'mcp', enabled: false, transport: 'streamable-http', url: 'https://x.example.test/mcp', tools: [] }, 'disabled-cap');
  const proposed = control.proposeTeam({ teamName: '失败团队', goal: '验证失败回写。', purpose: '验证。', members: [
    { roleId: 'developer', memberId: 'dev', responsibility: '实现功能。', capabilityIds: ['disabled-cap'] },
  ] }, principal);
  assert.equal(proposed.autoConfirmed, false);
  assert.equal(proposed.phase, 'proposed');
  assert.ok(proposed.proposal.openQuestions.some(question => /自动确认失败/.test(question)));
  assert.equal(store.teamSpace(team.id).recruitment.phase, 'proposed');
});

test('去预算：任务不再因任务数上限被阻止，委派深度仍受限', t => {
  const { store, control, team, principal } = confirmedTeam(t);
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false }, team.id);
  // 并列创建 20 个子任务，验证预算不再作为阻断条件（单任务组 32 上限是独立工作流护栏）。
  for (let index = 0; index < 20; index += 1) {
    control.createJob({ role: team.pmRoleId, prompt: `并列子任务 ${index}` }, principal);
  }
  assert.ok(control.records.list('jobs').length >= 20);
  // 深度仍受 maxDepth(4) 限制，防止失控递归委派。
  let current = principal;
  for (let depth = 0; depth < 4; depth += 1) {
    const job = control.createJob({ role: team.pmRoleId, prompt: `下钻 ${depth}` }, current);
    current = control.validateInstanceToken(control.claimLocal(store.task(job.taskId)).token);
  }
  assert.throws(() => control.createJob({ role: team.pmRoleId, prompt: '超深任务' }, current), /不能超过 4/);
});

test('高风险操作需要多轮评审，普通操作直接可执行', t => {
  const { control, store, team, principal } = confirmedTeam(t);
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false }, team.id);
  // 普通操作（非高风险）直接可执行。
  const normal = control.operation({ action: 'read-files', idempotencyKey: 'r1', intent: '读取资料', permissions: undefined }, { ...principal, permissions: ['read-files'] });
  assert.equal(normal.canExecute, true);
  assert.equal(normal.review.required, false);

  // 高风险操作（部署）默认进入评审，首轮后不能执行。
  const deploy = control.operation({ action: 'deploy', idempotencyKey: 'd1', intent: '部署到生产环境' }, { ...principal, permissions: ['deploy'] });
  assert.equal(deploy.canExecute, false);
  assert.equal(deploy.review.required, true);
  // 已有 PM 自评轮。
  assert.ok(deploy.review.stages.find(slot => slot.stage === 'pm')?.record);
  // 需要独立复核与所有者确认。
  const stageNames = deploy.review.stages.map(slot => slot.stage);
  assert.ok(stageNames.includes('reviewer'));
  assert.ok(stageNames.includes('owner'));
});

test('高风险评审：复核与所有者全部通过后才可执行，任一轮拒绝即阻断', t => {
  const { control, store, team, principal } = confirmedTeam(t);
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false }, team.id);
  const op = control.operation({ action: 'publish', idempotencyKey: 'p1', intent: '发布新版本' }, { ...principal, permissions: ['publish'] });
  assert.equal(op.canExecute, false);

  // 复核轮：发起实例自己不能复核自己。
  assert.throws(() => control.submitReview(op.id, { decision: 'approve', rationale: '自审' }, principal), /不同的主体/);
  // 另一个成员实例做独立复核。
  const reviewerJob = control.createJob({ role: team.pmRoleId, prompt: '复核', parentJobId: undefined }, principal);
  const reviewerClaim = control.claimLocal(store.task(reviewerJob.taskId));
  const reviewer = control.validateInstanceToken(reviewerClaim.token);
  const afterReviewer = control.submitReview(op.id, { decision: 'approve', rationale: '影响面可控' }, reviewer);
  assert.equal(afterReviewer.review.canExecute, false); // 还差所有者确认

  // 所有者确认必须由 owner 完成。
  assert.throws(() => control.submitReview(op.id, { decision: 'approve' }, reviewer), /用户本人/);
  const afterOwner = control.submitReview(op.id, { decision: 'approve', rationale: '确认发布' }, { type: 'owner' });
  assert.equal(afterOwner.review.canExecute, true);

  // 全部通过后，重复登记同一操作返回最新评审状态。
  const again = control.operation({ action: 'publish', idempotencyKey: 'p1', intent: '发布新版本' }, { ...principal, permissions: ['publish'] });
  assert.equal(again.review.canExecute, true);

  // 另一个操作在复核轮被拒绝后即终止。
  const rejected = control.operation({ action: 'delete', idempotencyKey: 'del1', intent: '删除生产数据' }, { ...principal, permissions: ['delete'] });
  const rejReviewerJob = control.createJob({ role: team.pmRoleId, prompt: '复核2' }, principal);
  const rejReviewer = control.validateInstanceToken(control.claimLocal(store.task(rejReviewerJob.taskId)).token);
  const rejectedState = control.submitReview(rejected.id, { decision: 'reject', rationale: '风险过高' }, rejReviewer);
  assert.equal(rejectedState.review.rejected, true);
  assert.equal(store.records.get('operations', rejected.id).status, 'failed');
  assert.throws(() => control.submitReview(rejected.id, { decision: 'approve' }, { type: 'owner' }), /拒绝/);
});

test('高风险复核自动路由到与发起方不同的供应商', t => {
  const { control, store, team, principal } = confirmedTeam(t);
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false }, team.id);
  // 两个启用的普通供应商。
  const providerA = store.records.save('providers', { name: '供应商A', protocol: 'openai-completions', baseUrl: 'https://a.example.test/v1', enabled: true, models: [{ id: 'model-a', tools: true }] }, 'provider-a');
  const providerB = store.records.save('providers', { name: '供应商B', protocol: 'openai-completions', baseUrl: 'https://b.example.test/v1', enabled: true, models: [{ id: 'model-b', tools: true }] }, 'provider-b');
  // 发起实例固定使用供应商 A。
  const originTaskId = principal.taskId;
  const originMeta = store.records.get('task-meta', originTaskId) || {};
  store.records.save('task-meta', { ...originMeta, providerIds: [providerA.id], allowedProviderIds: [providerA.id] }, originTaskId);
  store.records.save('runtime-snapshots', { route: { providerId: providerA.id, model: 'model-a' } }, originTaskId);

  const op = control.operation({ action: 'deploy', idempotencyKey: 'route1', intent: '部署到生产' }, { ...principal, permissions: ['deploy'] });
  const route = op.review.reviewerRoute;
  assert.equal(route.distinct, true);
  assert.equal(route.providerId, providerB.id); // 自动选与发起方 A 不同的 B
  assert.equal(route.model, 'model-b');
  // 自动派发了一个复核任务，且路由到供应商 B。
  assert.ok(op.review.reviewTaskId);
  const reviewTaskMeta = store.records.get('task-meta', op.review.reviewTaskId);
  assert.deepEqual(reviewTaskMeta.providerIds, [providerB.id]);
  assert.equal(reviewTaskMeta.modelOverride, 'model-b');

  // 只有一个供应商时降级为同供应商（distinct=false），不派复核任务。
  store.records.save('providers', { ...providerB, enabled: false }, providerB.id);
  const op2 = control.operation({ action: 'publish', idempotencyKey: 'route2', intent: '发布' }, { ...principal, permissions: ['publish'] });
  assert.equal(op2.review.reviewerRoute.distinct, false);
  assert.equal(op2.review.reviewTaskId, null);
});

test('跨团队委派不再受固定任务数上限约束', t => {
  const { store, control, team, principal } = confirmedTeam(t);
  // 目标团队（已确认、活动、允许协作）。
  const target = store.saveTeamSpace({ name: '目标团队', goal: '接收协作。', purpose: '协作目标。', workspace: store.config.workspace, pmRoleId: 'project_manager' });
  store.saveTeamSpace({ ...target, recruitment: { ...target.recruitment, phase: 'confirmed' } }, target.id);
  store.saveTeamSpace({ ...store.teamSpace(team.id), requireReview: false, collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] } }, team.id);
  // 连续委派多个协作任务，不触发任务数上限。
  for (let index = 0; index < 35; index += 1) {
    const result = control.delegateToTeam({ teamId: target.id, prompt: `协作目标 ${index}`, idempotencyKey: `handoff-${index}` }, principal);
    assert.equal(result.duplicate, false);
  }
});

// 建立一个可与指定团队双向协作的第二团队（含其 PM principal）。
function collaboratingTeam(t, fixture, sourceTeam) {
  const { store, control } = fixture;
  const other = store.saveTeamSpace({ name: '协作团队', goal: '共享上下文。', purpose: '验证共享。', workspace: fixture.workspace, pmRoleId: 'project_manager' });
  store.saveTeamSpace({ ...store.teamSpace(other.id), collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] } }, other.id);
  store.saveTeamSpace({ ...store.teamSpace(sourceTeam.id), collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] } }, sourceTeam.id);
  const job = control.createJob({ role: other.pmRoleId, prompt: '协作', teamId: other.id, spaceId: other.id });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  return { team: store.teamSpace(other.id), principal };
}

test('跨团队共享上下文：双向协作团队可读，未授权团队不可见', t => {
  const fixture = confirmedTeam(t);
  const { store, control, team, principal } = fixture;
  const other = collaboratingTeam(t, fixture, team);

  // 无共享条目时，未发布前不能读取对方上下文（但双方都允许协作，读取为空数组）。
  const before = control.readSharedContext(principal);
  assert.equal(before.items.length, 0);

  // 本团队发布一条关键决定。
  const saved = control.shareContext({ key: 'decision/api', title: '接口约定', content: 'REST 使用 v2 路径，认证走 Bearer。', kind: 'decision' }, principal);
  assert.equal(saved.teamId, team.id);
  assert.equal(saved.key, 'decision/api');

  // 双向协作的另一团队能读到这条共享。
  const visible = control.readSharedContext(other.principal);
  assert.ok(visible.items.some(entry => entry.key === 'decision/api' && entry.teamName === store.teamSpace(team.id).name));

  // 同一 key 重复发布视为更新，revision 防并发覆盖。
  const updated = control.shareContext({ key: 'decision/api', title: '接口约定', content: '改为 v3。', kind: 'decision', expectedRevision: saved.revision }, principal);
  assert.equal(updated.revision, saved.revision + 1);
  assert.throws(() => control.shareContext({ key: 'decision/api', title: 'x', content: 'y', expectedRevision: saved.revision }, principal), /更新|revision|刷新/);

  // 单向协作（对方不允许回协）不共享。
  const isolated = store.saveTeamSpace({ name: '孤立团队', goal: 'g', purpose: 'p', workspace: fixture.workspace, pmRoleId: 'project_manager', collaboration: { enabled: false, autoHandoff: false, sharedBoard: false, allowedTeamIds: [] } });
  const isoJob = control.createJob({ role: isolated.pmRoleId, prompt: 'x', teamId: isolated.id, spaceId: isolated.id });
  const isoPrincipal = control.validateInstanceToken(control.claimLocal(store.task(isoJob.taskId)).token);
  const isolatedView = control.readSharedContext(isoPrincipal);
  assert.ok(!isolatedView.items.some(entry => entry.teamId === team.id));
});

test('共享上下文：未确认团队不能发布，无可协作团队时拒绝', t => {
  const fixture = confirmedTeam(t, {}, 'discovery');
  const { control, principal } = fixture;
  assert.throws(() => control.shareContext({ key: 'a/b', title: 't', content: 'c' }, principal), /尚未完成招募|双向协作/);
});
