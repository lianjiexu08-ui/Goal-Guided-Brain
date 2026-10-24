import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bearer } from './auth.mjs';
import { SKILLS } from './roles.mjs';
import { assessCapabilityRisk } from './capabilities.mjs';

const string = { type: 'string' };
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const jsonValue = { type: ['string', 'object', 'array'] };
function catalogComponents(service, capability) {
  const empty = { commands: [], agents: [], mcp: [] };
  if (!service || capability.kind === 'mcp') return empty;
  try {
    const components = service.components(capability.id);
    const safe = (items = []) => items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
      runnable: item.runnable,
      userInvocable: item.userInvocable,
      diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics : [],
    }));
    return {
      commands: safe(components.commands),
      agents: safe(components.agents),
      mcp: safe(components.mcp),
    };
  } catch {
    // A stale or tampered bundle remains visible with its risk and diagnostics,
    // but component inspection must not make the read-only catalog fail.
    return empty;
  }
}
const decisionQuestion = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['choice', 'score', 'noul'] },
    instructions: string,
    criteria: {},
  },
  required: ['type', 'instructions'],
  additionalProperties: true,
};
const tools = [
  { name: 'list_capabilities', description: '查看当前助手本次执行已绑定的 Skill、MCP 和 Plugin 能力；只读，不会授予新权限。', inputSchema: objectSchema() },
  { name: 'list_capability_catalog', description: '查看当前工作台已启用的 Skill、MCP 和 Plugin 目录及稳定 ID；只读，用于设计 Team Charter，不会自动授予权限。', inputSchema: objectSchema() },
  { name: 'recommend_skills', description: '根据任务描述推荐可用的 Skill（内置、已安装与自维护库）。只做推荐，不安装不授权；用于规划 Team Charter 时选择要绑定的能力。', inputSchema: objectSchema({ query: string, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) },
  { name: 'evaluate_decision', description: '使用已配置的 TypeSafe System One 后端，对当前状态执行结构化判断；这是可选决策能力，不会替代普通模型或直接执行外部操作。', inputSchema: objectSchema({
    state: jsonValue,
    model: string,
    providerId: string,
    questions: { type: 'object', minProperties: 1, maxProperties: 100, additionalProperties: decisionQuestion },
  }, ['state', 'questions']) },
  { name: 'run_capability_command', description: '运行当前助手已绑定 Plugin 中一个可调用的命令；命令会作为受控子任务排队，不会直接获得额外权限。', inputSchema: objectSchema({ capabilityId: string, commandId: string, arguments: string }, ['capabilityId', 'commandId']) },
  { name: 'list_teams', description: '查看当前团队允许协作的其他长期团队；只返回团队摘要，不返回其他团队的私有消息。', inputSchema: objectSchema() },
  { name: 'delegate_to_team', description: '把明确的协作目标委派给另一个长期团队的项目经理；目标团队使用自己的模型、能力、预算和权限。', inputSchema: objectSchema({ teamId: string, prompt: string, acceptance: string, idempotencyKey: string }, ['teamId', 'prompt', 'idempotencyKey']) },
  { name: 'read_team_task', description: '读取已获准协作团队中的一个委派任务状态和结果。', inputSchema: objectSchema({ taskId: string }, ['taskId']) },
  { name: 'read_team_roster', description: '读取当前已确认团队的成员实例、职责和可用角色模板；招募阶段只返回模板和当前方案。', inputSchema: objectSchema() },
  { name: 'propose_team', description: '在多轮澄清完成后保存 Team Charter。用 skillIds、capabilityIds、providerIds 和 toolAccess 写入实际权限，skills/tools 仅作展示说明。默认按成员职责自动填充推荐的内置 Skill 与已安装能力（autoRecommend=false 可关闭），自维护库中未安装项只作为建议返回。若团队已关闭招募审核且方案无疑问，会自动确认并创建成员开始协作；否则保存为待用户在招募界面确认的草案，确认前不创建成员、不分派任务。', inputSchema: objectSchema({
    autoRecommend: { type: 'boolean' },
    teamName: string, goal: string, purpose: string,
    members: { type: 'array', minItems: 1, maxItems: 8, items: objectSchema({
      memberId: string, roleId: string, name: string, responsibility: string,
      deliverables: { type: 'array', items: string }, skills: { type: 'array', items: string },
      skillIds: { type: 'array', maxItems: 3, items: string }, capabilityIds: { type: 'array', items: string },
      providerIds: { type: 'array', items: string }, tools: { type: 'array', items: string },
      toolAccess: objectSchema({ files: { type: 'boolean' }, web: { type: 'boolean' }, terminal: { type: 'boolean' } }),
      modelHint: string, dependencies: { type: 'array', items: string },
    }, ['roleId', 'responsibility']) },
    openQuestions: { type: 'array', items: string },
  }, ['teamName', 'goal', 'members']) },
  { name: 'list_agents', description: '查看当前任务组的智能体和执行状态。', inputSchema: objectSchema() },
  { name: 'read_inbox', description: '领取当前执行实例的持久化消息；送达不代表已经处理。', inputSchema: objectSchema() },
  { name: 'ack_message', description: '确认自己收到的消息处理状态。', inputSchema: objectSchema({ id: string, status: { type: 'string', enum: ['received', 'processing', 'processed'] } }, ['id', 'status']) },
  { name: 'send_message', description: '给同一任务组中的指定执行实例发送消息。重复幂等键不会重复投递。', inputSchema: objectSchema({
    toTaskId: string, toAgentId: string, content: string, idempotencyKey: string, replyTo: string,
    kind: { type: 'string', enum: ['task', 'question', 'reply', 'progress', 'blocked', 'handoff', 'notice'] },
    requirementVersion: { type: 'integer', minimum: 1 },
  }, ['toTaskId', 'content', 'idempotencyKey']) },
  { name: 'delegate_task', description: '把有明确交付目标的子任务分派给助手；子任务使用父任务的环境和授权范围。', inputSchema: objectSchema({
    role: string, prompt: string, acceptance: string, dependencies: { type: 'array', items: string }, permissions: { type: 'array', items: string },
  }, ['role', 'prompt']) },
  { name: 'save_checkpoint', description: '记录目标、约束、决定、产物、已执行操作和后续步骤，供新的执行实例继续。', inputSchema: objectSchema({
    title: string, content: string, constraints: { type: 'array', items: string }, decisions: { type: 'array', items: string },
    artifacts: { type: 'array', items: string }, operations: { type: 'array', items: string }, nextSteps: { type: 'array', items: string },
  }, ['title', 'content']) },
  { name: 'submit_artifact', description: '提交产物位置、版本和验证证据；不会自动合并代码或发布。', inputSchema: objectSchema({ title: string, location: string, content: string, commit: string, evidence: string }, ['title', 'location', 'evidence']) },
  { name: 'read_board', description: '读取当前任务组的共享任务板和版本。', inputSchema: objectSchema() },
  { name: 'read_shared_context', description: '读取当前团队及双向协作团队共享的跨团队上下文（决定、发现、状态、产物索引）。只读，只返回已建立双向协作关系团队的内容。', inputSchema: objectSchema() },
  { name: 'share_context', description: '发布一条跨团队共享上下文（如关键决定、可复用结论、产物位置），供与本团队双向协作的其他团队阅读。同一 key 重复发布视为更新。', inputSchema: objectSchema({ key: string, title: string, content: string, kind: { type: 'string', enum: ['decision', 'finding', 'status', 'artifact', 'note'] }, expectedRevision: { type: 'integer', minimum: 1 } }, ['key', 'title', 'content']) },
  { name: 'update_board', description: '保存共享结论；更新已有记录必须使用读取到的 revision，避免覆盖并发修改。', inputSchema: objectSchema({ id: string, title: string, content: string, expectedRevision: { type: 'integer', minimum: 1 } }, ['title', 'content']) },
  { name: 'request_attention', description: '向所有者报告需要决定、凭据或人工核验的阻塞事项。', inputSchema: objectSchema({ title: string, content: string, kind: string }, ['title', 'content']) },
  { name: 'begin_operation', description: '登记已被明确授权的外部操作。高风险操作（部署/发布/删除/发送/外部写入等）会自动进入多轮评审，canExecute=true 才能首次执行；已有记录必须先核验结果。', inputSchema: objectSchema({ action: string, title: string, intent: string, rationale: string, idempotencyKey: string }, ['action', 'intent', 'idempotencyKey']) },
  { name: 'list_operation_reviews', description: '查看当前任务组中高风险操作的多轮评审进度；只读。', inputSchema: objectSchema({ operationId: string }) },
  { name: 'submit_operation_review', description: '对高风险操作提交一轮评审决定（approve/reject）。复核轮必须由与发起实例不同的主体完成；所有者确认轮只能由用户在团队界面执行。', inputSchema: objectSchema({ operationId: string, decision: { type: 'string', enum: ['approve', 'reject'] }, rationale: string }, ['operationId', 'decision']) },
  { name: 'complete_operation', description: '保存外部操作结果和证据。无法确认是否已执行时标为 unknown。', inputSchema: objectSchema({ id: string, status: { type: 'string', enum: ['succeeded', 'failed', 'unknown'] }, evidence: string }, ['id', 'status', 'evidence']) },
];

export function createOrchestrationServer({ control, token, capabilities }) {
  // eslint-disable-next-line typescript/no-deprecated -- The low-level server accepts the shared JSON tool schemas directly.
  const server = new Server({ name: 'dsh-workbench-orchestration', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    control.validateInstanceToken(token);
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
        const principal = control.validateInstanceToken(token);
        const input = request.params.arguments || {};
        let response;
        switch (request.params.name) {
        case 'list_capabilities': {
          const task = control.store.task(principal.taskId);
          const meta = control.records.get('task-meta', principal.taskId) || {};
          const snapshot = control.records.get('runtime-snapshots', principal.taskId);
          const assistant = snapshot?.assistant || meta.assistantSnapshot || control.store.role(task?.role);
          const skillIds = Array.isArray(assistant?.skillIds) ? assistant.skillIds : [];
          const capabilityIds = Array.isArray(assistant?.capabilityIds) ? assistant.capabilityIds : [];
          response = {
            assistant: task ? { id: task.role, name: control.store.role(task.role)?.name || task.role } : null,
            skills: skillIds.map(id => {
              const skill = SKILLS.find(item => item.id === id);
              return { id, name: skill?.name || id, role: skill?.role || null };
            }),
            capabilities: capabilityIds.map(id => {
              const current = snapshot?.capabilityConfigs?.[id] || control.records.get('capabilities', id);
              let commands = [];
              if (current && current.kind !== 'mcp' && capabilities) {
                try {
                  commands = capabilities.components(id).commands.map(command => ({
                    id: command.id,
                    name: command.name,
                    description: command.description,
                    argumentHint: command.argumentHint,
                    argumentNames: command.argumentNames,
                    runnable: command.runnable,
                    userInvocable: command.userInvocable,
                  }));
                } catch {
                  commands = [];
                }
              }
              return current ? {
                id: current.id,
                name: current.name,
                kind: current.kind,
                version: current.version || null,
                digest: current.digest || null,
                source: current.source || null,
                compatibility: current.compatibility || (Array.isArray(current.diagnostics) && current.diagnostics.length ? 'partial' : 'compatible'),
                diagnostics: Array.isArray(current.diagnostics) ? current.diagnostics : [],
                risk: assessCapabilityRisk(current),
                enabled: current.enabled !== false,
                tools: Array.isArray(current.tools) ? current.tools : [],
                commands,
                health: current.health ? {
                  ok: current.health.ok === true,
                  checkedAt: current.health.checkedAt || null,
                  latencyMs: current.health.latencyMs || null,
                  toolCount: Array.isArray(current.health.tools) ? current.health.tools.length : null,
                } : null,
              } : { id, name: id, kind: 'unknown', enabled: false, tools: [] };
            }),
          };
          break;
        }
        case 'recommend_skills': {
          if (!capabilities) throw new Error('能力推荐服务不可用。');
          const limit = Number.isSafeInteger(input.limit) ? Math.min(20, Math.max(1, input.limit)) : 8;
          response = { items: await capabilities.recommend(input.query, { limit }) };
          break;
        }
        case 'list_capability_catalog': {
          response = {
            skills: SKILLS.map(skill => ({ id: skill.id, name: skill.name, role: skill.role })),
            providers: control.records.list('providers')
              .filter(provider => provider.enabled !== false)
              .map(provider => ({
                id: provider.id,
                name: provider.name,
                models: (provider.models || []).map(model => ({
                  id: model.id,
                  name: model.name,
                  tools: model.tools === true,
                  vision: model.vision === true,
                  contextWindow: model.contextWindow,
                })),
              })),
            capabilities: control.records.list('capabilities')
              .filter(capability => capability.enabled !== false)
              .map(capability => ({
                id: capability.id,
                name: capability.name,
                kind: capability.kind,
                version: capability.version || null,
                digest: capability.digest || null,
                source: capability.source || null,
                compatibility: capability.compatibility || (Array.isArray(capability.diagnostics) && capability.diagnostics.length ? 'partial' : 'compatible'),
                description: capability.description || '',
                diagnostics: Array.isArray(capability.diagnostics) ? capability.diagnostics : [],
                risk: assessCapabilityRisk(capability),
                components: catalogComponents(capabilities, capability),
                tools: Array.isArray(capability.tools) ? capability.tools : [],
                health: capability.health ? {
                  ok: capability.health.ok === true,
                  checkedAt: capability.health.checkedAt || null,
                  toolCount: Array.isArray(capability.health.tools) ? capability.health.tools.length : null,
                } : null,
              })),
          };
          break;
        }
        case 'evaluate_decision':
          response = await control.evaluateDecision(input, principal);
          break;
        case 'run_capability_command': {
          if (!capabilities) throw new Error('能力命令服务不可用。');
          const task = control.store.task(principal.taskId);
          const meta = control.records.get('task-meta', principal.taskId) || {};
          const snapshot = control.records.get('runtime-snapshots', principal.taskId);
          const assistant = snapshot?.assistant || meta.assistantSnapshot || control.store.role(task?.role);
          if (!task || !assistant?.capabilityIds?.includes(input.capabilityId)) throw new Error('此能力未绑定到当前助手。');
          const commandTask = capabilities.commandTask(input.capabilityId, input.commandId, {
            role: task.role,
            arguments: input.arguments || '',
            workspace: task.workspace,
            workspaceKey: meta.workspaceKey || 'default',
            workspaceMode: 'isolated',
            nodeId: meta.nodeId || 'local',
          });
          response = control.createJob({
            role: commandTask.role,
            prompt: commandTask.prompt,
            title: `运行能力命令：${String(input.commandId)}`,
            acceptance: '完成能力命令并返回实际结果和证据。',
            nodeId: commandTask.nodeId,
            workspaceKey: commandTask.workspaceKey,
            workspaceMode: commandTask.workspaceMode,
            assistantSnapshot: commandTask.assistantSnapshot,
            contextExtra: commandTask.contextExtra,
            capabilityCommand: commandTask.capabilityCommand,
          }, principal);
          break;
        }
        case 'list_teams':
          response = control.listTeamSpaces(principal);
          break;
        case 'delegate_to_team':
          response = control.delegateToTeam(input, principal);
          break;
        case 'read_team_task':
          response = control.readTeamTask(input, principal);
          break;
        case 'read_team_roster':
          response = control.readTeamRoster(principal);
          break;
        case 'propose_team': {
          // 未显式指定绑定能力时，按成员职责自动推荐并填入草案；
          // hub 项只作为建议返回，不写入权限。
          let payload = input;
          if (capabilities && input.autoRecommend !== false && Array.isArray(input.members)) {
            const members = [];
            for (const member of input.members) {
              const query = [member.name, member.responsibility, ...(Array.isArray(member.deliverables) ? member.deliverables : []), ...(Array.isArray(member.skills) ? member.skills : [])]
                .filter((part) => typeof part === 'string' && part.trim()).join(' ');
              // 分两次取：本地候选（内置+已安装）与含 Hub 的全局候选。
              // 否则 Hub 的高分项会把内置 Skill 挤出 top N。
              let local = [], global = [];
              if (query) {
                try { local = await capabilities.recommend(query, { limit: 6, includeHub: false }); } catch { local = []; }
                try { global = await capabilities.recommend(query, { limit: 8 }); } catch { global = []; }
              }
              const builtin = local.filter((item) => item.source === 'builtin').slice(0, 2).map((item) => item.id);
              // 只自动绑定低风险能力：中/高风险仍需用户逐项确认，只作为建议展示。
              const installed = local
                .filter((item) => item.source === 'installed' && item.enabled !== false && item.risk?.requiresReview !== true)
                .slice(0, 2)
                .map((item) => item.capabilityId || item.id);
              const hub = global.filter((item) => item.source === 'hub').slice(0, 4)
                .map((item) => ({ id: item.id, title: item.title, categoryLabel: item.categoryLabel || null, installUrl: item.installUrl || null }));
              members.push({
                ...member,
                skillIds: Array.isArray(member.skillIds) && member.skillIds.length ? member.skillIds : builtin,
                capabilityIds: Array.isArray(member.capabilityIds) && member.capabilityIds.length ? member.capabilityIds : installed,
                recommendations: { builtin, installed, hub },
              });
            }
            payload = { ...input, members };
          }
          response = control.proposeTeam(payload, principal);
          break;
        }
        case 'list_agents':
          response = { items: control.store.tasks().filter(task => control.taskGroup(task.id) === principal.groupId).slice(0, 100).map(task => ({
            taskId: task.id, agentId: task.role, name: control.store.role(task.role)?.name,
            status: task.status, title: task.title, jobId: control.records.get('task-meta', task.id)?.jobId,
          })) };
          break;
        case 'read_inbox': response = { items: control.readMessages(principal.taskId, principal) }; break;
        case 'ack_message': response = control.acknowledge(input.id, input, principal); break;
        case 'send_message': response = control.sendMessage(input, principal); break;
        case 'delegate_task': response = control.createJob(input, principal); break;
        case 'save_checkpoint': response = control.saveScoped('checkpoints', input, principal); break;
        case 'submit_artifact': response = control.saveScoped('artifacts', input, principal); break;
        case 'read_board': response = { items: control.records.list('board').filter(record => record.groupId === principal.groupId).slice(0, 100) }; break;
        case 'read_shared_context': response = control.readSharedContext(principal); break;
        case 'share_context': response = control.shareContext(input, principal); break;
        case 'update_board': response = control.saveScoped('board', input, principal, input.id); break;
        case 'request_attention': response = control.saveScoped('attention', input, principal); break;
        case 'begin_operation': response = control.operation(input, principal); break;
        case 'list_operation_reviews': {
          let ops = control.records.list('operations').filter(item => item.groupId === principal.groupId);
          if (input.operationId) ops = ops.filter(item => item.id === input.operationId);
          response = { items: ops.map(item => ({ ...item, review: control.reviewState(item) })).slice(0, 50) };
          break;
        }
        case 'submit_operation_review': response = control.submitReview(input.operationId, input, principal); break;
        case 'complete_operation': {
          const result = await control.handle({ method: 'POST', parts: ['operations', input.id, 'result'], body: input, principal });
          if (result.status >= 400) throw new Error(result.body.error);
          response = result.body;
          break;
        }
        default: throw new Error('工具不存在。');
      }
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  return server;
}

export function createOrchestrationHandler({ control, capabilities }) {
  return async (req, res, parsedBody) => {
    const token = bearer(req);
    try { control.validateInstanceToken(token); }
    catch (error) {
      res.writeHead(error.status || 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    const server = createOrchestrationServer({ control, token, capabilities });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      res.once('close', () => { void server.close(); });
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '编排连接失败。' }));
      }
      await server.close();
    }
  };
}

export async function connectOrchestrationStdio({ control, token, capabilities }) {
  control.validateInstanceToken(token);
  const server = createOrchestrationServer({ control, token, capabilities });
  await server.connect(new StdioServerTransport());
  return server;
}
