import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { SKILLS } from './roles.mjs';
import { DshRun, findDsh, redact } from './runtime.mjs';
import { c as createTar } from 'tar';
import { lockControl } from './persistence.mjs';
import { createPlatform } from './platform.mjs';
import { assessCapabilityRisk, capabilityFingerprint } from './capabilities.mjs';
import { createOrchestrationHandler } from './orchestration-mcp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createWorkbench({
  dataDir = process.env.WORKBENCH_DATA_DIR ||
    path.join(os.homedir(), '.dsh-workbench'),
  workspace = repo,
  runtimeFactory = (options) => new DshRun(options),
  requireCredential = true,
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
    address: () => `http://127.0.0.1:${server.address()?.port || 3089}`,
  });
  const schedule = platform.schedule;
  const mcp = createOrchestrationHandler({
    control: platform.control,
    capabilities: platform.capabilities,
  });
  const publicTeamTimeline = (spaceId, options = {}) => store
    .teamTimeline(spaceId, options.limit, options.before)
    .map((item) => item.type === 'message'
      ? {
          ...item,
          attachments: platform.attachments.list(item.attachmentIds),
        }
      : item);
  const publicCrossTeamTimeline = ({ teamId = '', kind = 'all', limit = 60, before = null } = {}) => {
    const teams = store.teamSpaces()
      .filter((space) => space.status !== 'archived' && space.recruitment?.phase === 'confirmed')
      .filter((space) => !teamId || teamId === 'all' || space.id === teamId || space.chatId === teamId);
    const matchesKind = (item) => {
      if (kind === 'all') return true;
      if (kind === 'messages') return item.type === 'message';
      if (kind === 'execution') return item.type === 'task' || item.type === 'task-event';
      if (kind === 'evidence') return ['artifact', 'verification', 'acceptance'].includes(item.type);
      if (kind === 'risk') {
        if (item.type === 'message') return item.status === 'blocked' || Boolean(item.error);
        if (item.type === 'task') {
          return [
            'blocked',
            'failed',
            'interrupted',
            'state_unknown',
            'budget-exceeded',
            'budget_exceeded',
          ].includes(item.status || '') || item.deliveryStatus === 'rejected' || Boolean(item.error);
        }
        if (item.type === 'task-event') return /fail|error|block|interrupt|budget/i.test(item.eventType || '');
        if (item.type === 'acceptance') return item.acceptanceDecision === 'rejected';
      }
      return false;
    };
    const pageSize = Math.max(1, Math.min(120, Number(limit) || 60));
    const items = teams
      .flatMap((space) => publicTeamTimeline(space.id, { limit: 200, before }).map((item) => ({
        ...item,
        teamId: space.id,
        teamName: space.name,
        teamType: space.teamType || 'custom',
      })))
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
  const publicTeamRisks = ({ teamId = '', kind = 'all', status = 'all', limit = 50, before = null } = {}) => {
    const teams = store.teamSpaces()
      .filter((space) => space.status !== 'archived' && space.recruitment?.phase === 'confirmed');
    const teamsById = new Map(teams.map((space) => [space.id, space]));
    const executionRiskStatuses = new Set([
      'blocked',
      'failed',
      'interrupted',
      'state_unknown',
      'budget-exceeded',
      'budget_exceeded',
    ]);
    const deliveryRiskStatuses = new Set(['pending-review', 'awaiting-owner', 'rejected', 'failed']);
    const risks = [];
    const resolveTaskScope = (task) => {
      const meta = store.records.get('task-meta', task.id) || {};
      const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
      const resolvedTeamId = meta.spaceId || meta.teamId || job?.spaceId || job?.teamId || null;
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
      const executionRisk = executionRiskStatuses.has(task.status) || (task.status !== 'completed' && Boolean(task.error));
      const deliveryRisk = deliveryRiskStatuses.has(delivery.deliveryStatus);
      if (!executionRisk && !deliveryRisk) continue;
      const riskKind = executionRisk ? 'execution' : 'delivery';
      const riskStatus = executionRisk ? task.status : delivery.deliveryStatus;
      risks.push({
        id: `task:${task.id}`,
        sourceType: 'task',
        kind: riskKind,
        status: riskStatus,
        title: riskKind === 'delivery' ? `交付待处理：${task.title}` : task.title,
        detail: task.error || (riskStatus === 'awaiting-owner'
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
      const scope = task ? resolveTaskScope(task) : {
        teamId: attention.teamId || attention.spaceId || null,
        team: teamsById.get(attention.teamId || attention.spaceId || ''),
        meta: attention.taskId ? store.records.get('task-meta', attention.taskId) || {} : {},
        job: attention.jobId ? store.records.get('jobs', attention.jobId) : null,
      };
      if (!scope.team) continue;
      risks.push({
        id: `attention:${attention.id}`,
        sourceType: 'attention',
        kind: 'attention',
        status: attention.status || 'open',
        title: attention.title || '需要你处理',
        detail: attention.detail || '团队有一项需要确认的事项。',
        updatedAt: attention.updatedAt || attention.createdAt,
        teamId: scope.team.id,
        teamName: scope.team.name,
        taskId: attention.taskId || null,
        jobId: attention.jobId || scope.meta.jobId || null,
        groupId: attention.groupId || scope.meta.groupId || scope.job?.groupId || null,
        attentionId: attention.id,
      });
    }
    const cursor = typeof before === 'string' && before.trim() ? before.split('|') : [];
    const beforeAt = cursor[0] || null;
    const beforeId = cursor.slice(1).join('|') || null;
    const filtered = risks
      .filter((risk) => !teamId || risk.teamId === teamId)
      .filter((risk) => kind === 'all' || risk.kind === kind)
      .filter((risk) => status === 'all' || risk.status === status)
      .filter((risk) => typeof risk.updatedAt === 'string' && risk.updatedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .filter((risk) => !beforeAt || risk.updatedAt < beforeAt || (risk.updatedAt === beforeAt && Boolean(beforeId && risk.id < beforeId)));
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const page = filtered.slice(0, pageSize + 1);
    return {
      items: page.slice(0, pageSize),
      hasMore: page.length > pageSize,
      total: filtered.length,
    };
  };
  const getState = () => ({
    roles: store.roles(),
    skillCatalog: SKILLS.map(({ id, name }) => ({ id, name })),
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
      health: capability.health ? {
        ok: capability.health.ok === true,
        checkedAt: capability.health.checkedAt || null,
        latencyMs: capability.health.latencyMs || null,
        toolCount: Array.isArray(capability.health.tools) ? capability.health.tools.length : null,
      } : null,
    })),
    providers: platform.providers.list().map((provider) => ({
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
      return store.tasks().map(({ context: _context, log: _log, ...t }) => {
        const meta = store.records.get('task-meta', t.id) || {};
        const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
        const delivery = store.taskDelivery(t);
        return {
          ...t,
          log: '',
          jobId: meta.jobId || null,
          groupId: meta.groupId || job?.groupId || null,
          parentTaskId: meta.parentTaskId || null,
          spaceId: meta.spaceId || job?.spaceId || null,
          teamId: meta.teamId || job?.teamId || meta.spaceId || job?.spaceId || null,
          parentJobId: job?.parentJobId || null,
          artifactCount: delivery.evidenceCount,
          verificationStatus: delivery.hasVerificationEvidence ? delivery.acceptanceStatus : null,
          deliveryStatus: delivery.deliveryStatus,
          acceptanceDecision: delivery.acceptanceDecision,
          acceptanceNote: delivery.acceptanceNote,
          currentRequirementVersion: delivery.currentRequirementVersion,
          attachmentIds: Array.isArray(meta.attachmentIds) ? meta.attachmentIds : [],
          attachments: platform.attachments.list(meta.attachmentIds),
        };
      });
    })(),
    sessions: store.sessions(),
    knowledge: store.knowledge(),
    spaces: store.teamSpaces().map((space) => ({
      ...space,
      messages: store.teamMessages(space.id).map((message) => ({
        ...message,
        attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
        attachments: platform.attachments.list(message.attachmentIds),
      })),
      timeline: publicTeamTimeline(space.id),
    })),
    teamTemplates: store.teamTemplates(),
    config: {
      ...store.config,
      hasApiKey: platform.hasCredential(),
      dshReady: !!findDsh(),
      dataDir,
      roleSkills: Object.fromEntries(
        store
          .roles()
          .map((role) => [
            role.id,
            SKILLS.filter((s) => role.skillIds.includes(s.id)).map(
              (s) => s.name,
            ),
          ]),
      ),
      roleInstructions: Object.fromEntries(
        store.roles().map((role) => [role.id, role.instructions]),
      ),
    },
  });
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
  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(body));
    };
    try {
      await platform.ready;
      const port = server.address()?.port;
      const validHosts = new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        '127.0.0.1:3088',
        'localhost:3088',
        `127.0.0.1:${process.env.WORKBENCH_UI_PORT || 3088}`,
        `localhost:${process.env.WORKBENCH_UI_PORT || 3088}`,
      ]);
      const publicUrl = process.env.WORKBENCH_PUBLIC_URL
        ? new URL(process.env.WORKBENCH_PUBLIC_URL)
        : null;
      if (publicUrl) validHosts.add(publicUrl.host);
      if (!validHosts.has(req.headers.host))
        return send(403, { error: '不接受此访问来源。' });
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (
          !['http:', 'https:'].includes(origin.protocol) ||
          !validHosts.has(origin.host) ||
          (publicUrl &&
            origin.host === publicUrl.host &&
            origin.protocol !== publicUrl.protocol)
        )
          return send(403, { error: '只接受本地工作台请求。' });
      }
      const url = new URL(req.url, 'http://127.0.0.1'),
        parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') return send(404, { error: '未找到接口。' });
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        !req.headers['content-type']?.startsWith('application/json')
      )
        return send(415, { error: '请求需要 JSON 内容。' });
      let body = {};
      if (!['GET', 'HEAD'].includes(req.method)) {
        let text = '';
        const bodyLimit = parts[1] === 'attachments' ? 15_000_000 : 512_000;
        for await (const chunk of req) {
          text += chunk;
          if (text.length > bodyLimit)
            return send(413, { error: '请求内容过大。' });
        }
        if (text) body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new Error('请求格式不正确。');
      }
      if (['GET', 'HEAD'].includes(req.method) && parts[1] === 'health')
        return send(200, { ok: true });
      const options = {
        method: req.method,
        parts: parts.slice(1),
        body,
        req,
        query: url.searchParams,
      };
      const authResponse = await platform.auth.handle(options);
      if (authResponse) {
        for (const [key, value] of Object.entries(authResponse.headers || {}))
          res.setHeader(key, value);
        return send(authResponse.status, authResponse.body);
      }
      if (parts[1] === 'mcp') return mcp(req, res, body);
      if (parts[1] === 'capability-mcp' && parts[2])
        return platform.gateway.handle(req, res, body, parts[2]);
      if (platform.control.isMachineRequest(options)) {
        const response = await platform.control.handle(options);
        return send(response.status, response.body);
      }
      const authorization = platform.auth.authorize(req);
      if (!authorization.authorized)
        return send(401, { error: '请先登录工作台。' });
      if (parts[1] === 'attachments') {
        if (req.method === 'POST' && !parts[2]) {
          const teamId = typeof body.teamId === 'string' && body.teamId.trim()
            ? body.teamId.trim()
            : null;
          if (teamId) {
            const team = store.teamSpace(teamId);
            if (!team || team.status !== 'active') throw new Error('附件所属团队不存在或已暂停。');
          }
          return send(201, platform.attachments.create({
            name: body.name,
            mime: body.mime,
            data: body.data,
            teamId,
          }));
        }
        if (parts[2] && req.method === 'GET') {
          const attachment = platform.attachments.metadata(parts[2]);
          if (!attachment) return send(404, { error: '附件不存在。' });
          return send(200, attachment);
        }
        if (parts[2] && req.method === 'DELETE')
          return send(200, { ok: platform.attachments.remove(parts[2]) });
      }
      if (
        req.method === 'GET' &&
        parts[1] === 'backups' &&
        parts[3] === 'download'
      ) {
        const filename = decodeURIComponent(parts[2]);
        if (
          !platform
            .manage()
            .backups.some((backup) => backup.filename === filename)
        )
          return send(404, { error: '备份不存在。' });
        const directory = path.join(dataDir, 'backups');
        const files = [
          filename,
          ...(fs.existsSync(path.join(directory, `${filename}.vault.json`))
            ? [`${filename}.vault.json`]
            : []),
        ];
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${filename}.tar.gz"`,
        });
        createTar({ cwd: directory, gzip: true, portable: true }, files)
          .on('error', (error) => res.destroy(error))
          .pipe(res);
        return;
      }
      const managed = await platform.handle({
        ...options,
        principal: authorization.principal,
      });
      if (managed) return send(managed.status, managed.body);
      if (req.method === 'GET' && parts[1] === 'state')
        return send(200, getState());
      if (req.method === 'GET' && parts[1] === 'risks')
        return send(200, publicTeamRisks({
          teamId: options.query.get('teamId') || '',
          kind: options.query.get('kind') || 'all',
          status: options.query.get('status') || 'all',
          limit: options.query.get('limit') || 50,
          before: options.query.get('before') || null,
        }));
      if (req.method === 'GET' && parts[1] === 'timeline')
        return send(200, publicCrossTeamTimeline({
          teamId: options.query.get('teamId') || '',
          kind: options.query.get('kind') || 'all',
          limit: options.query.get('limit') || 60,
          before: options.query.get('before') || null,
        }));
      if (req.method === 'PUT' && parts[1] === 'settings') {
        let folder = required(body.workspace, '工作目录', 2000);
        if (folder.startsWith('~/'))
          folder = path.join(os.homedir(), folder.slice(2));
        if (
          !path.isAbsolute(folder) ||
          !fs.existsSync(folder) ||
          !fs.statSync(folder).isDirectory()
        )
          throw new Error('工作目录必须是本机已存在的文件夹绝对路径。');
        const model = required(body.model, '模型', 120);
        if (body.apiKey !== undefined && typeof body.apiKey !== 'string')
          throw new Error('API Key 格式不正确。');
        if (body.apiKey?.trim())
          await platform.saveLegacyCredential(
            required(body.apiKey, 'API Key', 1000),
          );
        store.configure({ workspace: fs.realpathSync(folder), model });
        return send(200, { ok: true });
      }
      if (parts[1] === 'profile' && !parts[2]) {
        if (req.method === 'GET') return send(200, store.profile());
        if (req.method === 'PUT') return send(200, store.saveProfile(body));
      }
      if (parts[1] === 'team-templates') {
        if (req.method === 'GET' && !parts[2]) return send(200, store.teamTemplates());
        if (req.method === 'POST' && !parts[2]) return send(201, store.saveTeamTemplate(body));
        if (parts[2]) {
          const template = store.teamTemplate(parts[2]);
          if (!template) return send(404, { error: '团队模板不存在。' });
          if (req.method === 'GET' && !parts[3]) return send(200, template);
          if (req.method === 'PUT' && !parts[3]) return send(200, store.saveTeamTemplate(body, template.id));
          if (req.method === 'DELETE' && !parts[3]) return send(200, { ok: store.removeTeamTemplate(template.id) });
          if (req.method === 'POST' && parts[3] === 'apply') {
            return send(201, store.createTeamFromTemplate(template.id, body));
          }
        }
      }
      // `teams` is the public name used by the multi-team Chat UI. Keep
      // `/spaces` as a backwards-compatible alias for existing clients.
      if (['spaces', 'teams', 'chats'].includes(parts[1])) {
        if (req.method === 'GET' && !parts[2])
          return send(200, store.teamSpaces());
        if (req.method === 'POST' && !parts[2])
          return send(201, store.saveTeamSpace(body));
        if (parts[2]) {
          const space = store.teamSpace(parts[2]);
          if (!space) return send(404, { error: '团队空间不存在。' });
          if (req.method === 'GET' && !parts[3]) {
            const tasks = store
              .tasks()
              .map((task) => {
                const meta = store.records.get('task-meta', task.id) || {};
                const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
                const delivery = store.taskDelivery(task);
                return {
                  ...task,
                  jobId: meta.jobId || null,
                  groupId: meta.groupId || job?.groupId || null,
                  parentTaskId: meta.parentTaskId || null,
                  spaceId: meta.spaceId || job?.spaceId || null,
                  teamId: meta.teamId || job?.teamId || meta.spaceId || job?.spaceId || null,
                  workspaceMode: meta.workspaceMode || job?.workspaceMode || null,
                  artifactCount: delivery.evidenceCount,
                  verificationStatus: delivery.hasVerificationEvidence ? delivery.acceptanceStatus : null,
                  deliveryStatus: delivery.deliveryStatus,
                  acceptanceDecision: delivery.acceptanceDecision,
                  acceptanceNote: delivery.acceptanceNote,
                  currentRequirementVersion: delivery.currentRequirementVersion,
                };
              })
              .filter((task) => task.spaceId === space.id)
              .map(({ context: _context, log: _log, ...task }) => {
                const attachmentIds = store.records.get('task-meta', task.id)?.attachmentIds || [];
                return {
                  ...task,
                  log: '',
                  attachmentIds,
                  attachments: platform.attachments.list(attachmentIds),
                };
              });
            return send(200, {
              ...space,
              messages: store.teamMessages(space.id).map((message) => ({
                ...message,
                attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
                attachments: platform.attachments.list(message.attachmentIds),
              })),
              timeline: publicTeamTimeline(space.id),
              tasks,
              jobs: store.records.list('jobs').filter((job) => job.spaceId === space.id),
            });
          }
          if (req.method === 'GET' && parts[3] === 'timeline') {
            const requestedLimit = Math.max(1, Math.min(120, Number(options.query.get('limit')) || 60));
            const page = publicTeamTimeline(space.id, {
              limit: requestedLimit + 1,
              before: options.query.get('before') || null,
            });
            const hasMore = page.length > requestedLimit;
            return send(200, {
              items: hasMore ? page.slice(1) : page,
              hasMore,
            });
          }
          if (req.method === 'GET' && parts[3] === 'recruitment' && !parts[4]) {
            const page = store.recruitmentPage(space.id, {
              after: options.query.get('after') || null,
              limit: options.query.get('limit') || 100,
            });
            const { items: recruitmentItems, ...recruitmentSummary } = page;
            return send(200, {
              ...recruitmentSummary,
              messages: recruitmentItems.map((message) => ({
                ...message,
                attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
                attachments: platform.attachments.list(message.attachmentIds),
              })),
            });
          }
          if (req.method === 'PUT' && !parts[3]) {
            const requestedRecruitment = body.recruitment;
            if (
              requestedRecruitment &&
              typeof requestedRecruitment === 'object' &&
              !Array.isArray(requestedRecruitment) &&
              requestedRecruitment.phase !== undefined &&
              requestedRecruitment.phase !== space.recruitment.phase
            )
              throw Object.assign(new Error('团队招募阶段只能通过招募流程推进。'), { status: 409 });
            return send(200, store.saveTeamSpace(body, space.id));
          }
          if (req.method === 'POST' && parts[3] === 'recruitment' && parts[4] === 'confirm') {
            return send(200, platform.control.confirmTeamRecruitment(space.id, {
              version: body.version,
              capabilityApprovals: body.capabilityApprovals,
            }, authorization.principal));
          }
          if (req.method === 'GET' && parts[3] === 'collaborators') {
            if (space.recruitment?.phase !== 'confirmed' || space.collaboration?.enabled === false) return send(200, []);
            const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
              ? space.collaboration.allowedTeamIds
              : [];
            const collaborators = store.teamSpaces()
              .filter((candidate) => candidate.id !== space.id && candidate.status === 'active' && candidate.recruitment?.phase === 'confirmed')
              .filter((candidate) => !allowed.length || allowed.includes(candidate.id))
              .map(({ id: candidateId, name: candidateName, teamType: candidateTeamType, purpose: candidatePurpose, pmRoleId: candidatePmRoleId, status: candidateStatus }) => ({
                id: candidateId,
                chatId: store.teamSpace(candidateId)?.chatId || candidateId,
                name: candidateName,
                teamType: candidateTeamType || 'custom',
                purpose: candidatePurpose || '',
                pmRoleId: candidatePmRoleId,
                status: candidateStatus,
              }));
            return send(200, collaborators);
          }
          if (req.method === 'POST' && parts[3] === 'collaborate') {
            if (space.status !== 'active') throw new Error('团队空间当前不可发起协作。');
            if (space.recruitment?.phase !== 'confirmed')
              throw Object.assign(new Error('当前团队尚未完成招募。'), { status: 409 });
            if (space.collaboration?.enabled === false)
              throw Object.assign(new Error('当前团队未启用跨团队协作。'), { status: 409 });
            const targetId = required(body.targetTeamId || body.teamId, '目标团队');
            const target = store.teamSpaces().find((candidate) => candidate.id === targetId || candidate.chatId === targetId);
            if (!target || target.status !== 'active') throw new Error('目标团队不存在或已暂停。');
            if (target.recruitment.phase !== 'confirmed') throw Object.assign(new Error('目标团队尚未完成招募。'), { status: 409 });
            if (target.id === space.id) throw new Error('目标团队不能是当前团队。');
            const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
              ? space.collaboration.allowedTeamIds
              : [];
            if (allowed.length && !allowed.includes(target.id) && !allowed.includes(target.chatId)) throw new Error('当前团队未允许与目标团队协作。');
            const content = required(body.content, '协作目标', 32000);
            const clientMessageId = required(body.clientMessageId || randomUUID(), '消息 ID', 200);
            const handoffId = `handoff:${space.id}:${target.id}:${clientMessageId}`;
            const previous = store.records.get('space-messages', handoffId);
            if (previous && previous.status !== 'blocked') {
              const sourceMessageId = `${handoffId}:source`;
              if (!store.records.get('space-messages', sourceMessageId)) {
                store.saveTeamMessage({
                  ...previous,
                  spaceId: space.id,
                  teamId: space.id,
                  relatedMessageId: previous.id,
                  taskId: previous.taskId,
                }, sourceMessageId);
              }
              return send(200, {
                ...previous,
                sourceTeamId: space.id,
                targetTeamId: target.id,
                sourceMessageId,
              });
            }
            const targetJobs = store.records.list('jobs').filter((job) => (job.teamId || job.spaceId) === target.id);
            if (targetJobs.length >= (target.autonomy?.maxJobs || 32)) throw new Error('目标团队已达到任务上限。');
            const message = store.saveTeamMessage({
              spaceId: target.id,
              teamId: target.id,
              clientMessageId,
              kind: 'handoff',
              senderType: 'team',
              senderId: space.id,
              fromTeamId: space.id,
              toTeamId: target.id,
              content,
              status: 'sent',
            }, handoffId);
            const task = newTask({
              role: target.pmRoleId,
              prompt: `团队「${space.name}」向本团队发起协作请求。请阅读请求并自主判断是否接受、拆解和安排执行。\n\n协作目标：\n${content}`,
              workspace: target.workspace,
              teamId: target.id,
              spaceId: target.id,
              sourceMessageId: message.id,
            });
            const linked = store.saveTeamMessage({ ...message, taskId: task.id }, message.id);
            const sourceLinked = store.saveTeamMessage(
              {
                ...message,
                spaceId: space.id,
                teamId: space.id,
                relatedMessageId: message.id,
                taskId: task.id,
              },
              `${handoffId}:source`,
            );
            return send(201, {
              ...linked,
              taskId: task.id,
              sessionId: task.sessionId,
              sourceTeamId: space.id,
              targetTeamId: target.id,
              sourceMessageId: sourceLinked.id,
            });
          }
          if (req.method === 'POST' && parts[3] === 'messages') {
            if (space.status !== 'active') throw new Error('团队空间当前不可接收新消息。');
            const attachmentIds = platform.attachments.validateIds(body.attachmentIds, space.id);
            const content = typeof body.content === 'string' ? body.content.trim() : '';
            if (!content && !attachmentIds.length) throw new Error('团队消息不能为空，且不能超过 32000 字符。');
            const messageContent = content || '请查看随附文件并处理。';
            const clientMessageId = required(body.clientMessageId || randomUUID(), '消息 ID', 200);
            const existing = store
              .teamMessages(space.id)
              .find((message) => message.clientMessageId === clientMessageId && message.kind === 'request');
            if (existing && existing.status !== 'blocked') return send(200, existing);
            const message = existing
              ? store.saveTeamMessage(
                  { ...existing, status: 'sent', taskId: null, attachmentIds },
                  existing.id,
                )
              : store.saveTeamMessage(
                  {
                    spaceId: space.id,
                    teamId: space.id,
                    clientMessageId,
                    kind: 'request',
                    senderType: 'owner',
                    senderId: 'owner',
                    content: messageContent,
                    attachmentIds,
                    status: 'sent',
                  },
                  `request:${space.id}:${clientMessageId}`,
                );
            const recruitment = space.recruitment || {};
            const spaceTasks = store.tasks().filter((task) => {
              const meta = store.records.get('task-meta', task.id) || {};
              return meta.spaceId === space.id && task.role === space.pmRoleId;
            });
            const activePmTask = spaceTasks.find((task) => ['queued', 'running'].includes(task.status));
            const pmTask = activePmTask
              || (recruitment.sessionId && spaceTasks.find((task) => task.sessionId === recruitment.sessionId));
            try {
              if (activePmTask)
                throw Object.assign(new Error('项目经理正在处理上一条消息，请等待完成后再继续。'), { status: 409 });
              const task = newTask({
                role: space.pmRoleId,
                prompt: recruitment.phase === 'confirmed'
                  ? `你正在负责已经确认的团队「${space.name}」。请阅读团队历史和当前消息，按已确认的成员职责拆解任务，使用 delegate_task 推进，并跟踪结果后汇总。只有用户明确提出重新招募或团队范围发生重大变化时，才回到团队招募流程；否则不要调用 propose_team。\n\n用户本轮消息：\n${messageContent}`
                  : `你正在负责团队空间「${space.name}」的团队招募。当前阶段：${recruitment.phase || 'discovery'}。请先阅读招募历史和已有团队上下文，继续与用户多轮澄清目标、交付物、约束、质量标准、工作目录、权限和模型/工具需求。需求未清楚前不要分派任务；信息充分后使用 propose_team 保存待用户确认的 Team Charter。Team Charter 确认前不要把成员说成已创建，也不要调用 delegate_task。\n\n用户本轮消息：\n${messageContent}`,
                sessionId: pmTask?.sessionId,
                workspace: space.workspace,
                spaceId: space.id,
                sourceMessageId: message.id,
                model: body.model || space.model || undefined,
                providerId: body.providerId || space.providerId || undefined,
                allowModelWithoutTools: body.allowModelWithoutTools === true,
                attachmentIds,
              });
              store.saveTeamSpace({
                ...space,
                recruitment: {
                  ...recruitment,
                  sessionId: task.sessionId,
                  turns: (recruitment.turns || 0) + 1,
                },
              }, space.id);
              const linkedMessage = store.saveTeamMessage({ ...message, taskId: task.id }, message.id);
              return send(201, { ...linkedMessage, sessionId: task.sessionId });
            } catch (error) {
              store.records.save('space-messages', { ...message, status: 'blocked', error: error.message }, message.id);
              throw error;
            }
          }
        }
      }
      if (parts[1] === 'roles') {
        if ((req.method === 'POST' && !parts[2]) || (req.method === 'PUT' && parts[2] && !parts[3])) {
          const existingRole = parts[2] ? store.role(parts[2]) : null;
          const capabilityIds = Array.isArray(body.capabilityIds)
            ? body.capabilityIds
            : existingRole?.capabilityIds || [];
          const previousIds = new Set(existingRole?.capabilityIds || []);
          const approvals = body.capabilityApprovals && typeof body.capabilityApprovals === 'object' && !Array.isArray(body.capabilityApprovals)
            ? body.capabilityApprovals
            : existingRole?.capabilityApprovals || {};
          const auditRows = [];
          for (const capabilityId of capabilityIds) {
            const capability = platform.capabilities.list().find((item) => item.id === capabilityId);
            if (!capability) continue;
            if (capability.enabled === false) throw new Error(`绑定能力「${capability.name || capabilityId}」前请先启用能力。`);
            const risk = assessCapabilityRisk(capability);
            if (!risk.requiresReview) continue;
            const capabilityDigest = capabilityFingerprint(capability);
            const approval = approvals?.[capabilityId];
            const validApproval = approval?.confirmed === true &&
              typeof approval.digest === 'string' && approval.digest === capabilityDigest;
            if (!validApproval) {
              const error = new Error(`绑定能力「${capability.name || capabilityId}」前需要逐项确认：${risk.reasons.join('；')}`);
              error.status = 409;
              error.code = 'CAPABILITY_BINDING_REVIEW_REQUIRED';
              throw error;
            }
            const previousApproval = existingRole?.capabilityApprovals?.[capabilityId];
            if (!previousIds.has(capabilityId) || previousApproval?.digest !== capabilityDigest)
              auditRows.push({ capability, risk, approval, digest: capabilityDigest });
          }
          const saved = store.saveRole({ ...body, capabilityApprovals: approvals }, parts[2]);
          for (const { capability, risk, approval, digest } of auditRows) {
            store.records.save('capability-audits', {
              capabilityId: capability.id,
              action: 'bind',
              roleId: saved.id,
              actor: 'owner',
              confirmed: true,
              riskLevel: risk.level,
              requiresReview: true,
              digest,
              reasons: risk.reasons.slice(0, 12),
              confirmedAt: approval.confirmedAt || new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
          }
          return send(req.method === 'POST' ? 201 : 200, saved);
        }
        if (req.method === 'POST' && ['archive', 'restore'].includes(parts[3]))
          return send(200, store.archiveRole(parts[2], parts[3] === 'archive'));
      }
      if (['POST', 'PUT'].includes(req.method) && parts[1] === 'knowledge') {
        const existingKnowledge = req.method === 'PUT' && parts[2]
          ? store.knowledge().find((item) => item.id === parts[2])
          : null;
        const knowledgeScope = typeof body.scope === 'string'
          ? body.scope
          : existingKnowledge?.scope;
        const knowledgeTeamId = knowledgeScope === 'team'
          ? (typeof body.teamId === 'string' ? body.teamId : existingKnowledge?.teamId)
          : undefined;
        if (
          !['personal', 'project', 'team', ...store.roles().map((r) => r.id)].includes(
            knowledgeScope,
          )
        )
          throw new Error('知识范围无效。');
        if (!['draft', 'confirmed'].includes(body.state))
          throw new Error('知识状态无效。');
        if (
          req.method === 'PUT' &&
          !existingKnowledge
        )
          return send(404, { error: '知识不存在。' });
        const item = store.saveKnowledge(
          {
            title: required(body.title, '标题', 160),
            content: required(body.content, '知识内容', 100000),
            projectPath:
              typeof body.projectPath === 'string' &&
              (body.projectPath === store.config.workspace ||
                store.sessions().some((s) => s.workspace === body.projectPath))
                ? body.projectPath
                : undefined,
            scope: knowledgeScope,
            ...(knowledgeTeamId ? { teamId: knowledgeTeamId } : {}),
            state: body.state,
            source:
              typeof body.source === 'string'
                ? body.source.slice(0, 2000)
                : '手动添加',
          },
          req.method === 'PUT' ? parts[2] : undefined,
        );
        return send(200, item);
      }
      if (parts[1] === 'knowledge' && parts[2]) {
        if (req.method === 'GET' && parts[3] === 'history')
          return send(
            200,
            store.records
              .list('knowledge-history')
              .filter((item) => item.knowledgeId === parts[2]),
          );
        if (req.method === 'DELETE')
          return send(200, { ok: store.deleteKnowledge(parts[2]) });
      }
      if (req.method === 'POST' && parts[1] === 'tasks' && !parts[2])
        return send(
          201,
          newTask({
            role: roleValue(body.role),
            prompt: typeof body.prompt === 'string' && body.prompt.trim()
              ? required(body.prompt, '任务')
              : body.attachmentIds?.length
                ? '请查看随附文件并处理。'
                : required(body.prompt, '任务'),
            sessionId: body.sessionId,
            teamId: body.teamId || body.spaceId,
            spaceId: body.spaceId || body.teamId,
            ownerInitiated: true,
            nodeId: body.nodeId,
            providerIds: body.providerIds,
            providerId: body.providerId,
            model: body.model,
            allowModelWithoutTools: body.allowModelWithoutTools === true,
            attachmentIds: body.attachmentIds,
            budgetTokens: body.budgetTokens,
            workspaceMode: body.workspaceMode,
            workspaceKey: body.workspaceKey,
            workspace: body.sessionId
              ? store.sessions().find((s) => s.id === body.sessionId)?.workspace
              : undefined,
          }),
        );
      if (req.method === 'POST' && parts[1] === 'tasks' && parts[2]) {
        const task = store.task(parts[2]);
        if (!task) return send(404, { error: '任务不存在。' });
        if (parts[3] === 'cancel') {
          return send(200, await platform.stopTask(task.id));
        }
        if (parts[3] === 'retry') {
          if (
            !['failed', 'interrupted', 'cancelled', 'state_unknown'].includes(
              task.status,
            )
          )
            throw new Error('只有失败、停止或中断的任务可以重试。');
          const previousMeta = store.records.get('task-meta', task.id) || {};
          if (store.records.get('jobs', previousMeta.jobId)?.budgetExceeded)
            throw new Error('请先调整任务组预算，再恢复执行。');
          const retry = newTask({
            ...previousMeta,
            providerIds:
              body.providerIds ??
              previousMeta.allowedProviderIds ??
              previousMeta.providerIds,
            allowedProviderIds:
              body.providerIds ??
              previousMeta.allowedProviderIds ??
              previousMeta.providerIds,
            workspaceMode: 'isolated',
            role: task.role,
            prompt: task.prompt,
            sessionId: task.sessionId,
            workspace: task.workspace,
            // Every retry is a new execution attempt. Keep the direct source
            // instance on the replacement so the task detail can show the
            // lineage and old results remain immutable for review.
            sourceTaskId: task.id,
            attachmentIds: previousMeta.attachmentIds,
            contextExtra: `继续执行 ${task.id}。先核验已有成果与外部操作，再完成未完成部分。\n失败原因：${task.error || '未提供'}\n已有结果：${task.result || '无'}`,
          });
          const meta = store.records.get('task-meta', retry.id);
          const job = store.records.get('jobs', meta.jobId);
          if (job)
            store.records.save(
              'jobs',
              { ...job, taskId: retry.id, status: 'queued' },
              job.id,
            );
          return send(201, retry);
        }
        if (parts[3] === 'handoff') {
          if (task.status !== 'completed' || !task.result)
            throw new Error('请等待原任务完成并生成成果后再交接。');
          const role = roleValue(body.role);
          if (role === task.role) throw new Error('请选择另一个助手。');
          const previousMeta = store.records.get('task-meta', task.id) || {};
          const previousJob = previousMeta.jobId
            ? store.records.get('jobs', previousMeta.jobId)
            : null;
          const teamId = previousMeta.teamId || previousMeta.spaceId || previousJob?.teamId || previousJob?.spaceId || null;
          return send(
            201,
            newTask({
              role,
              prompt: required(body.note, '交接要求'),
              sourceTaskId: task.id,
              workspace: task.workspace,
              ...(teamId ? { teamId, spaceId: teamId, ownerInitiated: true } : {}),
            }),
          );
        }
      }
      send(404, { error: '未找到接口。' });
    } catch (error) {
      send(error.status || 400, { error: redact(error.message) });
    }
  }
  const server = http.createServer(handle);
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
