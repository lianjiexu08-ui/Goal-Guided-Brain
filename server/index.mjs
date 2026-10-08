import http from 'node:http';
import { inspectModelSetup } from './model-setup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { StoreReadIndex } from './store/read-index.mjs';
import { SKILLS } from './roles.mjs';
import { DshRun, findDsh } from './runtime.mjs';
import { lockControl } from './persistence.mjs';
import { createPlatform } from './platform.mjs';
import { assessCapabilityRisk } from './capabilities.mjs';
import { createOrchestrationHandler } from './orchestration-mcp.mjs';
import { createRequestHandler } from './request-handler.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createWorkbench({
  dataDir = process.env.WORKBENCH_DATA_DIR ||
    path.join(os.homedir(), '.dsh-workbench'),
  workspace = repo,
  runtimeFactory = (options) => new DshRun(options),
  requireCredential = true,
  usageMeter,
} = {}) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseControl = lockControl(dataDir);
  let store;
  try {
    store = new Store(dataDir, fs.realpathSync(workspace), {
      seedProjectManager: true,
    });
  } catch (error) {
    releaseControl();
    throw error;
  }
  const runs = new Map();
  const platform = createPlatform({
    store,
    dataDir,
    runs,
    runtimeFactory,
    requireCredential,
    releaseControl,
    usageMeter,
    address: () => `http://127.0.0.1:${server.address()?.port || 3089}`,
  });
  const schedule = platform.schedule;
  const mcp = createOrchestrationHandler({
    control: platform.control,
    capabilities: platform.capabilities,
  });
  const publicTeamTimeline = (spaceId, options = {}) =>
    store
      .teamTimeline(
        spaceId,
        options.limit,
        options.before,
        options.read,
        options.kind,
      )
      .map((item) =>
        item.type === 'message'
          ? {
              ...item,
              attachments: platform.attachments.list(item.attachmentIds),
            }
          : item,
      );
  const teamUsageSummary = (space, read = new StoreReadIndex(store)) => {
    const usedTokens = read.usedTokens(space.id);
    const budgetTokens = Number(space.autonomy?.budgetTokens) || 0;
    const percent =
      budgetTokens > 0
        ? Math.min(100, Math.round((usedTokens / budgetTokens) * 100))
        : 0;
    return {
      usedTokens,
      budgetTokens,
      remainingTokens: Math.max(0, budgetTokens - usedTokens),
      percent,
      warning:
        budgetTokens > 0 &&
        usedTokens >= budgetTokens * 0.8 &&
        usedTokens < budgetTokens,
      exceeded: budgetTokens > 0 && usedTokens >= budgetTokens,
    };
  };
  const publicTaskEvents = (taskId, { after = null, limit = 100 } = {}) => {
    const cursorParts =
      typeof after === 'string' && after.trim() ? after.split('|') : [];
    const afterAt = cursorParts[0] || null;
    const afterId = cursorParts.slice(1).join('|') || null;
    const ordered = store.records
      .list('task-events')
      .filter((event) => event.taskId === taskId)
      .sort((a, b) => {
        const at = String(a.createdAt || '');
        const bt = String(b.createdAt || '');
        return at.localeCompare(bt) || String(a.id).localeCompare(String(b.id));
      })
      .filter(
        (event) =>
          !afterAt ||
          event.createdAt > afterAt ||
          (event.createdAt === afterAt &&
            Boolean(afterId && String(event.id) > afterId)),
      );
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
    const page = ordered.slice(0, pageSize + 1);
    const hasMore = page.length > pageSize;
    const items = (hasMore ? page.slice(0, pageSize) : page).map((event) => ({
      ...event,
      at: event.at || event.createdAt,
    }));
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      cursor: last ? `${last.createdAt}|${last.id}` : after || null,
    };
  };
  const taskEventCursor = (event) => `${event.createdAt}|${event.id}`;
  const cursorIsAfter = (event, cursor) => {
    if (!cursor) return true;
    const [afterAt, ...afterIdParts] = String(cursor).split('|');
    const afterId = afterIdParts.join('|');
    return (
      event.createdAt > afterAt ||
      (event.createdAt === afterAt && String(event.id) > afterId)
    );
  };
  const teamCursorIsAfter = (event, cursor) => {
    if (!cursor) return true;
    const [afterAt, ...afterIdParts] = String(cursor).split('|');
    const afterId = afterIdParts.join('|');
    const at = String(event.at || event.createdAt || '');
    return at > afterAt || (at === afterAt && String(event.id) > afterId);
  };
  const streamTaskEvents = (req, res, taskId, after, limit) => {
    let closed = false;
    let cursor = after || null;
    let unsubscribe = () => {};
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const write = (event) => {
      if (closed || !cursorIsAfter(event, cursor)) return;
      cursor = taskEventCursor(event);
      const item = { ...event, at: event.at || event.createdAt };
      try {
        res.write(
          `id: ${cursor}\nevent: task_event\ndata: ${JSON.stringify(item)}\n\n`,
        );
      } catch {
        cleanup();
      }
    };
    unsubscribe = platform.subscribeTaskEvents(taskId, write);
    const initial = publicTaskEvents(taskId, { after, limit });
    for (const event of initial.items) write(event);
    res.write(`event: ready\ndata: ${JSON.stringify({ taskId, cursor })}\n\n`);
    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
  };
  const teamEventCursor = (event) => `${event.at}|${event.id}`;
  const publicTeamEvents = (spaceId, { after = null, limit = 100 } = {}) => {
    const messages = new Map(
      store.teamMessages(spaceId).map((message) => [message.id, message]),
    );
    const ordered = publicTeamTimeline(spaceId, { limit: 200 })
      .map((item) =>
        item.type === 'message' && messages.get(item.messageId)
          ? { ...item, at: messages.get(item.messageId).updatedAt || item.at }
          : item,
      )
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .filter((item) => teamCursorIsAfter(item, after));
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
    // A fresh stream starts at the newest window; a resumed stream walks
    // forward from its cursor so no later item is skipped.
    const page = after
      ? ordered.slice(0, pageSize + 1)
      : ordered.slice(-(pageSize + 1));
    const hasMore = page.length > pageSize;
    const items = hasMore ? page.slice(0, pageSize) : page;
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      cursor: last ? teamEventCursor(last) : after || null,
    };
  };
  const streamTeamEvents = (req, res, spaceId, after, limit) => {
    let closed = false;
    let cursor = after || null;
    let unsubscribe = () => {};
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const write = (event) => {
      if (closed || !teamCursorIsAfter(event, cursor)) return;
      cursor = teamEventCursor(event);
      try {
        res.write(
          `id: ${cursor}\nevent: team_event\ndata: ${JSON.stringify(event)}\n\n`,
        );
      } catch {
        cleanup();
      }
    };
    // Subscribe before replaying history so a message written during the
    // replay window cannot be lost. The cursor check removes duplicates.
    unsubscribe = platform.subscribeTeamEvents(spaceId, write);
    const initial = publicTeamEvents(spaceId, { after, limit });
    for (const event of initial.items) write(event);
    res.write(`event: ready\ndata: ${JSON.stringify({ spaceId, cursor })}\n\n`);
    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
  };
  const publicCrossTeamTimeline = ({
    teamId = '',
    kind = 'all',
    limit = 60,
    before = null,
  } = {}) => {
    const teams = store
      .teamSpaces()
      .filter(
        (space) =>
          space.status !== 'archived' &&
          space.recruitment?.phase === 'confirmed',
      )
      .filter(
        (space) =>
          !teamId ||
          teamId === 'all' ||
          space.id === teamId ||
          space.chatId === teamId,
      );
    const matchesKind = (item) => {
      if (kind === 'all') return true;
      if (kind === 'messages') return item.type === 'message';
      if (kind === 'execution')
        return item.type === 'task' || item.type === 'task-event';
      if (kind === 'evidence')
        return ['artifact', 'verification', 'acceptance'].includes(item.type);
      if (kind === 'risk') {
        if (item.type === 'message')
          return item.status === 'blocked' || Boolean(item.error);
        if (item.type === 'task') {
          return (
            [
              'blocked',
              'failed',
              'interrupted',
              'state_unknown',
              'budget-exceeded',
              'budget_exceeded',
            ].includes(item.status || '') ||
            item.deliveryStatus === 'rejected' ||
            Boolean(item.error)
          );
        }
        if (item.type === 'task-event')
          return /fail|error|block|interrupt|budget/i.test(
            item.eventType || '',
          );
        if (item.type === 'acceptance')
          return item.acceptanceDecision === 'rejected';
      }
      return false;
    };
    const pageSize = Math.max(1, Math.min(120, Number(limit) || 60));
    const items = teams
      .flatMap((space) =>
        publicTeamTimeline(space.id, { limit: 200, before }).map((item) => ({
          ...item,
          teamId: space.id,
          teamName: space.name,
          teamType: space.teamType || 'custom',
        })),
      )
      .filter(matchesKind)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    // The cross-team endpoint uses newest-first pages. The cursor points at
    // the oldest item currently rendered, so the next page can append older
    // records without changing the meaning of `before`.
    const window = items.slice(0, pageSize + 1);
    const hasMore = window.length > pageSize;
    return {
      items: hasMore ? window.slice(0, pageSize) : window,
      hasMore,
      total: items.length,
    };
  };
  const publicTeamRisks = ({
    teamId = '',
    kind = 'all',
    status = 'all',
    limit = 50,
    before = null,
  } = {}) => {
    const teams = store
      .teamSpaces()
      .filter(
        (space) =>
          space.status !== 'archived' &&
          space.recruitment?.phase === 'confirmed',
      );
    const teamsById = new Map(teams.map((space) => [space.id, space]));
    const executionRiskStatuses = new Set([
      'blocked',
      'failed',
      'interrupted',
      'state_unknown',
      'budget-exceeded',
      'budget_exceeded',
    ]);
    const deliveryRiskStatuses = new Set([
      'pending-review',
      'awaiting-owner',
      'rejected',
      'failed',
    ]);
    const risks = [];
    const resolveTaskScope = (task) => {
      const meta = store.records.get('task-meta', task.id) || {};
      const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
      const resolvedTeamId =
        meta.spaceId || meta.teamId || job?.spaceId || job?.teamId || null;
      return {
        teamId: resolvedTeamId,
        team: resolvedTeamId ? teamsById.get(resolvedTeamId) : null,
        meta,
        job,
      };
    };
    for (const task of store.tasks()) {
      const scope = resolveTaskScope(task);
      if (!scope.team) continue;
      const delivery = store.taskDelivery(task);
      const executionRisk =
        executionRiskStatuses.has(task.status) ||
        (task.status !== 'completed' && Boolean(task.error));
      const deliveryRisk = deliveryRiskStatuses.has(delivery.deliveryStatus);
      if (!executionRisk && !deliveryRisk) continue;
      const riskKind = executionRisk ? 'execution' : 'delivery';
      const riskStatus = executionRisk ? task.status : delivery.deliveryStatus;
      risks.push({
        id: `task:${task.id}`,
        sourceType: 'task',
        kind: riskKind,
        status: riskStatus,
        title:
          riskKind === 'delivery' ? `交付待处理：${task.title}` : task.title,
        detail:
          task.error ||
          (riskStatus === 'awaiting-owner'
            ? '等待所有者验收交付。'
            : riskStatus === 'pending-review'
              ? '执行已结束，等待验证证据复核。'
              : riskStatus === 'rejected'
                ? delivery.acceptanceNote || '交付已退回复核。'
                : '执行需要检查或恢复。'),
        updatedAt: task.updatedAt || task.createdAt,
        teamId: scope.team.id,
        teamName: scope.team.name,
        taskId: task.id,
        jobId: scope.meta.jobId || null,
        groupId: scope.meta.groupId || scope.job?.groupId || null,
        deliveryStatus: delivery.deliveryStatus,
        acceptanceDecision: delivery.acceptanceDecision,
      });
    }
    for (const attention of store.records.list('attention')) {
      if (['resolved', 'dismissed'].includes(attention.status)) continue;
      const task = attention.taskId ? store.task(attention.taskId) : null;
      const scope = task
        ? resolveTaskScope(task)
        : {
            teamId: attention.teamId || attention.spaceId || null,
            team: teamsById.get(attention.teamId || attention.spaceId || ''),
            meta: attention.taskId
              ? store.records.get('task-meta', attention.taskId) || {}
              : {},
            job: attention.jobId
              ? store.records.get('jobs', attention.jobId)
              : null,
          };
      if (!scope.team) continue;
      const kind = attention.kind === 'plan-overdue' ? 'plan' : 'attention';
      risks.push({
        id: `attention:${attention.id}`,
        sourceType: 'attention',
        kind,
        sourceKind: attention.kind || 'attention',
        status: attention.status || 'open',
        title: attention.title || '需要你处理',
        detail: attention.detail || '团队有一项需要确认的事项。',
        updatedAt: attention.updatedAt || attention.createdAt,
        teamId: scope.team.id,
        teamName: scope.team.name,
        taskId: attention.taskId || null,
        jobId: attention.jobId || scope.meta.jobId || null,
        groupId:
          attention.groupId || scope.meta.groupId || scope.job?.groupId || null,
        attentionId: attention.id,
      });
    }
    for (const item of store.knowledge()) {
      if (item.scope !== 'team' || (!item.expired && !item.expiresSoon))
        continue;
      const team = teamsById.get(item.teamId || '');
      if (!team) continue;
      const expired = item.expired === true;
      const expiresAt = item.expiresAt ? item.expiresAt.slice(0, 10) : '';
      risks.push({
        id: `knowledge:${item.id}`,
        sourceType: 'knowledge',
        kind: 'knowledge',
        status: expired ? 'expired' : 'expires-soon',
        title: `${expired ? '知识已过期' : '知识即将过期'}：${item.title}`,
        detail: expired
          ? `复核日期为 ${expiresAt}，已停止自动注入，请确认是否仍然有效。`
          : `复核日期为 ${expiresAt}，建议提前检查并更新内容。`,
        updatedAt: item.updatedAt || item.createdAt,
        teamId: team.id,
        teamName: team.name,
        knowledgeId: item.id,
      });
    }
    const cursor =
      typeof before === 'string' && before.trim() ? before.split('|') : [];
    const beforeAt = cursor[0] || null;
    const beforeId = cursor.slice(1).join('|') || null;
    const filtered = risks
      .filter((risk) => !teamId || risk.teamId === teamId)
      .filter((risk) => kind === 'all' || risk.kind === kind)
      .filter((risk) => status === 'all' || risk.status === status)
      .filter((risk) => typeof risk.updatedAt === 'string' && risk.updatedAt)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      )
      .filter(
        (risk) =>
          !beforeAt ||
          risk.updatedAt < beforeAt ||
          (risk.updatedAt === beforeAt &&
            Boolean(beforeId && risk.id < beforeId)),
      );
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const page = filtered.slice(0, pageSize + 1);
    return {
      items: page.slice(0, pageSize),
      hasMore: page.length > pageSize,
      total: filtered.length,
    };
  };
  const teamRiskCounts = (read) => {
    const executionRiskStatuses = new Set([
      'blocked',
      'failed',
      'interrupted',
      'state_unknown',
      'budget-exceeded',
      'budget_exceeded',
    ]);
    const deliveryRiskStatuses = new Set([
      'pending-review',
      'awaiting-owner',
      'rejected',
      'failed',
    ]);
    const teams = new Map(
      read
        .teamSpaces()
        .filter(
          (space) =>
            space.status !== 'archived' &&
            space.recruitment?.phase === 'confirmed',
        )
        .map((space) => [space.id, space]),
    );
    const counts = Object.fromEntries([...teams.keys()].map((id) => [id, 0]));
    const scopeForTask = (task) => {
      const meta = read.get('task-meta', task.id) || {};
      const job = meta.jobId ? read.get('jobs', meta.jobId) : null;
      const teamId =
        meta.spaceId || meta.teamId || job?.spaceId || job?.teamId || null;
      return teams.has(teamId) ? teamId : null;
    };
    for (const task of read.tasks()) {
      const teamId = scopeForTask(task);
      if (!teamId) continue;
      const delivery = read.taskDelivery(task);
      const executionRisk =
        executionRiskStatuses.has(task.status) ||
        (task.status !== 'completed' && Boolean(task.error));
      const deliveryRisk = deliveryRiskStatuses.has(delivery.deliveryStatus);
      if (executionRisk || deliveryRisk) counts[teamId] += 1;
    }
    for (const attention of read.list('attention')) {
      if (['resolved', 'dismissed'].includes(attention.status)) continue;
      const task = attention.taskId ? read.task(attention.taskId) : null;
      const teamId = task
        ? scopeForTask(task)
        : teams.has(attention.teamId || attention.spaceId)
          ? attention.teamId || attention.spaceId
          : null;
      if (teamId) counts[teamId] += 1;
    }
    for (const item of read.knowledge()) {
      if (item.scope !== 'team' || (!item.expired && !item.expiresSoon))
        continue;
      if (teams.has(item.teamId)) counts[item.teamId] += 1;
    }
    return counts;
  };
  const getState = ({ includeTeamActivity = true } = {}) => {
    const read = new StoreReadIndex(store);
    const roles = store.roles();
    const providers = platform.providers.list();
    const modelSetup = inspectModelSetup({
      providers,
      vault: platform.vault,
      legacyAvailable: !providers.length && platform.hasCredential(),
    });
    return {
      ...(!includeTeamActivity ? { teamActivityDeferred: true } : {}),
      roles,
      skillCatalog: SKILLS.map(({ id, name }) => ({ id, name })),
      unreadNotificationCount: read
        .list('notifications')
        .filter((item) => item.read !== true && !item.readAt).length,
      openAttentionCount: read
        .list('attention')
        .filter((item) => !['resolved', 'dismissed'].includes(item.status))
        .length,
      teamRiskCounts: teamRiskCounts(read),
      capabilities: platform.capabilities.list().map((capability) => ({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        version: capability.version || null,
        revision: capability.revision || null,
        digest: capability.digest || null,
        enabled: capability.enabled !== false,
        description: capability.description || '',
        tools: Array.isArray(capability.tools) ? capability.tools : [],
        risk: assessCapabilityRisk(capability),
        health: capability.health
          ? {
              ok: capability.health.ok === true,
              checkedAt: capability.health.checkedAt || null,
              latencyMs: capability.health.latencyMs || null,
              toolCount: Array.isArray(capability.health.tools)
                ? capability.health.tools.length
                : null,
            }
          : null,
      })),
      providers: providers.map((provider) => ({
        credentialState: modelSetup.credentialStates[provider.id],
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        enabled: provider.enabled !== false,
        priority: provider.priority,
        health: provider.health
          ? {
              ok: provider.health.ok === true,
              model: provider.health.model || null,
              toolTest: provider.health.toolTest === true,
              structured: provider.health.structured === true,
              latencyMs: provider.health.latencyMs || null,
              checkedAt: provider.health.checkedAt || null,
              error: provider.health.ok ? null : provider.health.error || null,
            }
          : null,
        models: (provider.models || []).map((model) => ({
          id: model.id,
          name: model.name,
          tools: model.tools === true,
          vision: model.vision === true,
          contextWindow: model.contextWindow,
        })),
      })),
      tasks: (() => {
        return read.tasks().map(({ context: _context, log: _log, ...t }) => {
          const meta = read.get('task-meta', t.id) || {};
          const job = meta.jobId ? read.get('jobs', meta.jobId) : null;
          const delivery = read.taskDelivery(t);
          return {
            ...t,
            log: '',
            jobId: meta.jobId || null,
            groupId: meta.groupId || job?.groupId || null,
            parentTaskId: meta.parentTaskId || null,
            spaceId: meta.spaceId || job?.spaceId || null,
            teamId:
              meta.teamId ||
              job?.teamId ||
              meta.spaceId ||
              job?.spaceId ||
              null,
            parentJobId: job?.parentJobId || null,
            artifactCount: delivery.evidenceCount,
            verificationStatus: delivery.hasVerificationEvidence
              ? delivery.acceptanceStatus
              : null,
            deliveryStatus: delivery.deliveryStatus,
            acceptanceDecision: delivery.acceptanceDecision,
            acceptanceNote: delivery.acceptanceNote,
            currentRequirementVersion: delivery.currentRequirementVersion,
            attachmentIds: Array.isArray(meta.attachmentIds)
              ? meta.attachmentIds
              : [],
            attachments: platform.attachments.list(meta.attachmentIds),
          };
        });
      })(),
      sessions: store.sessions(),
      knowledge: read.knowledge(),
      spaces: read.teamSpaces().map((space) => ({
        ...space,
        planRevision: read.get('team-plans', space.id)?.revision || 0,
        autonomyUsage: teamUsageSummary(space, read),
        ...(includeTeamActivity
          ? {
              messages: read
                .group('space-messages', 'spaceId', space.id)
                .map((message) => ({
                  ...message,
                  attachmentIds: Array.isArray(message.attachmentIds)
                    ? message.attachmentIds
                    : [],
                  attachments: platform.attachments.list(message.attachmentIds),
                })),
              timeline: publicTeamTimeline(space.id, { read }),
            }
          : {}),
      })),
      teamTemplates: store.teamTemplates(),
      config: {
        ...store.config,
        hasApiKey: platform.hasCredential(),
        modelSetup: modelSetup.summary,
        dshReady: !!findDsh(),
        dataDir,
        roleSkills: Object.fromEntries(
          roles.map((role) => [
            role.id,
            SKILLS.filter((s) => role.skillIds.includes(s.id)).map(
              (s) => s.name,
            ),
          ]),
        ),
        roleInstructions: Object.fromEntries(
          roles.map((role) => [role.id, role.instructions]),
        ),
      },
    };
  };
  const required = (value, label, max = 32000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new Error(`${label}不能为空，且不能超过 ${max} 字符。`);
    return value.trim();
  };
  const roleValue = (value) => {
    if (
      typeof value !== 'string' ||
      !store.role(value) ||
      store.role(value).archived
    )
      throw new Error('助手不存在或已归档。');
    return value;
  };
  const newTask = platform.newTask;
  const server = http.createServer();
  const handle = createRequestHandler({
    store,
    platform,
    mcp,
    dataDir,
    getServer: () => server,
    newTask,
    getState,
    publicTaskEvents,
    streamTaskEvents,
    publicTeamEvents,
    streamTeamEvents,
    publicTeamRisks,
    publicCrossTeamTimeline,
    publicTeamTimeline,
    teamUsageSummary,
    required,
    roleValue,
  });
  server.on('request', handle);
  return {
    server,
    store,
    runs,
    platform,
    getState,
    schedule,
    async close() {
      await platform.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const app = createWorkbench();
  const port = Number(process.env.WORKBENCH_API_PORT || 3089);
  app.server.listen(
    port,
    process.env.WORKBENCH_BIND_HOST || '127.0.0.1',
    () => {
      console.log(`Goal-Guided Brain API: http://127.0.0.1:${port}`);
      void app.schedule();
      app.platform.start();
    },
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
