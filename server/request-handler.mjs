import { createTeamHandoff } from './team-handoff.mjs';
import fs from 'node:fs';
import { teamTimelinePage } from './http-team-timeline.mjs';
import { createStateResponder } from './http-state.mjs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { streamBackupDownload } from './http-backup.mjs';
import {
  assessCapabilityRisk,
  capabilityFingerprint,
} from './capabilities.mjs';
import { redact } from './runtime.mjs';
import { teamMessageSession } from './platform/team-conversation.mjs';

export function createRequestHandler({
  store,
  platform,
  mcp,
  dataDir,
  getServer,
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
} = {}) {
  const sendState = createStateResponder();
  const handle = async function handle(req, res) {
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
      const port = getServer().address()?.port;
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
          const teamId =
            typeof body.teamId === 'string' && body.teamId.trim()
              ? body.teamId.trim()
              : null;
          if (teamId) {
            const team = store.teamSpace(teamId);
            if (!team || team.status !== 'active')
              throw new Error('附件所属团队不存在或已暂停。');
          }
          return send(
            201,
            platform.attachments.create({
              name: body.name,
              mime: body.mime,
              data: body.data,
              teamId,
            }),
          );
        }
        if (parts[2] && req.method === 'GET') {
          const attachment = platform.attachments.metadata(parts[2]);
          if (!attachment) return send(404, { error: '附件不存在。' });
          return send(200, attachment);
        }
        if (parts[2] && req.method === 'DELETE')
          return send(200, { ok: platform.attachments.remove(parts[2]) });
      }
      // Task detail keeps its historical newest-first event snapshot for
      // compatibility. This endpoint is the shared incremental projection
      // used by the web inspector and future CLI/background consumers.
      if (
        req.method === 'GET' &&
        parts[1] === 'tasks' &&
        parts[2] &&
        parts[3] === 'events'
      ) {
        if (!store.task(parts[2])) return send(404, { error: '任务不存在。' });
        if (parts[4] === 'stream') {
          return streamTaskEvents(
            req,
            res,
            parts[2],
            options.query.get('after') || null,
            options.query.get('limit') || 100,
          );
        }
        if (parts[4]) return send(404, { error: '任务事件接口不存在。' });
        return send(
          200,
          publicTaskEvents(parts[2], {
            after: options.query.get('after') || null,
            limit: options.query.get('limit') || 100,
          }),
        );
      }
      // Team activity is the shared live projection for the web workspace,
      // CLI consumers and background workers. It replays the durable timeline
      // first, then keeps the connection open for new messages and task events.
      if (
        req.method === 'GET' &&
        ['spaces', 'teams', 'chats'].includes(parts[1]) &&
        parts[2] &&
        parts[3] === 'events'
      ) {
        const space = store.teamSpace(parts[2]);
        if (!space) return send(404, { error: '团队空间不存在。' });
        if (parts[4] === 'stream') {
          return streamTeamEvents(
            req,
            res,
            space.id,
            options.query.get('after') || null,
            options.query.get('limit') || 100,
          );
        }
        if (parts[4]) return send(404, { error: '团队事件接口不存在。' });
        return send(
          200,
          publicTeamEvents(space.id, {
            after: options.query.get('after') || null,
            limit: options.query.get('limit') || 100,
          }),
        );
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
        streamBackupDownload(res, dataDir, filename);
        return;
      }
      const managed = await platform.handle({
        ...options,
        principal: authorization.principal,
      });
      if (managed) return send(managed.status, managed.body);
      if (req.method === 'GET' && parts[1] === 'state')
        return sendState(
          req,
          res,
          getState({
            includeTeamActivity:
              req.headers['x-ggb-state-view'] !== 'workbench',
          }),
        );
      if (req.method === 'GET' && parts[1] === 'risks')
        return send(
          200,
          publicTeamRisks({
            teamId: options.query.get('teamId') || '',
            kind: options.query.get('kind') || 'all',
            status: options.query.get('status') || 'all',
            limit: options.query.get('limit') || 50,
            before: options.query.get('before') || null,
          }),
        );
      if (req.method === 'GET' && parts[1] === 'timeline')
        return send(
          200,
          publicCrossTeamTimeline({
            teamId: options.query.get('teamId') || '',
            kind: options.query.get('kind') || 'all',
            limit: options.query.get('limit') || 60,
            before: options.query.get('before') || null,
          }),
        );
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
        if (req.method === 'GET' && !parts[2])
          return send(200, store.teamTemplates());
        if (req.method === 'POST' && !parts[2])
          return send(201, store.saveTeamTemplate(body));
        if (parts[2]) {
          const template = store.teamTemplate(parts[2]);
          if (!template) return send(404, { error: '团队模板不存在。' });
          if (req.method === 'GET' && !parts[3]) return send(200, template);
          if (req.method === 'PUT' && !parts[3])
            return send(200, store.saveTeamTemplate(body, template.id));
          if (req.method === 'DELETE' && !parts[3])
            return send(200, { ok: store.removeTeamTemplate(template.id) });
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
          if (parts[3] === 'plan' && !parts[4] && req.method === 'GET')
            return send(200, store.teamPlan(space.id));
          if (parts[3] === 'plan' && !parts[4] && req.method === 'PUT')
            return send(200, store.saveTeamPlan(space.id, body));
          if (req.method === 'GET' && !parts[3]) {
            const tasks = store
              .tasks()
              .map((task) => {
                const meta = store.records.get('task-meta', task.id) || {};
                const job = meta.jobId
                  ? store.records.get('jobs', meta.jobId)
                  : null;
                const delivery = store.taskDelivery(task);
                return {
                  ...task,
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
                  workspaceMode:
                    meta.workspaceMode || job?.workspaceMode || null,
                  artifactCount: delivery.evidenceCount,
                  verificationStatus: delivery.hasVerificationEvidence
                    ? delivery.acceptanceStatus
                    : null,
                  deliveryStatus: delivery.deliveryStatus,
                  acceptanceDecision: delivery.acceptanceDecision,
                  acceptanceNote: delivery.acceptanceNote,
                  currentRequirementVersion: delivery.currentRequirementVersion,
                };
              })
              .filter((task) => task.spaceId === space.id)
              .map(({ context: _context, log: _log, ...task }) => {
                const attachmentIds =
                  store.records.get('task-meta', task.id)?.attachmentIds || [];
                return {
                  ...task,
                  log: '',
                  attachmentIds,
                  attachments: platform.attachments.list(attachmentIds),
                };
              });
            return send(200, {
              ...space,
              autonomyUsage: teamUsageSummary(space),
              messages: store.teamMessages(space.id).map((message) => ({
                ...message,
                attachmentIds: Array.isArray(message.attachmentIds)
                  ? message.attachmentIds
                  : [],
                attachments: platform.attachments.list(message.attachmentIds),
              })),
              timeline: publicTeamTimeline(space.id),
              tasks,
              jobs: store.records
                .list('jobs')
                .filter((job) => job.spaceId === space.id),
            });
          }
          if (req.method === 'GET' && parts[3] === 'timeline')
            return send(
              200,
              teamTimelinePage(space.id, options.query, publicTeamTimeline),
            );
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
                attachmentIds: Array.isArray(message.attachmentIds)
                  ? message.attachmentIds
                  : [],
                attachments: platform.attachments.list(message.attachmentIds),
              })),
            });
          }
          if (
            req.method === 'POST' &&
            parts[3] === 'autonomy' &&
            ['pause', 'resume'].includes(parts[4])
          ) {
            const nextStatus = parts[4] === 'pause' ? 'paused' : 'active';
            return send(
              200,
              platform.control.setTeamStatus(space.id, nextStatus),
            );
          }
          if (
            req.method === 'POST' &&
            ['archive', 'restore'].includes(parts[3])
          )
            return send(
              200,
              store.archiveTeamSpace(space.id, parts[3] === 'archive'),
            );
          if (req.method === 'PUT' && !parts[3]) {
            if (
              body.status !== undefined &&
              body.status !== space.status &&
              (body.status === 'archived' || space.status === 'archived')
            )
              throw Object.assign(
                new Error('团队归档和恢复必须通过生命周期接口完成。'),
                { status: 409 },
              );
            const requestedRecruitment = body.recruitment;
            if (
              requestedRecruitment &&
              typeof requestedRecruitment === 'object' &&
              !Array.isArray(requestedRecruitment) &&
              requestedRecruitment.phase !== undefined &&
              requestedRecruitment.phase !== space.recruitment.phase
            )
              throw Object.assign(
                new Error('团队招募阶段只能通过招募流程推进。'),
                { status: 409 },
              );
            return send(200, store.saveTeamSpace(body, space.id));
          }
          if (
            req.method === 'POST' &&
            parts[3] === 'recruitment' &&
            parts[4] === 'confirm'
          ) {
            return send(
              200,
              platform.control.confirmTeamRecruitment(
                space.id,
                {
                  version: body.version,
                  capabilityApprovals: body.capabilityApprovals,
                },
                authorization.principal,
              ),
            );
          }
          if (req.method === 'GET' && parts[3] === 'collaborators') {
            if (
              space.recruitment?.phase !== 'confirmed' ||
              space.collaboration?.enabled === false
            )
              return send(200, []);
            const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
              ? space.collaboration.allowedTeamIds
              : [];
            const collaborators = store
              .teamSpaces()
              .filter(
                (candidate) =>
                  candidate.id !== space.id &&
                  candidate.status === 'active' &&
                  candidate.recruitment?.phase === 'confirmed',
              )
              .filter(
                (candidate) =>
                  !allowed.length || allowed.includes(candidate.id),
              )
              .map(
                ({
                  id: candidateId,
                  name: candidateName,
                  teamType: candidateTeamType,
                  purpose: candidatePurpose,
                  pmRoleId: candidatePmRoleId,
                  status: candidateStatus,
                  memberRoleIds: candidateMemberRoleIds,
                  autonomy: candidateAutonomy,
                  workspaceMode: candidateWorkspaceMode,
                }) => ({
                  id: candidateId,
                  chatId: store.teamSpace(candidateId)?.chatId || candidateId,
                  name: candidateName,
                  teamType: candidateTeamType || 'custom',
                  purpose: candidatePurpose || '',
                  pmRoleId: candidatePmRoleId,
                  status: candidateStatus,
                  memberCount: Array.isArray(candidateMemberRoleIds)
                    ? candidateMemberRoleIds.length
                    : 0,
                  budgetTokens: Number.isSafeInteger(
                    candidateAutonomy?.budgetTokens,
                  )
                    ? candidateAutonomy.budgetTokens
                    : null,
                  maxJobs: Number.isSafeInteger(candidateAutonomy?.maxJobs)
                    ? candidateAutonomy.maxJobs
                    : null,
                  workspaceMode: candidateWorkspaceMode || null,
                }),
              );
            return send(200, collaborators);
          }
          if (req.method === 'POST' && parts[3] === 'collaborate') {
            const result = createTeamHandoff({
              store,
              space,
              body,
              newTask,
              required,
            });
            return send(result.status, result.body);
          }
          if (req.method === 'POST' && parts[3] === 'messages') {
            if (space.status !== 'active')
              throw new Error('团队空间当前不可接收新消息。');
            const attachmentIds = platform.attachments.validateIds(
              body.attachmentIds,
              space.id,
            );
            const content =
              typeof body.content === 'string' ? body.content.trim() : '';
            if (!content && !attachmentIds.length)
              throw new Error('团队消息不能为空，且不能超过 32000 字符。');
            const messageContent = content || '请查看随附文件并处理。';
            const clientMessageId = required(
              body.clientMessageId || randomUUID(),
              '消息 ID',
              200,
            );
            const existing = store
              .teamMessages(space.id)
              .find(
                (message) =>
                  message.clientMessageId === clientMessageId &&
                  message.kind === 'request',
              );
            if (existing && existing.status !== 'blocked')
              return send(200, existing);
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
            try {
              const sessionId = teamMessageSession(store, space);
              const task = newTask({
                role: space.pmRoleId,
                prompt:
                  recruitment.phase === 'confirmed'
                    ? `你正在负责已经确认的团队「${space.name}」。请阅读团队历史和当前消息，按已确认的成员职责拆解任务，使用 delegate_task 推进，并跟踪结果后汇总。只有用户明确提出重新招募或团队范围发生重大变化时，才回到团队招募流程；否则不要调用 propose_team。\n\n用户本轮消息：\n${messageContent}`
                    : `你正在负责团队空间「${space.name}」的团队招募。当前阶段：${recruitment.phase || 'discovery'}。请先阅读招募历史和已有团队上下文，继续与用户多轮澄清目标、交付物、约束、质量标准、工作目录、权限和模型/工具需求。需求未清楚前不要分派任务；信息充分后使用 propose_team 保存待用户确认的 Team Charter。Team Charter 确认前不要把成员说成已创建，也不要调用 delegate_task。\n\n用户本轮消息：\n${messageContent}`,
                sessionId,
                workspace: space.workspace,
                spaceId: space.id,
                sourceMessageId: message.id,
                model: body.model || space.model || undefined,
                providerId: body.providerId || space.providerId || undefined,
                allowModelWithoutTools: body.allowModelWithoutTools === true,
                attachmentIds,
              });
              store.saveTeamSpace(
                {
                  ...space,
                  recruitment: {
                    ...recruitment,
                    sessionId: task.sessionId,
                    turns: (recruitment.turns || 0) + 1,
                  },
                },
                space.id,
              );
              const linkedMessage = store.saveTeamMessage(
                { ...message, taskId: task.id },
                message.id,
              );
              return send(201, { ...linkedMessage, sessionId: task.sessionId });
            } catch (error) {
              store.records.save(
                'space-messages',
                { ...message, status: 'blocked', error: error.message },
                message.id,
              );
              throw error;
            }
          }
        }
      }
      if (parts[1] === 'roles') {
        if (
          (req.method === 'POST' && !parts[2]) ||
          (req.method === 'PUT' && parts[2] && !parts[3])
        ) {
          const existingRole = parts[2] ? store.role(parts[2]) : null;
          const capabilityIds = Array.isArray(body.capabilityIds)
            ? body.capabilityIds
            : existingRole?.capabilityIds || [];
          const previousIds = new Set(existingRole?.capabilityIds || []);
          const approvals =
            body.capabilityApprovals &&
            typeof body.capabilityApprovals === 'object' &&
            !Array.isArray(body.capabilityApprovals)
              ? body.capabilityApprovals
              : existingRole?.capabilityApprovals || {};
          const auditRows = [];
          for (const capabilityId of capabilityIds) {
            const capability = platform.capabilities
              .list()
              .find((item) => item.id === capabilityId);
            if (!capability) continue;
            if (capability.enabled === false)
              throw new Error(
                `绑定能力「${capability.name || capabilityId}」前请先启用能力。`,
              );
            const risk = assessCapabilityRisk(capability);
            if (!risk.requiresReview) continue;
            const capabilityDigest = capabilityFingerprint(capability);
            const approval = approvals?.[capabilityId];
            const validApproval =
              approval?.confirmed === true &&
              typeof approval.digest === 'string' &&
              approval.digest === capabilityDigest;
            if (!validApproval) {
              const error = new Error(
                `绑定能力「${capability.name || capabilityId}」前需要逐项确认：${risk.reasons.join('；')}`,
              );
              error.status = 409;
              error.code = 'CAPABILITY_BINDING_REVIEW_REQUIRED';
              throw error;
            }
            const previousApproval =
              existingRole?.capabilityApprovals?.[capabilityId];
            if (
              !previousIds.has(capabilityId) ||
              previousApproval?.digest !== capabilityDigest
            )
              auditRows.push({
                capability,
                risk,
                approval,
                digest: capabilityDigest,
              });
          }
          const saved = store.saveRole(
            { ...body, capabilityApprovals: approvals },
            parts[2],
          );
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
        const existingKnowledge =
          req.method === 'PUT' && parts[2]
            ? store.knowledge().find((item) => item.id === parts[2])
            : null;
        const knowledgeScope =
          typeof body.scope === 'string'
            ? body.scope
            : existingKnowledge?.scope;
        const knowledgeTeamId =
          knowledgeScope === 'team'
            ? typeof body.teamId === 'string'
              ? body.teamId
              : existingKnowledge?.teamId
            : undefined;
        if (
          ![
            'personal',
            'project',
            'team',
            ...store.roles().map((r) => r.id),
          ].includes(knowledgeScope)
        )
          throw new Error('知识范围无效。');
        if (!['draft', 'confirmed'].includes(body.state))
          throw new Error('知识状态无效。');
        if (req.method === 'PUT' && !existingKnowledge)
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
            expiresAt: body.expiresAt,
          },
          req.method === 'PUT' ? parts[2] : undefined,
        );
        return send(200, item);
      }
      if (parts[1] === 'knowledge' && parts[2]) {
        if (req.method === 'GET' && !parts[3]) {
          const item = store.knowledge().find((entry) => entry.id === parts[2]);
          if (!item) return send(404, { error: '知识不存在。' });
          return send(200, item);
        }
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
            prompt:
              typeof body.prompt === 'string' && body.prompt.trim()
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
            taskType: body.taskType,
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
          const teamId =
            previousMeta.teamId ||
            previousMeta.spaceId ||
            previousJob?.teamId ||
            previousJob?.spaceId ||
            null;
          return send(
            201,
            newTask({
              role,
              prompt: required(body.note, '交接要求'),
              sourceTaskId: task.id,
              workspace: task.workspace,
              ...(teamId
                ? { teamId, spaceId: teamId, ownerInitiated: true }
                : {}),
            }),
          );
        }
      }
      send(404, { error: '未找到接口。' });
    } catch (error) {
      send(error.status || 400, { error: redact(error.message) });
    }
  };
  return handle;
}
