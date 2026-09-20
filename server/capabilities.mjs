import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { command } from './workspaces.mjs';
import { parse as parseArguments } from 'shell-quote';

function bounded(value, max = 2000) { return String(value || '').slice(0, max); }
function inside(root, relative) {
  const destination = path.resolve(root, relative);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error('能力文件路径越界。');
  return destination;
}
export async function fetchLimited(url, options = {}, maxBytes = 4000000) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`远端返回 ${response.status}${response.status === 429 ? `，请在 ${response.headers.get('retry-after') || '稍后'} 秒后重试` : ''}`);
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('远端内容超过大小限制。'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
const jsonFetch = async url => JSON.parse((await fetchLimited(url)).toString('utf8'));
function filesIn(root, directory = root, output = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('能力包中不允许符号链接。');
    if (item.isDirectory()) filesIn(root, filename, output);
    else if (item.isFile()) {
      output.push(path.relative(root, filename));
      if (output.length > 1000) throw new Error('能力包文件数量超过 1000。');
    }
  }
  return output;
}
function markdownComponent(root, filename, kind) {
  const source = fs.readFileSync(inside(root, filename), 'utf8');
  if (source.length > 100000) throw new Error(`插件 Markdown 文件过大：${filename}`);
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = front ? parse(front[1]) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`插件 Markdown 元数据无效：${filename}`);
  const body = front ? source.slice(front[0].length) : source;
  const name = bounded(metadata.name || path.basename(filename, '.md'), 100);
  const diagnostics = [];
  if (/(?:^|\s)!`|^\s*```!/m.test(body)) diagnostics.push('原平台 shell 预处理尚不支持，不能直接运行此命令。');
  if (metadata.context === 'fork') diagnostics.push('context: fork 需要映射为工作台子任务，不能直接运行此命令。');
  if (metadata.hooks || metadata.mcpServers || metadata.permissionMode) diagnostics.push('模板中的 hooks、mcpServers 和 permissionMode 不会授予执行权限。');
  if (metadata.memory || metadata.background || metadata.maxTurns || metadata.effort) diagnostics.push('原平台 memory、background、maxTurns 和 effort 仅保留为参考。');
  if (metadata['allowed-tools']) diagnostics.push('allowed-tools 保留为参考，实际权限由工作台助手和工具网关决定。');
  const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' ? value.match(/[A-Za-z][A-Za-z0-9_-]*(?:\([^)]*\))?/g) || [] : [];
  return { id: `${kind}-${createHash('sha256').update(filename).digest('hex').slice(0, 16)}`, name, path: filename,
    description: bounded(metadata.description || body.trim().split(/\r?\n/)[0] || name, 1000), body,
    argumentHint: bounded(metadata['argument-hint'], 1000), argumentNames: list(metadata.arguments), modelHint: bounded(metadata.model, 120),
    requestedTools: list(metadata.tools || metadata['allowed-tools']), disallowedTools: list(metadata.disallowedTools),
    userInvocable: !['false', 'no', 'off', '0'].includes(String(metadata['user-invocable']).toLowerCase()),
    context: metadata.context || 'inline', isolation: metadata.isolation || null, diagnostics,
    runnable: !diagnostics.some(value => /shell 预处理|context: fork/.test(value)),
  };
}
function componentFiles(root, files, defaultDirectory, declared) {
  const paths = [defaultDirectory, ...(typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [])];
  const result = new Set();
  for (const location of paths) {
    if (typeof location !== 'string') throw new Error('插件组件路径必须是字符串。');
    const relative = path.relative(root, inside(root, location));
    for (const filename of files) if (filename.endsWith('.md') && (filename === relative || filename.startsWith(`${relative}${path.sep}`))) result.add(filename);
  }
  return [...result].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
const variableReference = value => typeof value === 'string' && /\$\{[A-Z_][A-Z0-9_]*\}/.test(value) && !/\$\{[^}]*:-/.test(value);
function readMcpEntries(root, files, manifest) {
  const candidates = ['.mcp.json', 'mcp.json'];
  if (typeof manifest.mcpServers === 'string') candidates.unshift(manifest.mcpServers);
  const entries = {};
  if (manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) Object.assign(entries, manifest.mcpServers);
  for (const candidate of new Set(candidates)) {
    const relative = path.relative(root, inside(root, candidate));
    if (!files.includes(relative)) continue;
    const config = JSON.parse(fs.readFileSync(inside(root, relative), 'utf8'));
    const servers = config.mcpServers || config;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('插件 MCP 配置必须是服务器映射。');
    for (const [name, server] of Object.entries(servers)) if (name !== '$schema') entries[name] = server;
  }
  return Object.entries(entries).map(([name, config]) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`插件 MCP 配置无效：${name}`);
    if (config.args && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) throw new Error(`插件 MCP 参数无效：${name}`);
    if (['env', 'headers'].some(key => config[key] && (typeof config[key] !== 'object' || Array.isArray(config[key])))) throw new Error(`插件 MCP 环境或认证配置无效：${name}`);
    for (const [key, value] of Object.entries(config.env || {})) {
      if (typeof value !== 'string') throw new Error(`插件 MCP 环境变量无效：${name}`);
      if (value && !variableReference(value)) throw new Error(`插件 MCP ${name} 包含内联环境配置 ${key}；请先改成环境变量占位符，凭据必须由工作台单独配置。`);
    }
    for (const [key, value] of Object.entries(config.headers || {})) {
      if (value && /authorization|api[-_]?key|token|secret|cookie/i.test(key) && !variableReference(value)) throw new Error(`插件 MCP ${name} 包含内联认证头；请改成凭据占位符。`);
    }
    for (let index = 0; index < (config.args || []).length; index++) {
      const arg = config.args[index];
      if (/^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/i.test(arg)) {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : config.args[index + 1];
        if (value && !variableReference(value)) throw new Error(`插件 MCP ${name} 包含内联凭据参数。`);
      }
    }
    if (config.url) {
      const url = new URL(config.url);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|password|secret|api[-_]?key/i.test(key))) throw new Error(`插件 MCP ${name} 的地址包含凭据，请使用独立认证配置。`);
    }
    const requiredEnv = Object.keys(config.env || {});
    const requiredHeaders = Object.keys(config.headers || {}).filter(key => /authorization|api[-_]?key|token|secret|cookie/i.test(key));
    return { id: `mcp-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`, name,
      config, requiredEnv, requiredHeaders, diagnostics: requiredEnv.length || requiredHeaders.length ? ['需要配置独立凭据引用。'] : [] };
  });
}
export function inspectBundle(root) {
  const files = filesIn(root);
  let bytes = 0;
  const hash = createHash('sha256');
  for (const relative of files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const data = fs.readFileSync(inside(root, relative)); bytes += data.length;
    if (bytes > 50000000) throw new Error('能力包超过 50 MB。');
    hash.update(relative).update('\0').update(data);
  }
  const manifestFile = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].find(name => files.includes(name));
  const manifest = manifestFile ? JSON.parse(fs.readFileSync(inside(root, manifestFile), 'utf8')) : {};
  const skills = files.filter(name => path.basename(name) === 'SKILL.md').map(filename => {
    const text = fs.readFileSync(inside(root, filename), 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const meta = front ? parse(front[1]) : {};
    if (!meta || typeof meta !== 'object' || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || typeof meta.description !== 'string' || !meta.description.trim()) throw new Error(`Skill 元数据无效：${filename}，需要 name 和 description。`);
    return { name: bounded(meta?.name || path.basename(path.dirname(filename)), 100), description: bounded(meta?.description, 1000), path: path.dirname(filename), dependencies: meta?.metadata?.openclaw?.requires || meta?.metadata?.clawdbot?.requires || null };
  });
  const diagnostics = [];
  const commands = componentFiles(root, files, 'commands', manifest.commands).map(filename => markdownComponent(root, filename, 'command'));
  const agents = componentFiles(root, files, 'agents', manifest.agents).map(filename => markdownComponent(root, filename, 'agent'));
  if (agents.length) diagnostics.push('助手模板可导入；原平台模型名称和细粒度工具规则需要人工映射。');
  for (const component of [...commands, ...agents]) for (const detail of component.diagnostics) diagnostics.push(`${component.name}：${detail}`);
  if (manifestFile && !manifestFile.startsWith('.claude') && (commands.length || agents.length)) diagnostics.push('commands/ 和 agents/ 作为工作台模板导入，不代表 Codex 原生插件组件。');
  if (manifest.lspServers || files.includes('.lsp.json')) diagnostics.push('LSP 尚不支持。');
  const declaredHooks = manifestFile === 'plugin.json' ? manifest.extensions?.['com.openai']?.hooks : manifest.hooks;
  let hooksPath = files.includes('hooks/hooks.json') ? 'hooks/hooks.json' : null;
  if (declaredHooks !== undefined) {
    if (typeof declaredHooks === 'string') {
      hooksPath = path.relative(root, inside(root, declaredHooks));
      if (!files.includes(hooksPath)) throw new Error('插件声明的 Hook 配置文件不存在。');
    } else {
      hooksPath = null;
      diagnostics.push('Hook 内联配置和多文件列表尚未适配，不加载默认 Hook。');
    }
  }
  if (manifest.apps || files.includes('.app.json') || manifest.extensions?.['com.openai']?.apps) diagnostics.push('原平台 App 和专属界面尚未适配。');
  let hooks = null;
  if (hooksPath) {
    hooks = JSON.parse(fs.readFileSync(inside(root, hooksPath), 'utf8'));
    const events = hooks.hooks || hooks;
    if (!events || typeof events !== 'object' || Array.isArray(events)) throw new Error('Hook 配置格式无效。');
    for (const [event, entries] of Object.entries(events)) {
      if (!Array.isArray(entries) || entries.some(entry => !entry || !Array.isArray(entry.hooks) || entry.hooks.some(h => !h || typeof h !== 'object' || (h.type === 'command' && typeof h.command !== 'string')))) throw new Error('Hook 事件需要有效的处理器列表。');
      if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(event)) diagnostics.push(`Hook ${event} 尚未适配。`);
      if (Array.isArray(entries) && entries.some(entry => entry.hooks?.some(h => h.type !== 'command' || h.async))) diagnostics.push(`Hook ${event} 含不支持的类型。`);
    }
  }
  if (skills.some(s => s.dependencies)) diagnostics.push('存在 OpenClaw 依赖，启用前需检查执行节点。');
  const mcp = readMcpEntries(root, files, manifest);
  if (mcp.length) diagnostics.push('插件 MCP 可导入为停用的独立连接，配置凭据并测试后启用。');
  return { name: bounded(manifest.name || skills[0]?.name || path.basename(root), 120), kind: manifestFile ? 'plugin' : 'skill', format: manifestFile?.startsWith('.claude') ? 'claude' : manifestFile ? 'codex' : 'skill', version: bounded(manifest.version || 'snapshot', 120), digest: hash.digest('hex'), files, skills, commands, agents, mcp, diagnostics, hooksPath, mcpNames: mcp.map(entry => entry.name), compatibility: diagnostics.length ? 'partial' : 'compatible' };
}

export class CapabilityService {
  constructor({ store, vault, dataDir }) { this.store = store; this.vault = vault; this.dir = path.join(dataDir, 'capabilities'); this.cache = new Map(); }
  list() { return this.store.records.list('capabilities'); }
  components(id) {
    const row = this.store.records.get('capabilities', id);
    if (!row?.path || row.kind === 'mcp') throw new Error('能力不包含可导入的插件组件。');
    const actual = inspectBundle(row.path);
    if (actual.digest !== row.digest) throw new Error('插件文件发生变化，请重新安装。');
    return { capabilityId: id, digest: row.digest, name: row.name, format: actual.format,
      commands: actual.commands, agents: actual.agents, mcp: actual.mcp };
  }
  commandTask(id, commandId, input = {}) {
    const row = this.store.records.get('capabilities', id), components = this.components(id);
    const selected = components.commands.find(item => item.id === commandId);
    if (!row.enabled) throw new Error('请先启用插件再运行命令。');
    if (!selected) throw new Error('插件命令不存在。');
    if (!selected.runnable || !selected.userInvocable) throw new Error('此命令依赖尚未适配的原平台行为，或不允许用户直接调用。');
    const role = this.store.role(input.role || 'assistant');
    if (!role || role.archived) throw new Error('请选择可用的助手。');
    const argumentsText = String(input.arguments || '');
    if (argumentsText.length > 32000) throw new Error('命令参数过长。');
    const values = input.argumentValues || parseArguments(argumentsText, name => `$${name}`);
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('参数请使用普通文本和引号，不支持 shell 操作符。');
    const substitutions = selected.body.match(/\$(?:ARGUMENTS(?:\[\d+\])?|\d+|[A-Za-z_][A-Za-z0-9_]*)/g)?.length || 0;
    if (selected.body.length + substitutions * Math.max(argumentsText.length, ...values.map(value => value.length), 0) > 200000) throw new Error('命令展开后的内容超过大小限制。');
    let usedArguments = false;
    let prompt = selected.body.replace(/(\\*)\$(ARGUMENTS(?:\[(\d+)\])?|\d+|[A-Za-z_][A-Za-z0-9_]*)/g, (match, escapes, key, index) => {
      const named = selected.argumentNames.indexOf(key);
      if (key !== 'ARGUMENTS' && !/^ARGUMENTS\[\d+\]$/.test(key) && !/^\d+$/.test(key) && named === -1) return match;
      if (escapes.length === 1) return `$${key}`;
      usedArguments = true;
      const position = index === undefined ? /^\d+$/.test(key) ? Number(key) : named : Number(index);
      const value = key === 'ARGUMENTS' ? argumentsText : values[position] ?? (named >= 0 ? '' : `$${key}`);
      return `${escapes}${value}`;
    });
    if (argumentsText && !usedArguments) prompt += `\n\n用户参数：${argumentsText}`;
    const remote = (input.nodeId || role.nodeId || 'local') !== 'local';
    if (remote && /\$\{(?:CLAUDE_|PLUGIN_ROOT)/.test(prompt)) throw new Error('此命令引用原平台本地路径，请在控制端执行或改成可移植的技能引用。');
    prompt = prompt.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, row.path)
      .replace(/\$\{CLAUDE_SKILL_DIR\}/g, path.dirname(inside(row.path, selected.path)));
    if (/\$\{CLAUDE_(?:SESSION_ID|PROJECT_DIR|PLUGIN_DATA)\}/.test(prompt)) throw new Error('此命令依赖尚未映射的原平台会话变量。');
    return { role: role.id, prompt, nodeId: input.nodeId || role.nodeId || 'local', workspace: input.workspace,
      workspaceKey: input.workspaceKey || 'default', workspaceMode: input.workspaceMode || 'isolated',
      assistantSnapshot: { ...role, capabilityIds: [...new Set([...(role.capabilityIds || []), id])] },
      contextExtra: `插件命令：${row.name}/${selected.name}\n来源摘要：${row.digest}\n原平台工具授权字段只作参考，不能扩大工作台权限。`,
      capabilityCommand: { capabilityId: id, commandId, digest: row.digest } };
  }
  importAgent(id, agentId, overrides = {}) {
    const row = this.store.records.get('capabilities', id), selected = this.components(id).agents.find(item => item.id === agentId);
    if (!selected) throw new Error('插件助手模板不存在。');
    const key = `${id}:${row.digest}:${agentId}`;
    const imported = this.store.records.get('capability-imports', key);
    if (imported && this.store.role(imported.roleId)) return this.store.role(imported.roleId);
    const instructions = `${selected.body}\n\n使用工作台的模型路由、任务通信和权限配置。原平台工具名称及模型名称仅作参考，不会自动授予权限。`;
    const role = this.store.saveRole({ name: bounded(overrides.name || `${row.name} · ${selected.name}`, 60),
      desc: selected.description, instructions, model: overrides.model || '',
      tools: { files: true, web: false, terminal: false, ...overrides.tools },
      skillIds: [], capabilityIds: [id], workspaceMode: 'isolated',
      prompts: [`请按 ${selected.name} 的职责处理当前任务。`],
    });
    this.store.records.save('capability-imports', { capabilityId: id, digest: row.digest, componentId: agentId, roleId: role.id,
      modelHint: selected.modelHint, requestedTools: selected.requestedTools, disallowedTools: selected.disallowedTools,
      diagnostics: selected.diagnostics }, key);
    return role;
  }
  importMcp(id, entryId, overrides = {}) {
    const row = this.store.records.get('capabilities', id), selected = this.components(id).mcp.find(item => item.id === entryId);
    if (!selected) throw new Error('插件 MCP 连接不存在。');
    const connectionId = `plugin-mcp-${createHash('sha256').update(`${id}:${row.digest}:${entryId}`).digest('hex').slice(0, 24)}`;
    const existing = this.store.records.get('capabilities', connectionId);
    if (existing) return existing;
    const replaceRoot = value => String(value || '').replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, row.path);
    const config = selected.config;
    if (config.type && !['stdio', 'http', 'streamable-http', 'sse'].includes(config.type) && !overrides.transport) throw new Error('此 MCP 传输类型需要先映射为受支持的协议。');
    const authorization = Object.entries(config.headers || {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    if (authorization && !/^Bearer \$\{[A-Z_][A-Z0-9_]*\}$/.test(authorization)) throw new Error('当前插件导入仅支持 Authorization Bearer 凭据引用。');
    const transport = overrides.transport || (config.type === 'stdio' || config.command ? 'stdio' : 'streamable-http');
    if (config.type === 'sse' && !overrides.transport) throw new Error('旧 SSE 连接需要提供 Streamable HTTP 地址后再导入。');
    const commandValue = replaceRoot(overrides.command ?? config.command);
    const args = (overrides.args ?? config.args ?? []).map(replaceRoot);
    if ([commandValue, ...args].some(value => /\$\{/.test(value))) throw new Error('命令参数中存在未映射变量，请改为独立环境凭据引用。');
    const connection = this.save({ name: overrides.name || `${row.name} / ${selected.name}`, kind: 'mcp', transport,
      url: overrides.url || config.url, command: commandValue, args,
      envRefs: overrides.envRefs || {}, credentialId: overrides.credentialId || '', enabled: false }, undefined);
    this.store.records.remove('capabilities', connection.id);
    return this.store.records.save('capabilities', { ...connection, sourceCapabilityId: id, sourceDigest: row.digest,
      sourceEntryId: entryId, requiredEnv: selected.requiredEnv, requiredHeaders: selected.requiredHeaders,
      configurationRequired: selected.requiredEnv.some(name => !overrides.envRefs?.[name]) ||
        (selected.requiredHeaders.length > 0 && !overrides.credentialId),
      diagnostics: selected.diagnostics, enabled: false }, connectionId);
  }
  save(input, id) {
    const old = id ? this.store.records.get('capabilities', id) : null;
    if (id && !old) throw new Error('能力不存在。');
    const kind = input.kind || old?.kind || 'mcp';
    if (!['mcp', 'skill', 'plugin'].includes(kind)) throw new Error('能力类型无效。');
    const row = { ...old, name: bounded(input.name || old?.name, 120), kind, enabled: input.enabled ?? old?.enabled ?? false, allowHooks: input.allowHooks ?? old?.allowHooks ?? false };
    if (!row.name) throw new Error('请填写能力名称。');
    if (kind === 'mcp') {
      row.transport = input.transport || old?.transport || 'streamable-http';
      if (!['stdio', 'streamable-http'].includes(row.transport)) throw new Error('不支持此 MCP 传输协议。');
      row.url = bounded(input.url ?? old?.url); row.command = bounded(input.command ?? old?.command, 300);
      row.args = input.args ?? old?.args ?? [];
      if (!Array.isArray(row.args) || row.args.some(a => typeof a !== 'string') || row.args.length > 100) throw new Error('MCP 参数必须为字符串列表。');
      if (row.transport === 'streamable-http') {
        const url = new URL(row.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP 地址格式无效，凭据请单独配置。');
      } else if (!row.command) throw new Error('请填写 MCP 程序。');
      row.credentialId = bounded(input.credentialId ?? old?.credentialId, 100);
      row.envRefs = input.envRefs ?? old?.envRefs ?? {};
      if (!row.envRefs || typeof row.envRefs !== 'object' || Array.isArray(row.envRefs) || Object.entries(row.envRefs).some(([name, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== 'string')) throw new Error('环境配置必须引用凭据 ID。');
      row.tools = Array.isArray(input.tools) ? input.tools.slice(0, 200) : old?.tools || [];
      row.configurationRequired = (row.requiredEnv || []).some(name => !row.envRefs?.[name]) ||
        (row.requiredHeaders || []).some(name => name.toLowerCase() !== 'authorization') ||
        ((row.requiredHeaders || []).length > 0 && !row.credentialId);
      if (row.enabled && row.configurationRequired) throw new Error('插件连接的凭据尚未配置完整。');
      row.compatibility = 'compatible';
    }
    return this.store.records.save('capabilities', row, id);
  }
  async search(source, query) {
    const q = bounded(query, 200).trim();
    if (!q) return [];
    const key = `${source}:${q}`, cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.items;
    let items;
    if (source === 'skillsmp') {
      const data = await jsonFetch(`https://skillsmp.com/api/v1/skills/search?q=${encodeURIComponent(q)}&limit=25`);
      items = (data.data?.skills || data.data?.results || data.skills || []).map(s => ({ id: s.id || s.githubUrl, name: s.name, description: s.description, source, sourceUrl: s.githubUrl, url: s.skillUrl || s.githubUrl, stars: s.stars, kind: 'skill' }));
    } else if (source === 'clawhub') {
      const data = await jsonFetch(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}&nonSuspiciousOnly=true`);
      items = (data.results || data.items || []).map(s => ({ id: s.slug, slug: s.slug, name: s.displayName || s.name || s.slug, description: s.summary, source, sourceUrl: `https://clawhub.ai/skills/${s.slug}`, url: `https://clawhub.ai/skills/${s.slug}`, version: s.version, kind: 'skill' }));
    } else if (source === 'mcp') {
      const data = await jsonFetch(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(q)}&limit=25`);
      items = (data.servers || []).map(item => {
        const s = item.server || item;
        return { id: s.name, name: s.name, description: s.description, source, kind: 'mcp', sourceUrl: s.repository?.url, url: s.repository?.url, version: s.version, remotes: s.remotes, packages: s.packages };
      });
    } else throw new Error('该市场需要独立认证；当前支持 SkillsMP、ClawHub 和 MCP Registry。');
    this.cache.set(key, { until: Date.now() + 300000, items });
    return items;
  }
  async install(input) {
    if (input.source === 'mcp') {
      const remote = input.remotes?.find(r => r.type === 'streamable-http');
      return this.save({ name: input.name, kind: 'mcp', transport: 'streamable-http', url: remote?.url || input.url, enabled: false });
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capability-'));
    let sourceRoot = staging;
    try {
      if (input.source === 'clawhub' && input.slug) {
        const slug = encodeURIComponent(input.slug);
        const detail = await jsonFetch(`https://clawhub.ai/api/v1/skills/${slug}`);
        const version = input.version || detail.latestVersion?.version;
        if (!version) throw new Error('该技能没有公开版本。');
        const release = await jsonFetch(`https://clawhub.ai/api/v1/skills/${slug}/versions/${encodeURIComponent(version)}`);
        const files = release.version?.files || release.files;
        if (!Array.isArray(files) || files.length > 1000) throw new Error('该技能需要从原始 Git 仓库安装，请使用来源地址。');
        for (const file of files) {
          const filename = inside(staging, file.path);
          const content = await fetchLimited(`https://clawhub.ai/api/v1/skills/${slug}/file?path=${encodeURIComponent(file.path)}&version=${encodeURIComponent(version)}`, {}, 2000000);
          fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content, { mode: 0o600 });
        }
      } else {
        const location = String(input.sourceUrl || input.path || '');
        if (path.isAbsolute(location)) sourceRoot = fs.realpathSync(location);
        else {
          const url = new URL(location);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('仓库地址需要 HTTPS，私有凭据请独立配置。');
          let cloneUrl = url.toString(), subdir = input.subdir || '', ref = input.ref;
          if (url.hostname === 'github.com') {
            const segments = url.pathname.split('/').filter(Boolean);
            cloneUrl = `https://github.com/${segments[0]}/${segments[1]}.git`.replace('.git.git', '.git');
            if (['tree', 'blob'].includes(segments[2])) { ref ||= segments[3]; subdir ||= segments.slice(4, segments[2] === 'blob' ? -1 : undefined).join('/'); }
          }
          const repo = path.join(staging, 'repo');
          await command('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', cloneUrl, repo], { timeout: 90000 });
          sourceRoot = inside(repo, subdir);
          if (!fs.existsSync(sourceRoot)) throw new Error('仓库中没有此技能目录。');
        }
      }
      const inspection = inspectBundle(sourceRoot);
      if (!inspection.skills.length && !inspection.hooksPath && !inspection.mcpNames.length && inspection.kind !== 'plugin') throw new Error('目录中未找到 SKILL.md 或插件清单。');
      const id = input.id || randomUUID();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new Error('能力 ID 无效。');
      const previous = this.store.records.get('capabilities', id);
      const destination = path.join(this.dir, id, inspection.digest, 'package');
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(destination)) fs.cpSync(sourceRoot, destination, { recursive: true, filter: source => path.basename(source) !== '.git' && path.basename(source) !== 'node_modules' });
      const value = { ...inspection, path: destination, source: input.source || 'git', sourceUrl: bounded(input.sourceUrl), enabled: false, allowHooks: false, installedAt: new Date().toISOString(), history: previous ? [...(previous.history || []), { digest: previous.digest, path: previous.path, version: previous.version }].slice(-10) : [] };
      return this.store.records.save('capabilities', value, id);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  action(id, action) {
    const row = this.store.records.get('capabilities', id);
    if (!row) throw new Error('能力不存在。');
    if (action === 'rollback') {
      const previous = row.history?.at(-1); if (!previous) throw new Error('没有可以回退的版本。');
      const inspection = inspectBundle(previous.path);
      return this.store.records.save('capabilities', { ...row, ...inspection, path: previous.path,
        ...(previous.content !== undefined ? { content: previous.content } : {}),
        enabled: false, history: row.history.slice(0, -1) }, id);
    }
    if (!['enable', 'disable'].includes(action)) throw new Error('不支持此操作。');
    if (action === 'enable' && row.kind === 'mcp' && ((row.requiredEnv || []).some(name => !row.envRefs?.[name]) ||
      (row.requiredHeaders || []).some(name => name.toLowerCase() !== 'authorization') ||
      ((row.requiredHeaders || []).length && !row.credentialId))) throw new Error('插件连接的凭据尚未配置完整。');
    return this.store.records.save('capabilities', { ...row, enabled: action === 'enable' }, id);
  }
  patch(assistant) {
    const patches = [], selected = [];
    for (const id of assistant.capabilityIds || []) {
      const row = this.store.records.get('capabilities', id);
      if (!row?.enabled) throw new Error(`绑定能力不可用：${row?.name || id}`);
      selected.push({ id, revision: row.revision, digest: row.digest, version: row.version });
      if (row.kind === 'mcp') {
        const config = { serverName: `cap_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`, transport: row.transport, failOnStartupError: true };
        const credential = ref => { const value = this.vault.get(ref); if (!value) throw new Error(`能力凭据不存在：${row.name}`); return value; };
        if (row.transport === 'stdio') { config.command = row.command; config.args = row.args; config.env = Object.fromEntries(Object.entries(row.envRefs || {}).map(([name, ref]) => [name, credential(ref)])); }
        else { config.url = row.url; if (row.credentialId) config.headers = { Authorization: `Bearer ${credential(row.credentialId)}` }; }
        patches.push({ id: `cap-${id}`, name: '@deepseek-ai/dsh-mcp-client', config });
      } else {
        const actual = inspectBundle(row.path);
        if (actual.digest !== row.digest) throw new Error(`能力文件发生变化，请重新安装：${row.name}`);
        const dirs = [...new Set(row.skills.map(s => path.dirname(inside(row.path, s.path))))];
        if (dirs.length) patches.push({ id: 'skill-filesystem', config: { customSkillDirs: dirs } });
        if (row.allowHooks && row.hooksPath && !row.diagnostics.some(s => s.includes('Hook'))) patches.push({ id: `hooks-${id}`, name: `@deepseek-ai/dsh-hooks-${row.format === 'claude' ? 'claude-code' : 'codex'}`, config: { configPath: inside(row.path, row.hooksPath), pluginRoot: row.path, defaultTimeoutMs: 30000 } });
      }
    }
    return { patches, selected };
  }
}
