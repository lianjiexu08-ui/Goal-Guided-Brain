// 所有者侧 MCP：让外部「大脑」智能体（如 Claude Code）以所有者身份驱动 GGB。
//
// 与 orchestration-mcp.mjs 的区别：那个服务器按执行实例授权、只给 GGB 内部的智能体使用；
// 这里的每个工具都只是对工作台 HTTP API 的薄封装，权限等同于所有者本人在 CLI / 网页上的操作，
// 所有校验（团队归属、验收门禁、影响面确认、评审链顺序）仍由服务端执行，这里不做任何绕过。
//
// 刻意不提供：凭据库、密钥、供应商写入。密钥不应流经外部智能体。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'state_unknown']);
const ACTIVE = new Set(['queued', 'running', 'waiting', 'paused']);

const str = { type: 'string' };
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const OWNER_TOOLS = [
  {
    name: 'ggb_status',
    description: '查看 GGB 工作台总体状态：可用模型供应商（ID、模型、是否支持工具调用）、可用角色、团队摘要和待处理事项数量。派活前先调用，用来选择 providerId / model / role。',
    inputSchema: obj(),
  },
  {
    name: 'ggb_list_teams',
    description: '列出所有团队：ID、名称、招募阶段（discovery/proposed/confirmed）、是否自治招募、成员角色、工作目录。',
    inputSchema: obj(),
  },
  {
    name: 'ggb_get_team',
    description: '读取一个团队的详情：目标、成员与模型设置、工作目录、招募方案、最近消息和最近任务（含交付/验证状态）。',
    inputSchema: obj({ teamId: str, messageLimit: int(1, 100), taskLimit: int(1, 100) }, ['teamId']),
  },
  {
    name: 'ggb_create_team',
    description: '创建团队。workspace 为项目绝对路径（成员在该目录的隔离副本中工作）。autonomous=true（默认）时项目经理生成无疑问的方案后自动确认并开始干活；false 时方案需用 ggb_confirm_team 确认。providerId/model 设定团队默认模型。创建后用 ggb_message_team 交代目标。',
    inputSchema: obj({
      name: str, goal: str, workspace: str,
      autonomous: { type: 'boolean' },
      teamType: { type: 'string', enum: ['development', 'product', 'operations', 'project', 'custom'] },
      memberRoleIds: { type: 'array', items: str, maxItems: 8 },
      providerId: str, model: str,
    }, ['name', 'goal']),
  },
  {
    name: 'ggb_update_team',
    description: '修改团队设置：工作目录、默认模型（providerId/model）、名称或目标。不能修改招募阶段。',
    inputSchema: obj({ teamId: str, workspace: str, providerId: str, model: str, name: str, goal: str }, ['teamId']),
  },
  {
    name: 'ggb_confirm_team',
    description: '以所有者身份确认项目经理提出的 Team Charter（招募方案），确认后创建成员。方案有待回答问题时会被拒绝——先用 ggb_message_team 回答。',
    inputSchema: obj({ teamId: str, version: { type: 'integer', minimum: 1 } }, ['teamId']),
  },
  {
    name: 'ggb_message_team',
    description: '给团队项目经理发消息（交代目标、回答澄清问题、追加要求）。项目经理会拆解并分派给成员。建议在 content 里写清楚：目标、约束、交付物、验收标准（可逐条列出，会被登记为验收清单）。项目经理忙时默认把内容插话注入当前执行；steerIfBusy=false 时会返回冲突。返回消息和对应的项目经理任务 ID。',
    inputSchema: obj({ teamId: str, content: str, acceptance: { type: 'array', items: str, maxItems: 50, description: '逐条验收标准，会登记为任务验收清单；验收门禁要求每条都挂证据' }, steerIfBusy: { type: 'boolean' }, providerId: str, model: str }, ['teamId', 'content']),
  },
  {
    name: 'ggb_dispatch_task',
    description: '绕过项目经理，直接把一个任务派给指定角色执行，可指定模型。teamId 给定时使用团队工作目录，且该团队必须已确认、角色必须是团队成员；不给 teamId 时在工作台默认目录执行。适合 Claude 自己拆好任务后点对点派发。prompt 应自包含：背景、具体改动、约束、验证命令和验收标准。',
    inputSchema: obj({
      role: str, prompt: str, teamId: str, providerId: str, model: str,
      acceptance: { type: 'array', items: str, maxItems: 50, description: '逐条验收标准，会登记为任务验收清单；验收门禁要求每条都挂证据' },
      workspaceMode: { type: 'string', enum: ['isolated', 'worktree', 'snapshot', 'shared'] },
      budgetTokens: int(1000, 100_000_000),
      autoVerify: { type: 'boolean' },
    }, ['role', 'prompt']),
  },
  {
    name: 'ggb_get_task',
    description: '读取任务详情：状态、实际模型、执行目录、结果、错误、最新验证输出、变更影响面、验收清单和产物。验收前必须先看这里的证据。',
    inputSchema: obj({ taskId: str, includeLog: { type: 'boolean' } }, ['taskId']),
  },
  {
    name: 'ggb_diff',
    description: '查看任务执行目录相对基准提交的改动（文件统计与 git status），并返回执行目录路径、分支和基准提交——可直接在该路径下读文件或运行 git diff <baseCommit> 做逐行审查。',
    inputSchema: obj({ taskId: str }, ['taskId']),
  },
  {
    name: 'ggb_verify',
    description: '在任务执行目录中运行验证命令，结果作为当前需求版本的验证证据保存（验收门禁依赖它）。给 command + args（如 command="npm", args=["test"]），或 auto=true 让工作台按项目类型自动探测并运行检查。任务运行中不能验证。',
    inputSchema: obj({ taskId: str, command: str, args: { type: 'array', items: str, maxItems: 50 }, auto: { type: 'boolean' } }, ['taskId']),
  },
  {
    name: 'ggb_commit',
    description: '把 worktree 执行目录中的改动提交到该任务分支（codex/task-<id>）。该分支与源仓库共享引用，提交后可在源仓库中审查并合并：git -C <source> merge <branch>。建议在验证通过后再提交。',
    inputSchema: obj({ taskId: str, message: str }, ['taskId', 'message']),
  },
  {
    name: 'ggb_checklist',
    description: '读取或维护任务验收清单。action=get 读取；action=set 用 items（[{requirement, id?, verifyHint?}]）登记/替换清单；action=evidence 为条目挂证据（items: [{id, test?, command?, note?}]）——只在你亲自核实过该条（如 ggb_verify 通过、读过代码）后再挂。',
    inputSchema: obj({
      taskId: str,
      action: { type: 'string', enum: ['get', 'set', 'evidence'] },
      items: { type: 'array', maxItems: 50, items: { type: 'object', properties: { id: str, requirement: str, verifyHint: str, test: str, command: str, note: str }, additionalProperties: false } },
    }, ['taskId', 'action']),
  },
  {
    name: 'ggb_list_tasks',
    description: '列出任务（可按团队和状态筛选），按创建时间倒序。',
    inputSchema: obj({ teamId: str, status: str, limit: int(1, 200) }),
  },
  {
    name: 'ggb_wait',
    description: '等待进展。给 taskId：等到该任务进入终态（completed/failed/cancelled/interrupted/state_unknown）。给 teamId：等到团队没有排队或运行中的任务。超时会返回当前状态（timedOut=true），可以再次调用继续等。单次最长 600 秒。',
    inputSchema: obj({ taskId: str, teamId: str, timeoutSeconds: int(1, 600), pollSeconds: int(1, 30) }),
  },
  {
    name: 'ggb_steer',
    description: '给运行中的任务插话（纠偏、补充约束），不打断当前执行。任务未在运行时返回冲突。',
    inputSchema: obj({ taskId: str, text: str }, ['taskId', 'text']),
  },
  {
    name: 'ggb_retry',
    description: '重试失败/中断/取消的任务（新执行实例，隔离目录）。注意：重试沿用原任务的模型名，providerIds 换到不提供该模型的供应商会因"没有满足能力要求的模型"失败——跨供应商换模型请改用 ggb_update_team 改团队默认模型后重新 ggb_dispatch_task。',
    inputSchema: obj({ taskId: str, providerIds: { type: 'array', items: str } }, ['taskId']),
  },
  {
    name: 'ggb_cancel',
    description: '停止任务。',
    inputSchema: obj({ taskId: str }, ['taskId']),
  },
  {
    name: 'ggb_decide_delivery',
    description: '以所有者身份对任务交付做验收决定：accept 通过 / reject 退回复核（reject 必须写明要改什么）。服务端门禁仍然生效：需有当前需求版本的验证证据、验收清单全部挂证据；高风险变更需先确认影响面（ackImpact=true 会先确认再验收）。决定前务必用 ggb_get_task 核对证据。',
    inputSchema: obj({ taskId: str, decision: { type: 'string', enum: ['accept', 'reject'] }, note: str, ackImpact: { type: 'boolean' } }, ['taskId', 'decision']),
  },
  {
    name: 'ggb_attention',
    description: '列出需要所有者处理的待办事项（阻塞、凭据、高风险影响面确认、评审等）。',
    inputSchema: obj({ includeResolved: { type: 'boolean' }, limit: int(1, 200) }),
  },
  {
    name: 'ggb_list_operations',
    description: '列出团队中登记的外部操作（部署/发布/删除/发送等）及其多轮评审进度。',
    inputSchema: obj({ teamId: str }, ['teamId']),
  },
  {
    name: 'ggb_review_operation',
    description: '以所有者身份对高风险外部操作提交评审决定（approve/reject）。评审链顺序由服务端强制：必须先完成前序复核轮。approve 前应确认操作意图、影响范围和回滚方式。',
    inputSchema: obj({ operationId: str, decision: { type: 'string', enum: ['approve', 'reject'] }, rationale: str }, ['operationId', 'decision', 'rationale']),
  },
];

const clip = (value, max) => {
  if (value === undefined || value === null) return value;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…（已截断，共 ${text.length} 字）` : text;
};
const listOf = data => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []);
const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const enc = encodeURIComponent;
const need = (input, key) => {
  const value = typeof input[key] === 'string' ? input[key].trim() : '';
  if (!value) throw new Error(`缺少参数 ${key}。`);
  return value;
};

function taskBrief(task) {
  return {
    id: task.id,
    title: clip(task.title, 120),
    role: task.role,
    status: task.status,
    teamId: task.teamId || task.spaceId || task.meta?.teamId || task.meta?.spaceId || null,
    deliveryStatus: task.deliveryStatus ?? task.delivery?.deliveryStatus ?? null,
    verificationStatus: task.verificationStatus ?? task.delivery?.acceptanceStatus ?? null,
    error: clip(task.error, 300) || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function messageBrief(message) {
  return {
    id: message.id,
    from: message.senderType === 'owner' ? 'owner' : message.senderType === 'team' ? `team:${message.senderId || ''}` : message.senderType || 'pm',
    kind: message.kind,
    status: message.status,
    taskId: message.taskId || null,
    content: clip(message.content, 2000),
    error: message.error ? clip(message.error, 300) : undefined,
    createdAt: message.createdAt,
  };
}

function teamBrief(team) {
  return {
    id: team.id,
    name: team.name,
    goal: clip(team.goal, 300),
    status: team.status,
    phase: team.recruitment?.phase || null,
    autonomous: team.requireReview === false,
    memberRoleIds: team.memberRoleIds || [],
    workspace: team.workspace || null,
    workspaceMode: team.workspaceMode || null,
    providerId: team.providerId || null,
    model: team.model || null,
  };
}

function taskDetail(task, checklist, includeLog) {
  const delivery = task.delivery || {};
  const verification = delivery.latestVerification;
  const impact = delivery.impact || task.impact || null;
  return {
    ...taskBrief(task),
    prompt: clip(task.prompt, 1500),
    route: task.snapshot?.route ? { providerId: task.snapshot.route.providerId, model: task.snapshot.route.model } : null,
    executionWorkspace: task.executionWorkspace || null,
    result: clip(task.result, 6000),
    delivery: {
      deliveryStatus: delivery.deliveryStatus ?? null,
      acceptanceStatus: delivery.acceptanceStatus ?? null,
      acceptanceDecision: delivery.acceptanceDecision ?? null,
      currentRequirementVersion: delivery.currentRequirementVersion ?? null,
      evidenceCount: delivery.evidenceCount ?? null,
    },
    latestVerification: verification
      ? { status: verification.status, command: verification.command, finishedAt: verification.finishedAt || verification.updatedAt, output: clip(verification.output, 3000) }
      : null,
    impact: impact
      ? { risk: impact.risk, requiresAck: Boolean(impact.requiresAck), acknowledged: Boolean(task.impactAcknowledged), stats: impact.stats, reasons: impact.reasons }
      : null,
    checklist: checklist?.items
      ? checklist.items.map(item => ({ id: item.id, requirement: clip(item.requirement, 300), status: item.status, evidence: item.evidence || null }))
      : null,
    artifacts: (task.artifacts || [])
      .filter(item => item.kind !== 'impact')
      .slice(0, 20)
      .map(item => ({ id: item.id, kind: item.kind, name: item.name || item.title, status: item.status, location: item.location })),
    ...(includeLog ? { log: clip(task.log, 12000) } : {}),
  };
}

function acceptanceItems(input) {
  if (input.acceptance === undefined) return null;
  if (!Array.isArray(input.acceptance)) throw new Error('acceptance 需要是字符串数组。');
  const items = input.acceptance.map(item => String(item || '').trim()).filter(Boolean);
  if (!items.length) return null;
  return items.map((requirement, index) => ({ id: `ac-${index + 1}`, requirement }));
}

/**
 * 构造工具处理器。api(route, { method, body }) 返回解析后的 JSON，非 2xx 时抛错（与 CLI 的 workbenchFetch 一致）。
 */
export function createOwnerToolHandler(api, { now = () => Date.now(), wait = sleep } = {}) {
  const teamDetail = id => api(`teams/${enc(id)}`);

  const handlers = {
    async ggb_status() {
      const [health, state, providers, manage, credentials] = await Promise.all([
        api('health').catch(error => ({ error: error.message })),
        api('state'),
        api('providers').catch(() => []),
        api('manage').catch(() => ({})),
        api('credentials').catch(() => null),
      ]);
      const credentialIds = credentials ? new Set(listOf(credentials).map(item => item.id)) : null;
      const teams = listOf(state.spaces);
      return {
        health: { ok: !health.error, dshReady: state.config?.dshReady ?? null, hasCredential: state.config?.hasApiKey ?? null, error: health.error },
        providers: listOf(providers).map(provider => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled !== false,
          protocol: provider.protocol,
          // 供应商引用的凭据已不在凭据库时，任务会直接失败（"供应商凭据不存在"）——提前标出来，不要选它。
          credentialMissing: credentialIds && provider.credentialId ? !credentialIds.has(provider.credentialId) : undefined,
          models: (provider.models || []).map(model => ({ id: model.id, tools: Boolean(model.tools), contextWindow: model.contextWindow })),
        })),
        roles: listOf(state.roles).filter(role => !role.archived).map(role => ({ id: role.id, name: role.name })),
        teams: teams.map(teamBrief),
        openAttention: listOf(manage.attention).filter(item => item.status === 'open').length,
        note: '执行任务需要支持工具调用（tools=true）且 credentialMissing 不为 true 的模型；换供应商时同时指定 model（团队默认模型不会随供应商自动切换）。默认工作目录：' + (state.config?.workspace || '未设置'),
      };
    },

    async ggb_list_teams() {
      return listOf(await api('teams')).map(teamBrief);
    },

    async ggb_get_team(input) {
      const team = await teamDetail(need(input, 'teamId'));
      const messages = listOf(team.messages).sort(byNewest).slice(0, input.messageLimit || 20).reverse();
      const tasks = listOf(team.tasks).sort(byNewest).slice(0, input.taskLimit || 20);
      const proposal = team.recruitment?.proposal;
      return {
        ...teamBrief(team),
        purpose: clip(team.purpose, 500),
        memberSettings: team.memberSettings || {},
        responsibilities: team.responsibilities || {},
        proposal: proposal
          ? {
              version: proposal.version,
              openQuestions: proposal.openQuestions || [],
              members: (proposal.members || []).map(member => ({
                roleId: member.roleId, name: member.name, responsibility: clip(member.responsibility, 300),
                providerIds: member.providerIds || [], modelHint: member.modelHint || null,
              })),
            }
          : null,
        activeTasks: tasks.filter(task => ACTIVE.has(task.status)).length,
        tasks: tasks.map(taskBrief),
        messages: messages.map(messageBrief),
      };
    },

    async ggb_create_team(input) {
      const name = need(input, 'name');
      const goal = need(input, 'goal');
      const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
      if (workspace) {
        if (!path.isAbsolute(workspace)) throw new Error('workspace 需要绝对路径。');
        if (!fs.existsSync(workspace)) throw new Error(`workspace 目录不存在：${workspace}`);
      }
      const roles = Array.isArray(input.memberRoleIds) && input.memberRoleIds.length
        ? [...new Set(['project_manager', ...input.memberRoleIds])]
        : ['project_manager', 'developer'];
      const team = await api('teams', {
        method: 'POST',
        body: {
          name, goal, purpose: goal,
          teamType: input.teamType || 'custom',
          pmRoleId: 'project_manager',
          memberRoleIds: roles,
          requireReview: input.autonomous === false,
          ...(workspace ? { workspace } : {}),
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.model ? { model: input.model } : {}),
          collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] },
        },
      });
      return { team: teamBrief(team), next: `用 ggb_message_team(teamId="${team.id}") 交代目标与验收标准。` };
    },

    async ggb_update_team(input) {
      const teamId = need(input, 'teamId');
      const body = {};
      for (const key of ['workspace', 'providerId', 'model', 'name', 'goal']) {
        if (typeof input[key] === 'string') body[key] = input[key].trim();
      }
      if (body.workspace) {
        if (!path.isAbsolute(body.workspace)) throw new Error('workspace 需要绝对路径。');
        if (!fs.existsSync(body.workspace)) throw new Error(`workspace 目录不存在：${body.workspace}`);
      }
      if (!Object.keys(body).length) throw new Error('没有需要修改的字段。');
      return teamBrief(await api(`teams/${enc(teamId)}`, { method: 'PUT', body }));
    },

    async ggb_confirm_team(input) {
      const teamId = need(input, 'teamId');
      let version = input.version;
      if (version === undefined) version = (await teamDetail(teamId)).recruitment?.proposal?.version;
      const team = await api(`teams/${enc(teamId)}/recruitment/confirm`, { method: 'POST', body: version === undefined ? {} : { version } });
      return teamBrief(team);
    },

    async ggb_message_team(input) {
      const teamId = need(input, 'teamId');
      const content = need(input, 'content');
      const items = acceptanceItems(input);
      const message = await api(`teams/${enc(teamId)}/messages`, {
        method: 'POST',
        body: {
          clientMessageId: `mcp-${randomUUID()}`,
          content,
          steerIfBusy: input.steerIfBusy !== false,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.model ? { model: input.model } : {}),
        },
      });
      const taskId = message.steered ? message.steerTaskId : message.taskId || null;
      let checklist = null;
      if (items && taskId && !message.steered) {
        checklist = await api(`tasks/${enc(taskId)}/checklist`, { method: 'POST', body: { items } })
          .then(saved => saved.items.length)
          .catch(error => `登记失败：${error.message}`);
      }
      return {
        messageId: message.id,
        taskId,
        steered: Boolean(message.steered),
        status: message.status,
        checklistItems: checklist ?? (items && message.steered ? '插话不会登记新清单' : null),
        next: '用 ggb_wait(teamId) 等待项目经理处理，再用 ggb_get_team 查看回复。',
      };
    },

    async ggb_dispatch_task(input) {
      const body = { role: need(input, 'role'), prompt: need(input, 'prompt') };
      const items = acceptanceItems(input);
      for (const key of ['teamId', 'providerId', 'model', 'workspaceMode']) if (input[key]) body[key] = input[key];
      if (input.budgetTokens !== undefined) body.budgetTokens = input.budgetTokens;
      if (input.autoVerify === false) body.autoVerify = false;
      const task = await api('tasks', { method: 'POST', body });
      // 显式验收标准覆盖从 PRD.md 自动提取的清单（若有）。
      const checklist = items
        ? await api(`tasks/${enc(task.id)}/checklist`, { method: 'POST', body: { items } }).then(saved => saved.items.length).catch(error => `登记失败：${error.message}`)
        : null;
      return { task: { ...taskBrief(task), teamId: taskBrief(task).teamId || body.teamId || null }, checklistItems: checklist, next: `用 ggb_wait(taskId="${task.id}") 等待完成。` };
    },

    async ggb_get_task(input) {
      const taskId = need(input, 'taskId');
      const [task, checklist] = await Promise.all([
        api(`tasks/${enc(taskId)}`),
        api(`tasks/${enc(taskId)}/checklist`).catch(() => null),
      ]);
      return taskDetail(task, checklist, input.includeLog === true);
    },

    async ggb_diff(input) {
      const taskId = need(input, 'taskId');
      const [task, diff] = await Promise.all([api(`tasks/${enc(taskId)}`), api(`workspaces/${enc(taskId)}`)]);
      const workspace = task.executionWorkspace || {};
      return {
        kind: diff.kind,
        path: workspace.path || null,
        source: workspace.source || null,
        branch: workspace.branch || null,
        baseCommit: workspace.baseCommit || null,
        state: workspace.state || null,
        stat: clip(diff.diff, 6000),
        status: clip(diff.status, 4000),
        message: diff.message,
        hint: workspace.path && workspace.baseCommit
          ? `逐行审查：git -C ${workspace.path} diff ${workspace.baseCommit}（未跟踪的新文件用 git -C ${workspace.path} status 查看后直接读取）`
          : undefined,
      };
    },

    async ggb_verify(input) {
      const taskId = need(input, 'taskId');
      let body;
      if (input.auto === true) body = { auto: true };
      else {
        const command = need(input, 'command');
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        body = { command, args };
      }
      const result = await api(`workspaces/${enc(taskId)}/verify`, { method: 'POST', body });
      return { ...result, output: clip(result.output, 4000) };
    },

    async ggb_commit(input) {
      const taskId = need(input, 'taskId');
      const result = await api(`workspaces/${enc(taskId)}/commit`, { method: 'POST', body: { message: need(input, 'message') } });
      const task = await api(`tasks/${enc(taskId)}`).catch(() => null);
      const workspace = task?.executionWorkspace || {};
      return {
        commit: result.commit || null,
        branch: workspace.branch || null,
        source: workspace.source || null,
        next: workspace.source && workspace.branch
          ? `在源仓库审查并合并：git -C ${workspace.source} log --oneline ${workspace.baseCommit || 'HEAD'}..${workspace.branch}；git -C ${workspace.source} merge ${workspace.branch}`
          : undefined,
      };
    },

    async ggb_checklist(input) {
      const taskId = need(input, 'taskId');
      const items = Array.isArray(input.items) ? input.items : [];
      if (input.action === 'get') {
        return api(`tasks/${enc(taskId)}/checklist`).catch(error => ({ items: [], note: error.message }));
      }
      if (!items.length) throw new Error('set / evidence 需要 items。');
      if (input.action === 'set') return api(`tasks/${enc(taskId)}/checklist`, { method: 'POST', body: { items } });
      if (input.action === 'evidence') return api(`tasks/${enc(taskId)}/checklist-evidence`, { method: 'POST', body: { items } });
      throw new Error('action 必须是 get、set 或 evidence。');
    },

    async ggb_list_tasks(input) {
      const teams = listOf(await api('teams')).filter(team => !input.teamId || team.id === input.teamId || team.name === input.teamId);
      const tasks = [];
      for (const team of teams) {
        const detail = await teamDetail(team.id).catch(() => null);
        for (const task of listOf(detail?.tasks)) {
          if (input.status && task.status !== input.status) continue;
          tasks.push({ ...taskBrief(task), teamName: team.name });
        }
      }
      return tasks.sort(byNewest).slice(0, input.limit || 30);
    },

    async ggb_wait(input) {
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
      if (!taskId === !teamId) throw new Error('ggb_wait 需要 taskId 或 teamId（二选一）。');
      const timeoutMs = Math.min(600, Math.max(1, input.timeoutSeconds || 120)) * 1000;
      const pollMs = Math.min(30, Math.max(1, input.pollSeconds || 3)) * 1000;
      const started = now();
      const startedIso = new Date(started).toISOString();
      for (;;) {
        if (taskId) {
          const task = await api(`tasks/${enc(taskId)}`);
          if (TERMINAL.has(task.status)) return { done: true, timedOut: false, waitedSeconds: Math.round((now() - started) / 1000), task: taskBrief(task) };
          if (now() - started >= timeoutMs) return { done: false, timedOut: true, waitedSeconds: Math.round((now() - started) / 1000), task: taskBrief(task) };
        } else {
          const team = await teamDetail(teamId);
          const tasks = listOf(team.tasks);
          const active = tasks.filter(task => ACTIVE.has(task.status));
          const settled = !active.length;
          if (settled || now() - started >= timeoutMs) {
            return {
              done: settled,
              timedOut: !settled,
              waitedSeconds: Math.round((now() - started) / 1000),
              phase: team.recruitment?.phase || null,
              activeTasks: active.map(taskBrief),
              changedTasks: tasks.filter(task => String(task.updatedAt || '') >= startedIso).sort(byNewest).slice(0, 20).map(taskBrief),
              newMessages: listOf(team.messages).filter(message => String(message.createdAt || '') >= startedIso).sort(byNewest).slice(0, 20).reverse().map(messageBrief),
            };
          }
        }
        await wait(pollMs);
      }
    },

    async ggb_steer(input) {
      return api(`tasks/${enc(need(input, 'taskId'))}/steer`, { method: 'POST', body: { text: need(input, 'text') } });
    },

    async ggb_retry(input) {
      const body = Array.isArray(input.providerIds) && input.providerIds.length ? { providerIds: input.providerIds } : {};
      const task = await api(`tasks/${enc(need(input, 'taskId'))}/retry`, { method: 'POST', body });
      return { task: taskBrief(task) };
    },

    async ggb_cancel(input) {
      return api(`tasks/${enc(need(input, 'taskId'))}/cancel`, { method: 'POST', body: {} });
    },

    async ggb_decide_delivery(input) {
      const taskId = need(input, 'taskId');
      const decision = input.decision;
      if (!['accept', 'reject'].includes(decision)) throw new Error('decision 必须是 accept 或 reject。');
      const note = typeof input.note === 'string' ? input.note.trim() : '';
      if (decision === 'reject' && !note) throw new Error('退回复核需要在 note 里写明要改什么。');
      let impactAck = null;
      if (input.ackImpact === true) {
        impactAck = await api(`tasks/${enc(taskId)}/impact/ack`, { method: 'POST', body: { note: note || '由所有者代理（MCP）确认影响面。' } });
      }
      const result = await api(`tasks/${enc(taskId)}/${decision}`, { method: 'POST', body: { note } });
      return { decision, impactAcknowledged: Boolean(impactAck), result };
    },

    async ggb_attention(input) {
      const manage = await api('manage');
      return listOf(manage.attention)
        .filter(item => input.includeResolved || item.status === 'open')
        .sort(byNewest)
        .slice(0, input.limit || 50)
        .map(item => ({ id: item.id, status: item.status, kind: item.kind, title: clip(item.title, 200), detail: clip(item.detail, 1500), taskId: item.taskId || null, createdAt: item.createdAt }));
    },

    async ggb_list_operations(input) {
      const data = await api(`operations?teamId=${enc(need(input, 'teamId'))}&limit=100`);
      return listOf(data).map(item => ({
        id: item.id, action: item.action, title: item.title, intent: clip(item.intent, 500), status: item.status,
        taskId: item.taskId, review: item.review || null, evidence: clip(item.evidence, 500),
      }));
    },

    async ggb_review_operation(input) {
      if (!['approve', 'reject'].includes(input.decision)) throw new Error('decision 必须是 approve 或 reject。');
      return api(`operations/${enc(need(input, 'operationId'))}/review`, {
        method: 'POST',
        body: { decision: input.decision, rationale: need(input, 'rationale') },
      });
    },
  };

  return async function handle(name, input = {}) {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具：${name}`);
    return handler(input || {});
  };
}

export function createOwnerMcpServer(api, options = {}) {
  const handle = createOwnerToolHandler(api, options);
  // eslint-disable-next-line typescript/no-deprecated -- The low-level server accepts the shared JSON tool schemas directly.
  const server = new Server({ name: 'ggb-owner', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: [
      'GGB（Goal-Guided Brain）多模型智能体工作台的所有者接口。你是「大脑」：负责拆解目标、写清验收标准、派活、盯进度、核对证据、做验收决定。',
      '推荐流程：ggb_status 选模型（tools=true 且凭据存在）→ ggb_create_team（workspace 指向项目 git 仓库）或复用已有团队 → ggb_message_team 交代目标与逐条验收标准（或 ggb_dispatch_task 点对点派活）→ ggb_wait → ggb_get_task / ggb_diff 审查结果与改动 → ggb_verify 运行验证留证据 → ggb_decide_delivery 验收（或 ggb_steer / 重新派活纠偏）→ ggb_commit 提交到任务分支 → 在源仓库 git merge 该分支落地。',
      '任务 completed 不等于验收通过；验收前必须看过验证证据。高风险外部操作用 ggb_list_operations / ggb_review_operation 处理，批准前说明理由。',
    ].join('\n'),
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OWNER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await handle(request.params.name, request.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error?.message || String(error) }] };
    }
  });
  return server;
}
