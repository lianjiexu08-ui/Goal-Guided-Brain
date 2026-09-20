import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite } from './store.mjs';
import { Records, RECORDS_SCHEMA } from './records.mjs';
import { WorkspaceManager } from './workspaces.mjs';

const loopback = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
export function validateControlUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))) {
    throw new Error('控制端必须使用 HTTPS；仅本机回环地址可以使用 HTTP。');
  }
  return url.origin;
}
export async function runNodeCheck(check, { fetchImpl = fetch } = {}) {
  const timeoutMs = Math.max(100, Math.min(Number(check.timeoutMs) || 10000, 60000));
  const started = Date.now();
  try {
    if (check.kind === 'http') {
      const url = new URL(check.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP 检查地址不支持。');
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
      return { status: 'completed', result: JSON.stringify({ healthy: true, status: response.status, durationMs: Date.now() - started }) };
    }
    if (check.kind === 'tcp') {
      if (typeof check.host !== 'string' || !check.host || !Number.isInteger(check.port) || check.port < 1 || check.port > 65535) throw new Error('TCP 检查参数无效。');
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: check.host, port: check.port });
        const finish = error => { socket.destroy(); if (error) reject(error); else resolve(); };
        socket.setTimeout(timeoutMs, () => finish(new Error('TCP 检查超时。')));
        socket.once('error', finish);
        socket.once('connect', () => finish());
      });
      return { status: 'completed', result: JSON.stringify({ healthy: true, durationMs: Date.now() - started }) };
    }
    throw new Error('监控类型不支持。');
  } catch (error) { return { status: 'failed', error: error.message, result: JSON.stringify({ healthy: false, durationMs: Date.now() - started }) }; }
}

export class NodeClient {
  constructor({ controlUrl, dataDir, workspaces, runtimeFactory, prepareWorkspace, fetchImpl = fetch,
    now = () => Date.now(), heartbeatMs = 10000, maxConcurrent = 3, onEvent = () => {} }) {
    this.controlUrl = validateControlUrl(controlUrl);
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.workspaces = Object.fromEntries(Object.entries(workspaces || {}).map(([name, directory]) => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name) || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('工作目录映射需要名称和本机绝对路径。');
      const resolved = fs.realpathSync(directory);
      if (!fs.statSync(resolved).isDirectory()) throw new Error('工作目录映射必须指向目录。');
      return [name, resolved];
    }));
    if (!Object.keys(this.workspaces).length) throw new Error('至少配置一个工作目录映射。');
    this.runtimeFactory = runtimeFactory;
    this.prepareWorkspace = prepareWorkspace;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.maxConcurrent = Math.max(1, Math.min(maxConcurrent, 16));
    this.onEvent = onEvent;
    this.active = new Map();
    this.stopping = false;
    this.running = false;
    this.tokenFile = path.join(this.dataDir, 'node-identity.json');
    try {
      this.identity = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      if (this.identity.controlUrl !== this.controlUrl) throw new Error('节点身份属于其他控制端，请使用单独的数据目录。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(path.join(this.dataDir, 'outbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rejected_results (id TEXT PRIMARY KEY, data TEXT NOT NULL, reason TEXT NOT NULL, createdAt INTEGER NOT NULL);`);
    this.db.exec(RECORDS_SCHEMA);
    this.workspaceManager = new WorkspaceManager({ store: { records: new Records(this.db) }, dataDir: this.dataDir });
    fs.chmodSync(path.join(this.dataDir, 'outbox.sqlite'), 0o600);
  }
  async request(endpoint, body, anonymous = false) {
    const response = await this.fetchImpl(`${this.controlUrl}/api/nodes/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(!anonymous && this.identity?.token ? { Authorization: `Bearer ${this.identity.token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `节点请求失败：${response.status}`), { status: response.status });
    return data;
  }
  async pair({ code, name }) {
    if (this.active.size) throw new Error('请先停止执行再重新配对。');
    const data = await this.request('pair', { code, name, platform: process.platform, workspaces: Object.keys(this.workspaces) }, true);
    this.identity = { nodeId: data.node.id, token: data.token, controlUrl: this.controlUrl };
    atomicWrite(this.tokenFile, JSON.stringify(this.identity));
    return data.node;
  }
  enqueueResult(taskId, epoch, result) {
    const eventId = `${taskId}:${epoch}:result`;
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,data,createdAt) VALUES(?,?,?)')
      .run(eventId, JSON.stringify({ taskId, epoch, eventId, kind: 'result', ...result }), this.now());
  }
  enqueueEvent(taskId, epoch, sequence, event, secrets = []) {
    let text = JSON.stringify(event);
    for (const secret of secrets.filter(Boolean)) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    if (text.length > 60000 || sequence > 2000) return;
    const eventId = `${taskId}:${epoch}:event:${sequence}`;
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,data,createdAt) VALUES(?,?,?)')
      .run(eventId, JSON.stringify({ taskId, epoch, eventId, kind: 'event', event: JSON.parse(text) }), this.now());
  }
  async flushOutbox() {
    for (const entry of this.db.prepare('SELECT * FROM outbox ORDER BY createdAt,rowid LIMIT 100').all()) {
      try {
        const item = JSON.parse(entry.data);
        await this.request('report', item);
        this.db.prepare('DELETE FROM outbox WHERE id=?').run(entry.id);
        if (item.kind === 'result') this.active.delete(item.taskId);
      } catch (error) {
        if ([403, 409].includes(error.status)) {
          this.db.prepare('INSERT OR REPLACE INTO rejected_results VALUES(?,?,?,?)').run(entry.id, entry.data, error.message, this.now());
          this.db.prepare('DELETE FROM outbox WHERE id=?').run(entry.id);
          this.onEvent({ kind: 'result-rejected', id: entry.id, error: error.message });
          continue;
        }
        throw error;
      }
    }
  }
  async isolatedWorkspace(task) {
    const source = this.workspaces[task.workspaceKey];
    if (!source) throw new Error('控制端请求的工作目录映射在此节点不存在。');
    if (this.prepareWorkspace) return await this.prepareWorkspace({ task: task.task, source, nodeDataDir: this.dataDir });
    const id = task.task.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new Error('执行实例 ID 格式无效。');
    if (this.workspaceManager.store.records.get('workspaces', id)) throw new Error('执行目录已经存在，拒绝重复领取同一实例。');
    const workspace = await this.workspaceManager.prepare({ ...task.task, workspace: source }, 'isolated');
    return { ...workspace, workspace: workspace.path, mode: workspace.kind };
  }
  installBundles(assignment) {
    const bundles = assignment.bundles || [];
    if (!Array.isArray(bundles) || bundles.length > 100) throw new Error('能力包分配数量无效。');
    const mappings = [];
    let totalBytes = 0;
    for (const bundle of bundles) {
      if (!/^[a-f0-9]{64}$/.test(bundle.digest) || typeof bundle.sourceRoot !== 'string' || !path.posix.isAbsolute(bundle.sourceRoot) ||
        !Array.isArray(bundle.files) || bundle.files.length > 1000) throw new Error('远程能力包格式无效。');
      const files = [], names = new Set(), hash = createHash('sha256');
      let bundleBytes = 0;
      for (const file of bundle.files) {
        if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes('\0') || path.posix.isAbsolute(file.path) ||
          file.path.split('/').some(segment => !segment || segment === '..' || segment === '.') || names.has(file.path)) throw new Error('能力包文件路径无效。');
        if (typeof file.base64 !== 'string' || file.base64.length > 70_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('能力包文件编码无效。');
        const data = Buffer.from(file.base64, 'base64');
        bundleBytes += data.length;
        totalBytes += data.length;
        if (bundleBytes > 50_000_000 || totalBytes > 64_000_000) throw new Error('远程能力包超过大小限制。');
        names.add(file.path);
        files.push({ ...file, data });
      }
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      for (const file of files) hash.update(file.path).update('\0').update(file.data);
      if (hash.digest('hex') !== bundle.digest) throw new Error('远程能力包内容摘要不匹配。');
      const cacheRoot = path.join(this.dataDir, 'capabilities');
      fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
      const destination = path.join(cacheRoot, bundle.digest);
      if (fs.existsSync(destination)) {
        for (const file of files) {
          const filename = path.join(destination, file.path);
          if (!fs.existsSync(filename) || fs.lstatSync(filename).isSymbolicLink() || !fs.readFileSync(filename).equals(file.data)) throw new Error('节点缓存能力包已被修改，请检查后移除受损缓存。');
        }
      } else {
        const temporary = path.join(cacheRoot, `.install-${randomUUID()}`);
        fs.mkdirSync(temporary, { mode: 0o700 });
        try {
          for (const file of files) {
            const filename = path.join(temporary, file.path);
            fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
            fs.writeFileSync(filename, file.data, { mode: file.executable ? 0o500 : 0o400 });
          }
          fs.renameSync(temporary, destination);
        } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
      }
      mappings.push({ source: bundle.sourceRoot.replace(/\/$/, ''), destination });
    }
    const remap = value => {
      if (typeof value === 'string') {
        const mapping = mappings.find(item => value === item.source || value.startsWith(`${item.source}/`));
        return mapping ? path.join(mapping.destination, value.slice(mapping.source.length)) : value;
      }
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
      return value;
    };
    const patches = remap(assignment.capabilityPatch || []);
    for (const patch of patches) {
      const config = patch.config || {};
      for (const directory of config.customSkillDirs || []) {
        if (!fs.existsSync(directory)) throw new Error('技能目录在执行节点不存在，请安装对应能力包。');
      }
      if (config.transport === 'stdio') {
        for (const value of [config.command, ...(config.args || [])]) {
          if (typeof value === 'string' && path.isAbsolute(value) && !fs.existsSync(value)) throw new Error('MCP 本地命令或文件在执行节点不存在。');
        }
      }
    }
    return patches;
  }
  async execute(assignment, serverTime) {
    const { task, execution } = assignment;
    if (!task?.id || !execution || execution.taskId !== task.id || this.active.has(task.id)) throw new Error('执行分配格式无效或重复。');
    const state = { taskId: task.id, epoch: execution.epoch,
      deadline: this.now() + Math.max(0, execution.expiresAt - (serverTime || this.now())),
      run: null, done: false, stopping: false, sequence: 0, eventSequence: 0, result: '' };
    this.active.set(task.id, state);
    const done = (status, error = '') => {
      if (state.done) return;
      state.done = true;
      this.enqueueResult(task.id, state.epoch, { status, error, result: state.result });
      this.workspaceManager.finish(task.id, state.stopping ? 'quarantined' : 'retained');
      // Keep renewing the lease until durable events and the final result are acknowledged.
      this.onEvent({ kind: 'finished', taskId: task.id, status });
    };
    try {
      if (assignment.check) {
        const result = await runNodeCheck(assignment.check, { fetchImpl: this.fetchImpl });
        state.result = result.result;
        done(result.status, result.error);
        return;
      }
      const prepared = await this.isolatedWorkspace(assignment);
      if (state.stopping || state.deadline <= this.now()) throw new Error('执行准备期间租约已失效。');
      const capabilityPatch = [...this.installBundles(assignment), {
        id: 'workbench-orchestration', name: '@deepseek-ai/dsh-mcp-client', config: {
          serverName: 'workbench', transport: 'streamable-http', url: `${this.controlUrl}/api/mcp`,
          headers: { Authorization: `Bearer ${assignment.token}` }, failOnStartupError: true,
        },
      }];
      const run = this.runtimeFactory({ task: { ...task, workspace: prepared.workspace }, assistant: assignment.assistant,
        config: assignment.config, route: assignment.route, capabilityPatch,
        maxDurationMinutes: assignment.maxDurationMinutes,
        dataDir: this.dataDir, orchestration: { url: `${this.controlUrl}/api/mcp`, token: assignment.token },
        env: { ...(prepared.tempDir ? { TMPDIR: prepared.tempDir, TMP: prepared.tempDir, TEMP: prepared.tempDir } : {}),
          ...(prepared.port ? { PORT: String(prepared.port) } : {}) },
        onLog: text => {
          const sequence = ++state.sequence;
          void this.request('report', { taskId: task.id, epoch: state.epoch, kind: 'log', sequence, text: String(text).slice(-20000) })
            .catch(error => this.onEvent({ kind: 'log-delayed', taskId: task.id, error: error.message }));
        },
        onResult: result => { state.result = String(result); }, onDone: done,
        onEvent: event => {
          if (!state.done) this.enqueueEvent(task.id, state.epoch, ++state.eventSequence, event, [assignment.route?.secret, assignment.token]);
        },
      });
      state.run = run;
      this.workspaceManager.releasePort(task.id);
      this.onEvent({ kind: 'started', taskId: task.id, workspace: prepared.workspace });
      await run.start(assignment.prompt || assignment.context || task.prompt);
    } catch (error) { done('failed', error.message); }
  }
  async stopExpired(force = false) {
    await Promise.allSettled([...this.active.values()].filter(state => !state.stopping && (force || state.deadline <= this.now())).map(async state => {
      state.stopping = true;
      try {
        if (!state.done && state.run?.cancel) await state.run.cancel();
        else if (!state.done && state.run?.stop) await state.run.stop();
      } catch (error) { this.onEvent({ kind: 'stop-failed', taskId: state.taskId, error: error.message }); }
      if (!state.done) {
        state.done = true;
        this.workspaceManager.finish(state.taskId, 'quarantined');
        this.enqueueResult(state.taskId, state.epoch, { status: 'interrupted', error: '节点停止或执行租约失效，原目录保留待检查。' });
        this.active.delete(state.taskId);
      }
      if (state.done) this.active.delete(state.taskId);
    }));
  }
  async heartbeat() {
    if (this.heartbeating) return;
    this.heartbeating = true;
    let completeHeartbeat;
    this.heartbeatDone = new Promise(resolve => { completeHeartbeat = resolve; });
    try {
    const started = this.now();
    const data = await this.request('heartbeat', { executions: [...this.active.values()].map(state => ({ taskId: state.taskId, epoch: state.epoch })) });
    for (const lease of data.leases || []) {
      const state = this.active.get(lease.taskId);
      if (!state || state.epoch !== lease.epoch) continue;
      state.deadline = lease.active ? started + Math.max(0, lease.expiresAt - data.serverTime) : 0;
    }
    await this.stopExpired();
    } finally { this.heartbeating = false; completeHeartbeat(); this.heartbeatDone = null; }
  }
  async tick() {
    if (this.stopping || this.running) return;
    this.running = true;
    let completeTick;
    this.tickDone = new Promise(resolve => { completeTick = resolve; });
    try {
      await this.stopExpired();
      await this.flushOutbox();
      if (this.stopping) return;
      await this.heartbeat();
      if (this.stopping) return;
      if (this.active.size < this.maxConcurrent) {
        const started = this.now();
        const data = await this.request('claim', {});
        if (data.assignment && !this.stopping) {
          const elapsed = this.now() - started;
          void this.execute(data.assignment, (data.serverTime || this.now()) + elapsed)
            .catch(error => this.onEvent({ kind: 'execution-error', error: error.message }));
        }
      }
    } catch (error) {
      this.onEvent({ kind: 'connection-error', error: error.message });
      if (error.status === 401) {
        this.stopping = true;
        clearInterval(this.timer);
        clearInterval(this.leaseTimer);
        clearInterval(this.heartbeatTimer);
        await this.stopExpired(true);
      }
    } finally { this.running = false; completeTick(); this.tickDone = null; }
  }
  start() {
    if (!this.identity?.token) throw new Error('节点尚未配对。');
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(); }, this.heartbeatMs);
    this.heartbeatTimer = setInterval(() => {
      if (!this.stopping) void this.heartbeat().catch(error => this.onEvent({ kind: 'heartbeat-error', error: error.message }));
    }, this.heartbeatMs);
    this.leaseTimer = setInterval(() => { void this.stopExpired(); }, 1000);
    void this.tick();
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    clearInterval(this.heartbeatTimer);
    if (this.tickDone) await this.tickDone;
    if (this.heartbeatDone) await this.heartbeatDone;
    await this.stopExpired(true);
    try { await this.flushOutbox(); } catch { /* The durable outbox is retried on the next start. */ }
    this.workspaceManager.close();
    this.db.close();
  }
}
