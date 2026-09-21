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
  const getState = () => ({
    roles: store.roles(),
    skillCatalog: SKILLS.map(({ id, name }) => ({ id, name })),
    capabilities: platform.capabilities.list().map((capability) => ({
      id: capability.id,
      name: capability.name,
      kind: capability.kind,
      version: capability.version || null,
      enabled: capability.enabled !== false,
      description: capability.description || '',
      tools: Array.isArray(capability.tools) ? capability.tools : [],
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
      const evidence = new Map();
      for (const artifact of store.records.list('artifacts')) {
        if (!artifact.taskId) continue;
        const summary = evidence.get(artifact.taskId) || {
          artifactCount: 0,
          verificationStatus: null,
        };
        summary.artifactCount += 1;
        if (artifact.kind === 'verification' && !summary.verificationStatus) {
          summary.verificationStatus =
            artifact.status ||
            (artifact.verified === true ? 'verified' : 'pending-review');
        }
        evidence.set(artifact.taskId, summary);
      }
      return store.tasks().map(({ context: _context, log: _log, ...t }) => {
        const meta = store.records.get('task-meta', t.id) || {};
        const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
        const summary = evidence.get(t.id) || {
          artifactCount: 0,
          verificationStatus: null,
        };
        return {
          ...t,
          log: '',
          jobId: meta.jobId || null,
          groupId: meta.groupId || job?.groupId || null,
          parentTaskId: meta.parentTaskId || null,
          spaceId: meta.spaceId || job?.spaceId || null,
          teamId: meta.teamId || job?.teamId || meta.spaceId || job?.spaceId || null,
          parentJobId: job?.parentJobId || null,
          artifactCount: summary.artifactCount,
          verificationStatus: summary.verificationStatus,
        };
      });
    })(),
    sessions: store.sessions(),
    knowledge: store.knowledge(),
    spaces: store.teamSpaces().map((space) => ({
      ...space,
      messages: store.teamMessages(space.id),
    })),
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
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        !req.headers['content-type']?.startsWith('application/json')
      )
        return send(415, { error: '请求需要 JSON 内容。' });
      const url = new URL(req.url, 'http://127.0.0.1'),
        parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') return send(404, { error: '未找到接口。' });
      let body = {};
      if (!['GET', 'HEAD'].includes(req.method)) {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 512_000)
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
                return { ...task, jobId: meta.jobId || null, groupId: meta.groupId || job?.groupId || null, parentTaskId: meta.parentTaskId || null, spaceId: meta.spaceId || job?.spaceId || null, teamId: meta.teamId || job?.teamId || meta.spaceId || job?.spaceId || null };
              })
              .filter((task) => task.spaceId === space.id)
              .map(({ context: _context, log: _log, ...task }) => ({ ...task, log: '' }));
            return send(200, {
              ...space,
              messages: store.teamMessages(space.id),
              tasks,
              jobs: store.records.list('jobs').filter((job) => job.spaceId === space.id),
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
            return send(200, platform.control.confirmTeamRecruitment(space.id, { version: body.version }, authorization.principal));
          }
          if (req.method === 'GET' && parts[3] === 'collaborators') {
            if (space.collaboration?.enabled === false) return send(200, []);
            const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
              ? space.collaboration.allowedTeamIds
              : [];
            const collaborators = store.teamSpaces()
              .filter((candidate) => candidate.id !== space.id && candidate.status === 'active')
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
            const targetJobs = store.records.list('jobs').filter((job) => (job.teamId || job.spaceId) === target.id);
            if (targetJobs.length >= (target.autonomy?.maxJobs || 32)) throw new Error('目标团队已达到任务上限。');
            const content = required(body.content, '协作目标', 32000);
            const clientMessageId = required(body.clientMessageId || randomUUID(), '消息 ID', 200);
            const handoffId = `handoff:${space.id}:${target.id}:${clientMessageId}`;
            const previous = store.records.get('space-messages', handoffId);
            if (previous && previous.status !== 'blocked')
              return send(200, { ...previous, sourceTeamId: space.id, targetTeamId: target.id });
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
            const content = required(body.content, '团队消息');
            const clientMessageId = required(body.clientMessageId || randomUUID(), '消息 ID', 200);
            const existing = store
              .teamMessages(space.id)
              .find((message) => message.clientMessageId === clientMessageId && message.kind === 'request');
            if (existing && existing.status !== 'blocked') return send(200, existing);
            const message = existing
              ? store.saveTeamMessage(
                  { ...existing, status: 'sent', taskId: null },
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
                    content,
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
                  ? `你正在负责已经确认的团队「${space.name}」。请阅读团队历史和当前消息，按已确认的成员职责拆解任务，使用 delegate_task 推进，并跟踪结果后汇总。只有用户明确提出重新招募或团队范围发生重大变化时，才回到团队招募流程；否则不要调用 propose_team。\n\n用户本轮消息：\n${content}`
                  : `你正在负责团队空间「${space.name}」的团队招募。当前阶段：${recruitment.phase || 'discovery'}。请先阅读招募历史和已有团队上下文，继续与用户多轮澄清目标、交付物、约束、质量标准、工作目录、权限和模型/工具需求。需求未清楚前不要分派任务；信息充分后使用 propose_team 保存待用户确认的 Team Charter。Team Charter 确认前不要把成员说成已创建，也不要调用 delegate_task。\n\n用户本轮消息：\n${content}`,
                sessionId: pmTask?.sessionId,
                workspace: space.workspace,
                spaceId: space.id,
                sourceMessageId: message.id,
                model: body.model || space.model || undefined,
                providerId: body.providerId || space.providerId || undefined,
                allowModelWithoutTools: body.allowModelWithoutTools === true,
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
        if (req.method === 'POST' && !parts[2])
          return send(201, store.saveRole(body));
        if (req.method === 'PUT' && parts[2] && !parts[3])
          return send(200, store.saveRole(body, parts[2]));
        if (req.method === 'POST' && ['archive', 'restore'].includes(parts[3]))
          return send(200, store.archiveRole(parts[2], parts[3] === 'archive'));
      }
      if (['POST', 'PUT'].includes(req.method) && parts[1] === 'knowledge') {
        if (
          !['personal', 'project', ...store.roles().map((r) => r.id)].includes(
            body.scope,
          )
        )
          throw new Error('知识范围无效。');
        if (!['draft', 'confirmed'].includes(body.state))
          throw new Error('知识状态无效。');
        if (
          req.method === 'PUT' &&
          !store.knowledge().some((k) => k.id === parts[2])
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
            scope: body.scope,
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
            prompt: required(body.prompt, '任务'),
            sessionId: body.sessionId,
            teamId: body.teamId || body.spaceId,
            spaceId: body.spaceId || body.teamId,
            ownerInitiated: true,
            nodeId: body.nodeId,
            providerIds: body.providerIds,
            providerId: body.providerId,
            model: body.model,
            allowModelWithoutTools: body.allowModelWithoutTools === true,
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
            sourceTaskId: task.sourceTaskId,
            contextExtra: `继续执行 ${task.id}。先核验已有成果与外部操作，再完成未完成部分。\n${task.result}`,
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
          return send(
            201,
            newTask({
              role,
              prompt: required(body.note, '交接要求'),
              sourceTaskId: task.id,
              workspace: task.workspace,
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
