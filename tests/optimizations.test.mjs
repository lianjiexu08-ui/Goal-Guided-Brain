import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactContext, branchSummary, estimateTokens } from '../server/compaction.mjs';
import { readTeamMemory, appendTeamMemory, writeTeamMemory, deleteTeamMemory } from '../server/memory.mjs';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-optim-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'data'), workspace, { seedProjectManager: true });
  const control = new ControlPlane({ store, now: () => 1000000, ...options });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, control, directory, workspace };
}

// ---- 结构化上下文压缩 ----

test('compactContext：预算内不压缩，超限后保留最近条目全文并输出元数据', () => {
  const small = { checkpoints: [{ id: 'c1' }], board: [], messages: [{ id: 'm1', content: 'hi' }] };
  const untouched = compactContext(small, { maxTokens: 100000 });
  assert.equal(untouched.compaction, null);
  assert.deepEqual(untouched.context, small);

  const messages = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, content: `消息内容 ${i} `.repeat(30), status: 'sent' }));
  const { context, compaction } = compactContext({ checkpoints: [], board: [], messages }, { maxTokens: 2000, keepRecentMessages: 6 });
  assert.ok(compaction);
  assert.equal(compaction.strategy, 'structured-v1');
  assert.ok(compaction.tokensAfter < compaction.tokensBefore);
  assert.equal(compaction.firstKeptMessageId, 'm54');
  // 最近 6 条全文保留；更早的条目被压缩为摘要。
  assert.equal(context.messages.at(-1).content, messages.at(-1).content);
  assert.equal(context.messages[0].compacted, true);
  assert.ok(context.messages[0].content.length < messages[0].content.length);
});

test('compactContext：强制收敛与空输入', () => {
  const forced = compactContext({ checkpoints: [], board: [], messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) }, { maxTokens: 0 });
  assert.ok(forced.compaction);
  const empty = compactContext({ checkpoints: [], board: [], messages: [] }, { maxTokens: 0 });
  assert.equal(empty.compaction, null);
  assert.ok(estimateTokens('x'.repeat(40)) === 10);
});

test('branchSummary：从会话条目生成固定结构分支摘要', () => {
  const entries = [
    { id: 'e1', type: 'message', data: { text: '实现登录功能并测试' }, at: '2026-01-01T00:00:00Z' },
    { id: 'e2', type: 'plan', data: { goal: '登录功能', steps: ['写代码', '跑测试'] }, at: '2026-01-01T00:01:00Z' },
    { id: 'e3', type: 'tool_call', data: { name: 'write', arguments: { path: 'src/login.ts' } }, at: '2026-01-01T00:02:00Z' },
    { id: 'e4', type: 'tool_result', data: { name: 'write' }, at: '2026-01-01T00:03:00Z' },
    { id: 'e5', type: 'verification', data: { status: 'failed', command: 'npm test' }, at: '2026-01-01T00:04:00Z' },
    { id: 'e6', type: 'checkpoint', data: { title: '中途检查', nextSteps: ['修复用例 2'] }, at: '2026-01-01T00:05:00Z' },
  ];
  const { summary, firstKeptEntryId } = branchSummary(entries);
  assert.equal(summary.goal, '实现登录功能并测试');
  assert.deepEqual(summary.filesTouched, ['src/login.ts']);
  assert.equal(summary.verification.length, 1);
  assert.deepEqual(summary.unfinished, ['修复用例 2']);
  assert.ok(summary.decisions.length >= 2);
  assert.equal(firstKeptEntryId, 'e1');
  // 分叉点截断：只汇总 upto 条目。
  const partial = branchSummary(entries.slice(0, 2));
  assert.equal(partial.summary.filesTouched.length, 0);
});

// ---- 团队记忆 ----

test('团队记忆：追加、读取、截断与删除', t => {
  const { directory } = setup(t);
  assert.equal(readTeamMemory(directory, 'team1'), null);
  assert.equal(appendTeamMemory(directory, { teamId: 'team1' }), false); // 无实质内容不写
  assert.equal(appendTeamMemory(directory, { teamId: 'team1', taskTitle: '登录功能', outcome: 'verified', lessons: '测试要先跑 lint', commands: ['npm test'] }), true);
  const memory = readTeamMemory(directory, 'team1');
  assert.ok(memory.includes('登录功能') && memory.includes('npm test'));
  writeTeamMemory(directory, 'team1', '# 覆盖\n');
  assert.equal(readTeamMemory(directory, 'team1'), '# 覆盖');
  assert.throws(() => appendTeamMemory(directory, { teamId: '../evil', lessons: 'x' }), /无效的团队/);
  assert.equal(deleteTeamMemory(directory, 'team1'), true);
  assert.equal(readTeamMemory(directory, 'team1'), null);
});

// ---- 执行计划与样本任务（MCP 工具后端） ----

function teamWithInstance(t, options = {}) {
  const fixture = setup(t, options);
  const { store, control } = fixture;
  const space = store.saveTeamSpace({
    name: '优化测试团队', goal: '验证新能力。', purpose: '测试。',
    workspace: fixture.workspace, pmRoleId: 'project_manager',
  });
  const job = control.createJob({ role: space.pmRoleId, prompt: '推进目标', teamId: space.id, spaceId: space.id, permissions: ['deploy'] });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  return { ...fixture, space, principal };
}

test('submit_execution_plan：记录可审计计划事件，缺步骤报错', t => {
  const { store, control, principal } = teamWithInstance(t);
  assert.throws(() => control.recordExecutionPlan({ goal: '只有目标' }, principal), /至少一个步骤/);
  const result = control.recordExecutionPlan({ goal: '实现登录', steps: ['探索', '实现'], risks: ['改动鉴权'], verification: 'npm test' }, principal);
  assert.equal(result.recorded, true);
  const events = store.records.list('task-events').filter(item => item.taskId === principal.taskId && item.type === 'plan/submitted');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data.steps, ['探索', '实现']);
});

test('spawn_sample_tasks + select_sample：创建隔离样本并记录择优', t => {
  const { store, control, principal } = teamWithInstance(t);
  const spawned = control.spawnSampleTasks({ prompt: '实现同一功能', count: 2, title: '登录实现' }, principal);
  assert.equal(spawned.count, 2);
  const metas = store.records.list('task-meta').filter(meta => meta.sampleGroup === spawned.sampleGroup);
  assert.equal(metas.length, 2);
  // 注意：裸 ControlPlane 的默认 createTask 不写完整 task-meta；workspaceMode 的真实落盘在平台链路验证。
  assert.ok(metas.every(meta => meta.sampleTotal === 2 && meta.sampleIndex >= 1));

  const chosen = control.selectSample({ taskId: metas[0].id, rationale: '测试覆盖更全' }, principal);
  assert.equal(chosen.recorded, true);
  assert.equal(chosen.selectedTaskId, metas[0].id);
  const notSelected = store.records.list('task-events').filter(item => item.type === 'sample/not-selected');
  assert.equal(notSelected.length, 1);
  assert.equal(notSelected[0].taskId, metas[1].id);
});

// ---- 评审面板 ----

test('reviewState：配置 reviewerPanel 后每个面板成员一个独立复核轮', t => {
  const { store, control, space, principal } = teamWithInstance(t, {});
  // 团队面板：两个复核者（不同供应商占位）。
  const current = store.teamSpace(space.id);
  store.saveTeamSpace({ ...current, review: { ...current.review, reviewerPanel: [{ providerId: 'p-a' }, { providerId: 'p-b' }] } }, space.id);
  const operation = control.operation({ action: 'deploy', title: '发布', intent: '上线', idempotencyKey: 'op-1' }, principal);
  assert.equal(operation.review.required, true);
  const stages = operation.review.stages.map(slot => slot.stage);
  assert.deepEqual(stages, ['pm', 'reviewer:p-a', 'reviewer:p-b', 'owner']);
  assert.equal(operation.review.canExecute, false);
  // 面板轮必须由不同主体提交；发起实例不能自审。
  assert.throws(() => control.submitReview(operation.id, { decision: 'approve' }, principal), /不同的主体/);
  control.submitReview(operation.id, { decision: 'approve', rationale: 'a 通过' }, { type: 'instance', taskId: 'other-task', groupId: principal.groupId, permissions: [] });
  let state = control.reviewState(operation);
  assert.equal(state.stages.find(slot => slot.stage === 'reviewer:p-a').record.decision, 'approve');
  // 面板成员 b 也可以拒绝，整体即不可执行。
  control.submitReview(operation.id, { decision: 'reject', rationale: '风险未评估' }, { type: 'owner' });
  state = control.reviewState(operation);
  assert.equal(state.rejected, true);
  assert.equal(state.canExecute, false);
});

// ---- 会话条目映射（runtime.recordSessionEntry 纯逻辑） ----

test('DshRun.recordSessionEntry：运行事件映射为追加式会话条目', async t => {
  const { DshRun } = await import('../server/runtime.mjs');
  const { directory, workspace } = setup(t);
  const entries = [];
  const run = new DshRun({
    task: { id: 'task-1', role: 'developer', workspace },
    config: { model: 'm', roleInstructions: { developer: '' } },
    dataDir: directory,
    onLog: () => {},
    onResult: () => {},
    onDone: () => {},
    sessionLog: entry => entries.push(entry),
  });
  void run.message({ method: 'session.event', params: { sessionId: 'task-1', event: { type: 'turn/start', data: {} } } });
  void run.message({ method: 'session.event', params: { sessionId: 'task-1', event: { type: 'tool/call', data: { name: 'write', arguments: { path: 'a.ts' } } } } });
  void run.message({ method: 'session.event', params: { sessionId: 'task-1', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做完了' }] } } } } });
  void run.message({ method: 'session.event', params: { sessionId: 'other', event: { type: 'turn/start', data: {} } } }); // 其他会话忽略
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => entry.type), ['turn_start', 'tool_call', 'message']);
  assert.equal(entries[1].parentId, entries[0].id);
  assert.equal(entries[2].parentId, entries[1].id);
  assert.equal(entries[2].data.text, '做完了');
  assert.equal(run.lastEntryId, entries[2].id);
});
