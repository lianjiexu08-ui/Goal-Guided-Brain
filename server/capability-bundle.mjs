import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

function bounded(value, max = 2000) {
  return String(value || '').slice(0, max);
}

function inside(root, relative) {
  const destination = path.resolve(root, relative);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`))
    throw new Error('能力文件路径越界。');
  return destination;
}

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
  if (source.length > 100000)
    throw new Error(`插件 Markdown 文件过大：${filename}`);
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = front ? parse(front[1]) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error(`插件 Markdown 元数据无效：${filename}`);
  const body = front ? source.slice(front[0].length) : source;
  const name = bounded(metadata.name || path.basename(filename, '.md'), 100);
  const diagnostics = [];
  if (/(?:^|\s)!`|^\s*```!/m.test(body))
    diagnostics.push('原平台 shell 预处理尚不支持，不能直接运行此命令。');
  if (metadata.context === 'fork')
    diagnostics.push(
      'context: fork 需要映射为工作台子任务，不能直接运行此命令。',
    );
  if (metadata.hooks || metadata.mcpServers || metadata.permissionMode)
    diagnostics.push(
      '模板中的 hooks、mcpServers 和 permissionMode 不会授予执行权限。',
    );
  if (
    metadata.memory ||
    metadata.background ||
    metadata.maxTurns ||
    metadata.effort
  )
    diagnostics.push(
      '原平台 memory、background、maxTurns 和 effort 仅保留为参考。',
    );
  if (metadata['allowed-tools'])
    diagnostics.push(
      'allowed-tools 保留为参考，实际权限由工作台助手和工具网关决定。',
    );
  const list = (value) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item === 'string')
      : typeof value === 'string'
        ? value.match(/[A-Za-z][A-Za-z0-9_-]*(?:\([^)]*\))?/g) || []
        : [];
  return {
    id: `${kind}-${createHash('sha256').update(filename).digest('hex').slice(0, 16)}`,
    name,
    path: filename,
    description: bounded(
      metadata.description || body.trim().split(/\r?\n/)[0] || name,
      1000,
    ),
    body,
    argumentHint: bounded(metadata['argument-hint'], 1000),
    argumentNames: list(metadata.arguments),
    modelHint: bounded(metadata.model, 120),
    requestedTools: list(metadata.tools || metadata['allowed-tools']),
    disallowedTools: list(metadata.disallowedTools),
    userInvocable: !['false', 'no', 'off', '0'].includes(
      String(metadata['user-invocable']).toLowerCase(),
    ),
    context: metadata.context || 'inline',
    isolation: metadata.isolation || null,
    diagnostics,
    runnable: !diagnostics.some((value) =>
      /shell 预处理|context: fork/.test(value),
    ),
  };
}

function componentFiles(root, files, defaultDirectory, declared) {
  const paths = [
    defaultDirectory,
    ...(typeof declared === 'string'
      ? [declared]
      : Array.isArray(declared)
        ? declared
        : []),
  ];
  const result = new Set();
  for (const location of paths) {
    if (typeof location !== 'string')
      throw new Error('插件组件路径必须是字符串。');
    const relative = path.relative(root, inside(root, location));
    for (const filename of files)
      if (
        filename.endsWith('.md') &&
        (filename === relative || filename.startsWith(`${relative}${path.sep}`))
      )
        result.add(filename);
  }
  return [...result].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const variableReference = (value) =>
  typeof value === 'string' &&
  /\$\{[A-Z_][A-Z0-9_]*\}/.test(value) &&
  !/\$\{[^}]*:-/.test(value);

function readMcpEntries(root, files, manifest) {
  const candidates = ['.mcp.json', 'mcp.json'];
  if (typeof manifest.mcpServers === 'string')
    candidates.unshift(manifest.mcpServers);
  const entries = {};
  if (
    manifest.mcpServers &&
    typeof manifest.mcpServers === 'object' &&
    !Array.isArray(manifest.mcpServers)
  )
    Object.assign(entries, manifest.mcpServers);
  for (const candidate of new Set(candidates)) {
    const relative = path.relative(root, inside(root, candidate));
    if (!files.includes(relative)) continue;
    const config = JSON.parse(fs.readFileSync(inside(root, relative), 'utf8'));
    const servers = config.mcpServers || config;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new Error('插件 MCP 配置必须是服务器映射。');
    for (const [name, server] of Object.entries(servers))
      if (name !== '$schema') entries[name] = server;
  }
  return Object.entries(entries).map(([name, config]) => {
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error(`插件 MCP 配置无效：${name}`);
    if (
      config.args &&
      (!Array.isArray(config.args) ||
        config.args.some((value) => typeof value !== 'string'))
    )
      throw new Error(`插件 MCP 参数无效：${name}`);
    if (
      ['env', 'headers'].some(
        (key) =>
          config[key] &&
          (typeof config[key] !== 'object' || Array.isArray(config[key])),
      )
    )
      throw new Error(`插件 MCP 环境或认证配置无效：${name}`);
    for (const [key, value] of Object.entries(config.env || {})) {
      if (typeof value !== 'string')
        throw new Error(`插件 MCP 环境变量无效：${name}`);
      if (value && !variableReference(value))
        throw new Error(
          `插件 MCP ${name} 包含内联环境配置 ${key}；请先改成环境变量占位符，凭据必须由工作台单独配置。`,
        );
    }
    for (const [key, value] of Object.entries(config.headers || {})) {
      if (
        value &&
        /authorization|api[-_]?key|token|secret|cookie/i.test(key) &&
        !variableReference(value)
      )
        throw new Error(`插件 MCP ${name} 包含内联认证头；请改成凭据占位符。`);
    }
    for (let index = 0; index < (config.args || []).length; index++) {
      const arg = config.args[index];
      if (
        /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/i.test(
          arg,
        )
      ) {
        const value = arg.includes('=')
          ? arg.slice(arg.indexOf('=') + 1)
          : config.args[index + 1];
        if (value && !variableReference(value))
          throw new Error(`插件 MCP ${name} 包含内联凭据参数。`);
      }
    }
    if (config.url) {
      const url = new URL(config.url);
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /token|password|secret|api[-_]?key/i.test(key),
        )
      )
        throw new Error(
          `插件 MCP ${name} 的地址包含凭据，请使用独立认证配置。`,
        );
    }
    const requiredEnv = Object.keys(config.env || {});
    const requiredHeaders = Object.keys(config.headers || {}).filter((key) =>
      /authorization|api[-_]?key|token|secret|cookie/i.test(key),
    );
    return {
      id: `mcp-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`,
      name,
      config,
      requiredEnv,
      requiredHeaders,
      diagnostics:
        requiredEnv.length || requiredHeaders.length
          ? ['需要配置独立凭据引用。']
          : [],
    };
  });
}

export function inspectBundle(root) {
  const files = filesIn(root);
  let bytes = 0;
  const hash = createHash('sha256');
  for (const relative of files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const data = fs.readFileSync(inside(root, relative));
    bytes += data.length;
    if (bytes > 50000000) throw new Error('能力包超过 50 MB。');
    hash.update(relative).update('\0').update(data);
  }
  const manifestFile = [
    'plugin.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ].find((name) => files.includes(name));
  const manifest = manifestFile
    ? JSON.parse(fs.readFileSync(inside(root, manifestFile), 'utf8'))
    : {};
  const skills = files
    .filter((name) => path.basename(name) === 'SKILL.md')
    .map((filename) => {
      const text = fs.readFileSync(inside(root, filename), 'utf8');
      const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const meta = front ? parse(front[1]) : {};
      if (
        !meta ||
        typeof meta !== 'object' ||
        typeof meta.name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) ||
        typeof meta.description !== 'string' ||
        !meta.description.trim()
      )
        throw new Error(
          `Skill 元数据无效：${filename}，需要 name 和 description。`,
        );
      return {
        name: bounded(meta?.name || path.basename(path.dirname(filename)), 100),
        description: bounded(meta?.description, 1000),
        path: path.dirname(filename),
        dependencies:
          meta?.metadata?.openclaw?.requires ||
          meta?.metadata?.clawdbot?.requires ||
          null,
      };
    });
  const diagnostics = [];
  const commands = componentFiles(
    root,
    files,
    'commands',
    manifest.commands,
  ).map((filename) => markdownComponent(root, filename, 'command'));
  const agents = componentFiles(root, files, 'agents', manifest.agents).map(
    (filename) => markdownComponent(root, filename, 'agent'),
  );
  if (agents.length)
    diagnostics.push(
      '助手模板可导入；原平台模型名称和细粒度工具规则需要人工映射。',
    );
  for (const component of [...commands, ...agents])
    for (const detail of component.diagnostics)
      diagnostics.push(`${component.name}：${detail}`);
  if (
    manifestFile &&
    !manifestFile.startsWith('.claude') &&
    (commands.length || agents.length)
  )
    diagnostics.push(
      'commands/ 和 agents/ 作为工作台模板导入，不代表 Codex 原生插件组件。',
    );
  if (manifest.lspServers || files.includes('.lsp.json'))
    diagnostics.push('LSP 尚不支持。');
  const declaredHooks =
    manifestFile === 'plugin.json'
      ? manifest.extensions?.['com.openai']?.hooks
      : manifest.hooks;
  let hooksPath = files.includes('hooks/hooks.json')
    ? 'hooks/hooks.json'
    : null;
  if (declaredHooks !== undefined) {
    if (typeof declaredHooks === 'string') {
      hooksPath = path.relative(root, inside(root, declaredHooks));
      if (!files.includes(hooksPath))
        throw new Error('插件声明的 Hook 配置文件不存在。');
    } else {
      hooksPath = null;
      diagnostics.push('Hook 内联配置和多文件列表尚未适配，不加载默认 Hook。');
    }
  }
  if (
    manifest.apps ||
    files.includes('.app.json') ||
    manifest.extensions?.['com.openai']?.apps
  )
    diagnostics.push('原平台 App 和专属界面尚未适配。');
  let hooks = null;
  if (hooksPath) {
    hooks = JSON.parse(fs.readFileSync(inside(root, hooksPath), 'utf8'));
    const events = hooks.hooks || hooks;
    if (!events || typeof events !== 'object' || Array.isArray(events))
      throw new Error('Hook 配置格式无效。');
    for (const [event, entries] of Object.entries(events)) {
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !entry ||
            !Array.isArray(entry.hooks) ||
            entry.hooks.some(
              (h) =>
                !h ||
                typeof h !== 'object' ||
                (h.type === 'command' && typeof h.command !== 'string'),
            ),
        )
      )
        throw new Error('Hook 事件需要有效的处理器列表。');
      if (
        ![
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
        ].includes(event)
      )
        diagnostics.push(`Hook ${event} 尚未适配。`);
      if (
        Array.isArray(entries) &&
        entries.some((entry) =>
          entry.hooks?.some((h) => h.type !== 'command' || h.async),
        )
      )
        diagnostics.push(`Hook ${event} 含不支持的类型。`);
    }
  }
  if (skills.some((s) => s.dependencies))
    diagnostics.push('存在 OpenClaw 依赖，启用前需检查执行节点。');
  const mcp = readMcpEntries(root, files, manifest);
  if (mcp.length)
    diagnostics.push('插件 MCP 可导入为停用的独立连接，配置凭据并测试后启用。');
  return {
    name: bounded(manifest.name || skills[0]?.name || path.basename(root), 120),
    kind: manifestFile ? 'plugin' : 'skill',
    format: manifestFile?.startsWith('.claude')
      ? 'claude'
      : manifestFile
        ? 'codex'
        : 'skill',
    version: bounded(manifest.version || 'snapshot', 120),
    digest: hash.digest('hex'),
    files,
    skills,
    commands,
    agents,
    mcp,
    diagnostics,
    hooksPath,
    mcpNames: mcp.map((entry) => entry.name),
    compatibility: diagnostics.length ? 'partial' : 'compatible',
  };
}
export { bounded, inside };
