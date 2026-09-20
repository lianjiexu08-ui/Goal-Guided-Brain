import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bearer, hashToken } from './auth.mjs';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const argumentHash = value => hashToken(JSON.stringify(canonical(value || {})));
export const toolGrantId = (taskId, action, fingerprint) => hashToken(`${taskId}:${action}:${fingerprint}`);
export function approveToolRequest(control, attentionId, taskId) {
  const request = control.records.get('attention', attentionId);
  if (request?.kind !== 'tool-approval') throw new Error('待处理事项不是工具授权请求。');
  const target = taskId || request.taskId;
  if (control.taskGroup(target) !== request.groupId) throw new Error('只能授权同一任务组中的后续执行。');
  const id = toolGrantId(target, request.action, request.argumentHash);
  const grant = control.records.save('operation-grants', { taskId: target, action: request.action,
    argumentHash: request.argumentHash, status: 'approved', attentionId }, id);
  control.records.save('attention', { ...request, status: 'resolved', grantedTaskId: target }, request.id);
  return grant;
}
const preview = value => {
  if (Array.isArray(value)) return value.map(preview);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|secret|token|authorization|api.?key/i.test(key) ? '[redacted]' : preview(item)]));
  return value;
};
const denied = message => Object.assign(new Error(message), { status: 403 });
const redactValue = (value, secrets = []) => {
  let serialized = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  return JSON.parse(serialized);
};

export class CapabilityGate {
  constructor({ control, store }) { this.control = control; this.store = store; }
  identify(token, capabilityId) {
    const principal = this.control.validateInstanceToken(token);
    const meta = this.store.records.get('task-meta', principal.taskId);
    const snapshot = this.store.records.get('runtime-snapshots', principal.taskId);
    const assistant = snapshot?.assistant || meta?.assistantSnapshot;
    if (!assistant?.capabilityIds?.includes(capabilityId)) throw denied('此能力未绑定到当前执行实例。');
    const current = this.store.records.get('capabilities', capabilityId);
    if (!current || current.kind !== 'mcp' || !current.enabled) throw denied('MCP 能力不可用。');
    const capability = snapshot?.capabilityConfigs?.[capabilityId] || current;
    const pinned = snapshot?.capabilities?.find(item => item.id === capabilityId);
    if (!pinned || pinned.revision !== capability.revision) throw denied('MCP 配置与执行快照不一致，请创建新的执行实例。');
    return { principal, capability };
  }
  authorize({ principal, capability, tool, args }) {
    this.control.ensureCurrent(principal);
    if (capability.tools?.length && !capability.tools.includes(tool.name)) throw denied('此工具不在已选择的工具列表中。');
    if (tool.annotations?.readOnlyHint === true) return { allowed: true, readOnly: true };
    const action = `mcp:${capability.id}:${tool.name}`;
    const fingerprint = argumentHash(args);
    const grantId = toolGrantId(principal.taskId, action, fingerprint);
    const grant = this.store.records.get('operation-grants', grantId);
    const approved = principal.permissions.includes(action) || (grant?.status === 'approved' && grant.taskId === principal.taskId &&
      grant.action === action && grant.argumentHash === fingerprint);
    if (!approved) {
      this.control.attention({ kind: 'tool-approval', taskId: principal.taskId, groupId: principal.groupId,
        title: `工具需要授权：${capability.name} / ${tool.name}`, detail: '此工具未声明只读；批准后重试同一操作。',
        action, capabilityId: capability.id, toolName: tool.name, argumentHash: fingerprint, grantId,
        argumentsPreview: JSON.stringify(preview(args)).slice(0, 12000),
      }, `grant:${grantId}`);
      throw denied('此工具可能修改外部状态，已在待处理事项中请求本次操作授权；当前没有执行。');
    }
    const operation = this.control.operation({ action, idempotencyKey: fingerprint,
      title: `${capability.name} / ${tool.name}`, intent: JSON.stringify(preview(args)).slice(0, 12000) },
    { ...principal, permissions: [...principal.permissions, action] });
    if (!operation.canExecute) {
      const cached = this.store.records.get('mcp-results', operation.id);
      if (operation.status === 'succeeded' && cached) return { allowed: false, cached: cached.result, operation };
      throw denied(`该操作已登记为 ${operation.status}，需要先核验结果，不能重复执行。`);
    }
    return { allowed: true, readOnly: false, operation };
  }
  complete(principal, operation, result, error) {
    if (!operation) return;
    const current = this.store.records.get('operations', operation.id);
    if (!current || current.status !== 'pending') return;
    const status = error ? 'unknown' : result?.isError ? 'failed' : 'succeeded';
    this.store.records.save('operations', { ...current, status, evidence: error ? String(error.message || error).slice(0, 5000) :
      `MCP 工具返回 ${result?.isError ? '错误' : '成功'}；结果记录 ${operation.id}`, reportedAt: Date.now() }, operation.id);
    if (!error) this.store.records.save('mcp-results', { taskId: principal.taskId, result }, operation.id);
    if (status === 'unknown') this.control.attention({ kind: 'operation-unknown', taskId: principal.taskId, groupId: principal.groupId,
      title: '工具调用结果未知', detail: '连接中断后未自动重试，请核验外部状态。', operationId: operation.id }, `operation:${operation.id}`);
  }
}

export function createCapabilityGateway({ control, store, vault, clientFactory }) {
  const gate = new CapabilityGate({ control, store });
  const connections = new Map();
  let closed = false;
  const connect = async (token, capabilityId) => {
    const identity = gate.identify(token, capabilityId);
    const key = `${identity.principal.taskId}:${capabilityId}`;
    const existing = connections.get(key);
    if (existing) return { ...identity, upstream: await existing.promise, secrets: existing.secrets };
    const entry = { token, secrets: [] };
    const pending = (async () => {
      const capability = identity.capability;
      entry.secrets.push(...[capability.credentialId ? vault.get(capability.credentialId) : null,
        ...Object.values(capability.envRefs || {}).map(ref => vault.get(ref))].filter(Boolean));
      if (clientFactory) return clientFactory(capability, identity.principal);
      const client = new Client({ name: 'dsh-capability-gateway', version: '1.0.0' });
      const transport = capability.transport === 'stdio'
        ? new StdioClientTransport({ command: capability.command, args: capability.args,
          stderr: 'ignore',
          env: Object.fromEntries(Object.entries(capability.envRefs || {}).map(([name, ref]) => [name, vault.get(ref)])) })
        : new StreamableHTTPClientTransport(new URL(capability.url), { requestInit: {
          headers: capability.credentialId ? { Authorization: `Bearer ${vault.get(capability.credentialId)}` } : {},
        } });
      try { await client.connect(transport, { timeout: 15000 }); return client; }
      catch (error) {
        for (const secret of entry.secrets) error.message = error.message.split(secret).join('[redacted]');
        await client.close(); throw error;
      }
    })();
    connections.set(key, { ...entry, promise: pending });
    try { return { ...identity, upstream: await pending, secrets: entry.secrets }; }
    catch (error) {
      for (const secret of entry.secrets) error.message = error.message.split(secret).join('[redacted]');
      connections.delete(key); throw error;
    }
  };
  const sweep = setInterval(() => {
    for (const [key, entry] of connections) {
      try { control.validateInstanceToken(entry.token); }
      catch { connections.delete(key); void entry.promise.then(client => client.close()).catch(() => {}); }
    }
  }, 5000);
  sweep.unref();
  const allTools = async upstream => {
    const tools = [], cursors = new Set();
    let cursor;
    do {
      const page = await upstream.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 2000 || (cursor && cursors.has(cursor))) throw new Error('MCP 工具目录超过限制或分页游标重复。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  };
  const createServer = (token, capabilityId) => {
    // eslint-disable-next-line typescript/no-deprecated -- Gateway forwards upstream JSON tool schemas without altering them.
    const server = new Server({ name: 'dsh-capability-gateway', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { capability, upstream, secrets } = await connect(token, capabilityId);
      try {
        const listed = await allTools(upstream);
        return redactValue({ tools: listed.filter(tool => !capability.tools?.length || capability.tools.includes(tool.name)) }, secrets);
      } catch (error) {
        for (const secret of secrets) error.message = error.message.split(secret).join('[redacted]');
        throw error;
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      let principal, operation, secrets = [];
      try {
        const identity = await connect(token, capabilityId);
        principal = identity.principal;
        secrets = identity.secrets;
        const listed = await allTools(identity.upstream);
        const tool = listed.find(item => item.name === request.params.name);
        if (!tool) throw denied('工具不存在。');
        const current = gate.identify(token, capabilityId);
        const authorization = gate.authorize({ principal: current.principal, capability: current.capability, tool, args: request.params.arguments || {} });
        if (authorization.cached) return authorization.cached;
        operation = authorization.operation;
        const response = await identity.upstream.callTool({ name: tool.name, arguments: request.params.arguments || {} }, undefined, { timeout: 120000 });
        const result = redactValue(response, secrets);
        gate.complete(principal, operation, result);
        return result;
      } catch (error) {
        for (const secret of secrets) error.message = error.message.split(secret).join('[redacted]');
        gate.complete(principal, operation, null, error);
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
    return server;
  };
  return {
    gate, createServer,
    async handle(req, res, parsedBody, capabilityId) {
      const token = bearer(req);
      try {
        if (closed) throw denied('工具网关已停止。');
        gate.identify(token, capabilityId);
      } catch (error) {
        res.writeHead(error.status || 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      const server = createServer(token, capabilityId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        res.once('close', () => { void server.close(); });
        await transport.handleRequest(req, res, parsedBody);
      } catch {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '工具网关请求失败。' })); }
        await server.close();
      }
    },
    async close() {
      closed = true;
      clearInterval(sweep);
      await Promise.allSettled([...connections.values()].map(entry => entry.promise.then(client => client.close())));
      connections.clear();
    },
  };
}
