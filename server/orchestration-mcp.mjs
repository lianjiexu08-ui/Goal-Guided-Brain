import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bearer } from './auth.mjs';
import { SKILLS } from './roles.mjs';

const string = { type: 'string' };
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'list_capabilities', description: '查看当前助手本次执行已绑定的 Skill、MCP 和 Plugin 能力；只读，不会授予新权限。', inputSchema: objectSchema() },
  { name: 'run_capability_command', description: '运行当前助手已绑定 Plugin 中一个可调用的命令；命令会作为受控子任务排队，不会直接获得额外权限。', inputSchema: objectSchema({ capabilityId: string, commandId: string, arguments: string }, ['capabilityId', 'commandId']) },
  { name: 'list_teams', description: '查看当前团队允许协作的其他长期团队；只返回团队摘要，不返回其他团队的私有消息。', inputSchema: objectSchema() },
  { name: 'delegate_to_team', description: '把明确的协作目标委派给另一个长期团队的项目经理；目标团队使用自己的模型、能力、预算和权限。', inputSchema: objectSchema({ teamId: string, prompt: string, acceptance: string, idempotencyKey: string }, ['teamId', 'prompt', 'idempotencyKey']) },
  { name: 'read_team_task', description: '读取已获准协作团队中的一个委派任务状态和结果。', inputSchema: objectSchema({ taskId: string }, ['taskId']) },
  { name: 'propose_team', description: '在多轮澄清完成后保存待用户确认的 Team Charter。只保存招募草案，不创建成员、不分派任务；最终确认必须由用户在团队招募界面完成。', inputSchema: objectSchema({
    teamName: string, goal: string, purpose: string,
    members: { type: 'array', minItems: 1, maxItems: 8, items: objectSchema({
      roleId: string, name: string, responsibility: string,
      deliverables: { type: 'array', items: string }, skills: { type: 'array', items: string },
      tools: { type: 'array', items: string }, modelHint: string, dependencies: { type: 'array', items: string },
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
  { name: 'update_board', description: '保存共享结论；更新已有记录必须使用读取到的 revision，避免覆盖并发修改。', inputSchema: objectSchema({ id: string, title: string, content: string, expectedRevision: { type: 'integer', minimum: 1 } }, ['title', 'content']) },
  { name: 'request_attention', description: '向所有者报告需要决定、凭据或人工核验的阻塞事项。', inputSchema: objectSchema({ title: string, content: string, kind: string }, ['title', 'content']) },
  { name: 'begin_operation', description: '登记已被明确授权的外部操作。只有 canExecute=true 才能首次执行；已有记录必须先核验结果。', inputSchema: objectSchema({ action: string, title: string, intent: string, idempotencyKey: string }, ['action', 'intent', 'idempotencyKey']) },
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
        case 'propose_team':
          response = control.proposeTeam(input, principal);
          break;
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
        case 'update_board': response = control.saveScoped('board', input, principal, input.id); break;
        case 'request_attention': response = control.saveScoped('attention', input, principal); break;
        case 'begin_operation': response = control.operation(input, principal); break;
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
