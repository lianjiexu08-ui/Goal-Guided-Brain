import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { fetchLimited } from './capabilities.mjs';

const active = new Set(['queued', 'running', 'waiting', 'unknown', 'state_unknown']);
const identifier = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');
export function nextTimes(cron, timezone = 'Asia/Shanghai', current = new Date(), count = 5) {
  const expression = CronExpressionParser.parse(cron, { tz: timezone, currentDate: current });
  return Array.from({ length: count }, () => expression.next().toISOString());
}
function intervalSeconds(value = 3600) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31536000)
    throw new Error('执行间隔必须为 60 至 31536000 秒之间的整数。');
  return seconds;
}
export function scheduleNextTimes(rule, currentDate = new Date(), count = 5) {
  const mode = rule.mode ?? 'cron';
  if (!['cron', 'interval'].includes(mode)) throw new Error('定时模式无效。');
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('预览数量必须为 1 至 100 之间的整数。');
  const current = new Date(currentDate);
  if (!Number.isFinite(current.getTime())) throw new Error('当前时间无效。');
  const timezone = rule.timezone || 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(current);
  if (mode === 'cron') return nextTimes(rule.cron || '0 9 * * *', timezone, current, count);
  const interval = intervalSeconds(rule.intervalSeconds) * 1000;
  const anchor = rule.nextRunAt ? Date.parse(rule.nextRunAt) : current.getTime() + interval;
  if (!Number.isFinite(anchor)) throw new Error('下次执行时间无效。');
  // Keep the original cadence after delayed ticks or a controller restart.
  const first = anchor > current.getTime() ? anchor : anchor + (Math.floor((current.getTime() - anchor) / interval) + 1) * interval;
  return Array.from({ length: count }, (_, index) => new Date(first + index * interval).toISOString());
}
export async function runCheck(spec) {
  const start = Date.now(), timeout = Math.min(30000, Math.max(1000, spec.timeoutMs || 10000));
  try {
    if (spec.kind === 'tcp') {
      const url = spec.url ? new URL(spec.url.includes('://') ? spec.url : `tcp://${spec.url}`) : null;
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: spec.host || url?.hostname, port: Number(spec.port || url?.port || 22) });
        socket.setTimeout(timeout);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error('连接超时')); });
        socket.once('error', reject);
      });
    } else {
      await fetchLimited(spec.url, { method: 'GET', signal: AbortSignal.timeout(timeout) }, 8000000);
    }
    return { ok: true, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  } catch (error) { return { ok: false, error: error.message, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() }; }
}

export class AutomationService {
  constructor({ store, createTask, providers, checkMcp, now = () => Date.now() }) { Object.assign(this, { store, createTask, providers, checkMcp, now }); this.busy = false; }
  currentTask(id) {
    const meta = this.store.records.get('task-meta', id);
    const job = meta?.jobId && this.store.records.get('jobs', meta.jobId);
    return this.store.task(job?.taskId || id);
  }
  saveSchedule(input, id) {
    const old = id ? this.store.records.get('schedules', id) : null;
    if (id && !old) throw new Error('定时任务不存在。');
    const name = String(input.name || old?.name || '').trim().slice(0, 120);
    const cron = String(input.cron || old?.cron || '0 9 * * *');
    const timezone = input.timezone || old?.timezone || 'Asia/Shanghai';
    const mode = input.mode ?? old?.mode ?? 'cron';
    const seconds = intervalSeconds(input.intervalSeconds ?? old?.intervalSeconds);
    const role = input.role || old?.role;
    const workflowId = input.workflowId ?? old?.workflowId ?? '';
    if (!name || (!workflowId && !this.store.role(role))) throw new Error('请填写名称并选择助手或工作流。');
    const prompt = String(input.prompt ?? old?.prompt ?? '').trim();
    if (!workflowId && !prompt) throw new Error('请填写定时执行的任务。');
    const candidate = scheduleNextTimes({ mode, cron, timezone, intervalSeconds: seconds }, new Date(this.now()), 1)[0];
    const sameTiming = old && (old.mode ?? 'cron') === mode && old.timezone === timezone && (mode === 'cron' ? old.cron === cron : (old.intervalSeconds ?? 3600) === seconds);
    const nextRunAt = sameTiming && old.nextRunAt ? old.nextRunAt : candidate;
    return this.store.records.save('schedules', { name, mode, cron, intervalSeconds: seconds, timezone, role, prompt, workflowId, nodeId: input.nodeId ?? old?.nodeId ?? 'local', workspaceKey: input.workspaceKey ?? old?.workspaceKey ?? 'default', workspace: input.workspace ?? old?.workspace ?? this.store.config.workspace, enabled: input.enabled ?? old?.enabled ?? false, misfire: (input.misfire || old?.misfire) === 'once' ? 'once' : 'skip', nextRunAt, lastRunAt: old?.lastRunAt || null }, id);
  }
  trigger(rule, scheduledAt, manual = false) {
    const key = manual ? randomUUID() : identifier(rule.id, scheduledAt);
    const previous = this.store.records.get('schedule-runs', key);
    if (previous) return previous;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const overlapping = this.store.records.list('schedule-runs').some(run => run.scheduleId === rule.id && run.taskIds?.some(id => active.has(this.currentTask(id)?.status)));
      const taskIds = []; let status = 'skipped';
      if (!overlapping) {
        const workflow = rule.workflowId ? this.store.records.get('workflows', rule.workflowId) : null;
        if (rule.workflowId && !workflow) throw new Error('绑定的工作流不存在。');
        const steps = workflow?.steps || [{ role: rule.role, prompt: rule.prompt }];
        const batchId = randomUUID();
        for (const step of steps) {
          const task = this.createTask({ role: step.role, prompt: step.prompt, workspace: rule.workspace, nodeId: rule.nodeId, workspaceKey: rule.workspaceKey, batchId, scheduleId: rule.id, dependencies: [...taskIds], workspaceMode: 'isolated', permissions: [] });
          taskIds.push(task.id);
        }
        status = 'queued';
      }
      const result = this.store.records.save('schedule-runs', { scheduleId: rule.id, scheduledAt, manual, taskIds, status, reason: overlapping ? '上一次执行尚未结束。' : '' }, key);
      this.store.records.save('schedules', { ...rule, lastRunAt: new Date(this.now()).toISOString() }, rule.id);
      this.store.db.exec('COMMIT'); return result;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  saveMonitor(input, id) {
    const old = id ? this.store.records.get('monitors', id) : null;
    const row = { ...old, name: String(input.name || old?.name || '').trim().slice(0, 120), kind: input.kind || old?.kind || 'http', url: input.url ?? old?.url ?? '', providerId: input.providerId ?? old?.providerId ?? '', capabilityId: input.capabilityId ?? old?.capabilityId ?? '', intervalSeconds: Number(input.intervalSeconds || old?.intervalSeconds || 300), enabled: input.enabled ?? old?.enabled ?? false, webhookUrl: input.webhookUrl ?? old?.webhookUrl ?? '', nodeId: input.nodeId ?? old?.nodeId ?? 'local', nextCheckAt: old?.nextCheckAt || new Date(this.now()).toISOString() };
    if (!row.name || !['http', 'tcp', 'model', 'mcp'].includes(row.kind) || !Number.isFinite(row.intervalSeconds) || row.intervalSeconds < 30 || row.intervalSeconds > 86400) throw new Error('请填写名称和有效的监控间隔（30 至 86400 秒）。');
    if (['http', 'tcp'].includes(row.kind)) {
      const url = new URL(row.url.includes('://') ? row.url : `tcp://${row.url}`);
      if (row.kind === 'http' && !['https:', 'http:'].includes(url.protocol)) throw new Error('HTTP 监控需要 http 或 https 地址。');
      if (url.username || url.password) throw new Error('监控地址不能包含明文凭据。');
    }
    if (row.webhookUrl) { const url = new URL(row.webhookUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Webhook 地址无效。'); }
    return this.store.records.save('monitors', row, id);
  }
  recordCheck(rule, result) {
    const oldStatus = rule.lastResult?.ok;
    this.store.records.save('monitor-checks', { monitorId: rule.id, ...result, checkedAt: result.checkedAt || new Date(this.now()).toISOString() });
    this.store.records.save('monitors', { ...rule, lastResult: result, nextCheckAt: new Date(this.now() + rule.intervalSeconds * 1000).toISOString(), pendingTaskId: null, manualCheck: false }, rule.id);
    const changed = oldStatus === undefined ? !result.ok : oldStatus !== result.ok;
    if (changed) {
      const notification = this.store.records.save('notifications', { monitorId: rule.id, name: `${rule.name}${result.ok ? '已恢复' : '异常'}`, kind: result.ok ? 'recovered' : 'failed', message: result.error || '监控已恢复正常。', read: false, occurredAt: new Date(this.now()).toISOString() });
      if (rule.webhookUrl) this.store.records.save('deliveries', { notificationId: notification.id, url: rule.webhookUrl, status: 'pending', attempts: 0, nextAttemptAt: new Date(this.now()).toISOString() });
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const rule of this.store.records.list('schedules').filter(s => s.enabled && Date.parse(s.nextRunAt) <= now)) {
        try {
          const missed = now - Date.parse(rule.nextRunAt) > 60000;
          if (!missed || rule.misfire === 'once') this.trigger(rule, rule.nextRunAt);
          else this.store.records.save('schedule-runs', { scheduleId: rule.id, scheduledAt: rule.nextRunAt, taskIds: [], status: 'skipped', reason: '错过执行时间，按规则跳过。' }, identifier(rule.id, rule.nextRunAt));
          const current = this.store.records.get('schedules', rule.id);
          this.store.records.save('schedules', { ...current, nextRunAt: scheduleNextTimes(rule, new Date(now), 1)[0], error: '' }, rule.id);
        } catch (error) {
          this.store.records.save('schedules', { ...rule, enabled: false, error: error.message }, rule.id);
          this.store.records.save('attention', { name: `定时任务无法执行：${rule.name}`, kind: 'schedule', message: error.message, status: 'open', scheduleId: rule.id });
        }
      }
      for (const run of this.store.records.list('schedule-runs').filter(r => r.status === 'queued')) {
        const tasks = run.taskIds.map(id => this.currentTask(id));
        if (tasks.every(t => t && !active.has(t.status))) this.store.records.save('schedule-runs', { ...run, status: tasks.every(t => t.status === 'completed') ? 'completed' : 'failed' }, run.id);
      }
      for (const rule of this.store.records.list('monitors').filter(m => (m.enabled || m.manualCheck || m.pendingTaskId) && Date.parse(m.nextCheckAt) <= now)) {
        if (rule.pendingTaskId) {
          const task = this.store.task(rule.pendingTaskId);
          if (task && active.has(task.status)) continue;
          let result;
          try { result = JSON.parse(task?.result || '{}'); } catch { result = {}; }
          this.recordCheck(rule, typeof result.ok === 'boolean' ? result : { ok: false, error: task?.error || '节点检查没有返回有效结果。' });
          continue;
        }
        if (rule.nodeId !== 'local' && ['http', 'tcp'].includes(rule.kind)) {
          const role = this.store.roles().find(r => !r.archived)?.id;
          const task = this.createTask({ role, prompt: `监控检查：${rule.name}`, nodeId: rule.nodeId, check: { kind: rule.kind, url: rule.url }, workspaceKey: 'default', permissions: [] });
          this.store.records.save('monitors', { ...rule, pendingTaskId: task.id }, rule.id); continue;
        }
        let result;
        try {
          if (rule.kind === 'model') result = await this.providers.probe(rule.providerId, { toolTest: false });
          else if (rule.kind === 'mcp') result = await this.checkMcp(rule.capabilityId);
          else result = await runCheck(rule);
        } catch (error) { result = { ok: false, error: error.message }; }
        this.recordCheck(rule, result);
      }
      for (const delivery of this.store.records.list('deliveries').filter(d => d.status === 'pending' && Date.parse(d.nextAttemptAt) <= now)) {
        const note = this.store.records.get('notifications', delivery.notificationId);
        try {
          const response = await fetch(delivery.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': delivery.notificationId }, body: JSON.stringify({ id: note.id, name: note.name, kind: note.kind, message: note.message, occurredAt: note.occurredAt }), signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) throw new Error(`Webhook 返回 ${response.status}`);
          await response.body?.cancel();
          this.store.records.save('deliveries', { ...delivery, status: 'delivered', attempts: delivery.attempts + 1, deliveredAt: new Date(now).toISOString() }, delivery.id);
        } catch (error) {
          const attempts = delivery.attempts + 1;
          this.store.records.save('deliveries', { ...delivery, attempts, status: attempts >= 5 ? 'failed' : 'pending', error: error.message, nextAttemptAt: new Date(now + 1000 * 2 ** attempts).toISOString() }, delivery.id);
        }
      }
    } finally { this.busy = false; }
  }
}
