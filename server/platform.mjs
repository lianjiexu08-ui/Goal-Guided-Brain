import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Vault } from './vault.mjs';
import { ProviderService } from './providers.mjs';
import { ControlPlane } from './control.mjs';
import { AuthService } from './auth.mjs';
import { CapabilityService, inspectBundle } from './capabilities.mjs';
import { AutomationService, runCheck } from './automation.mjs';
import { WorkspaceManager } from './workspaces.mjs';
import { createCapabilityGateway } from './capability-gateway.mjs';
import { measureUsage } from './metering.mjs';
import { resolveApiKey, redact } from './runtime.mjs';
import { AttachmentService } from './attachments.mjs';
import { createMcpChecker } from './platform/mcp-check.mjs';
import { createTeamEventHub } from './platform/team-events.mjs';
import {
  applyTextOnlyModelPolicy,
  selectTaskRoute,
} from './platform/routing.mjs';
import { handleModelFallback } from './platform/model-fallback.mjs';
import { createPlatformHandler } from './platform/handler.mjs';
import { createPlatformManagement } from './platform/management.mjs';
import { createPlatformReady } from './platform/ready.mjs';
import { createContextFor } from './platform/context.mjs';
import { checkPlanDeadlines } from './platform/plan-deadlines.mjs';
import { taskTypeForTask } from './task-types.mjs';
const nowIso = () => new Date().toISOString();

export function createPlatform({
  store,
  dataDir,
  runs,
  runtimeFactory,
  requireCredential,
  address,
  releaseControl = () => {},
  usageMeter: usageMeterOverride,
}) {
  const records = store.records;
  const vault = new Vault(dataDir);
  const providers = new ProviderService({ store, vault });
  const attachments = new AttachmentService({ dataDir, records });
  const capabilities = new CapabilityService({ store, vault, dataDir });
  const workspaces = new WorkspaceManager({ store, dataDir });
  const auth = new AuthService({ store });
  const teamEvents = createTeamEventHub({
    records,
    store,
    attachments,
    nowIso,
  });
  let stopping = false,
    scheduling = false,
    scheduledAgain = false;
  let usageMeter = null;
  const stoppingTasks = new Set();
  const previousRecordObserver = records.onSave;
  records.onSave = (change) => {
    try {
      previousRecordObserver?.(change);
    } catch {}
    teamEvents.publishTeamRecord(change);
  };
  const previousTaskObserver = store.onTaskUpdate;
  store.onTaskUpdate = (change) => {
    try {
      previousTaskObserver?.(change);
    } catch {}
    teamEvents.publishTeamTask(change);
  };
  // A task is claimed before its isolated workspace and runtime are ready.
  // Keep those launch promises visible so shutdown cannot close SQLite while
  // a launch is still writing its snapshot or attachment metadata.
  const launches = new Map();
  const ready = createPlatformReady({
    auth,
    vault,
    dataDir,
    usageMeterOverride,
    setUsageMeter: (value) => {
      usageMeter = value;
    },
  });
  function newTask(input) {
    let assistant = store.role(input.role);
    if (!assistant || assistant.archived)
      throw new Error('助手不存在或已归档。');
    const teamId = input.teamId || input.spaceId || null;
    const attachmentIds = attachments.validateIds(input.attachmentIds, teamId);
    let teamModelHint = '';
    let teamProviderIds = [];
    if (teamId) {
      const space = store.teamSpace(teamId);
      if (!space) throw new Error('团队空间不存在。');
      if (space.status !== 'active')
        throw new Error('团队空间当前不可接收新任务。');
      const parentMeta = input.parentTaskId
        ? records.get('task-meta', input.parentTaskId)
        : null;
      const parentJob = parentMeta?.jobId
        ? records.get('jobs', parentMeta.jobId)
        : null;
      if (parentJob && parentJob.depth >= (space.autonomy?.maxDepth || 4))
        throw Object.assign(
          new Error(
            `团队最多允许 ${space.autonomy?.maxDepth || 4} 层任务拆解。`,
          ),
          { status: 409 },
        );
      if (!input.jobId) {
        const activeTeamJobs = records
          .list('jobs')
          .filter(
            (job) =>
              (job.teamId || job.spaceId) === space.id &&
              ![
                'completed',
                'failed',
                'cancelled',
                'interrupted',
                'state_unknown',
              ].includes(job.status),
          );
        if (activeTeamJobs.length >= (space.autonomy?.maxJobs || 32))
          throw Object.assign(
            new Error(
              '团队已达到自治任务上限，请先处理现有任务或调整团队限额。',
            ),
            { status: 409 },
          );
      }
      const directTeamMemberTask =
        space.pmRoleId !== input.role && input.parentTaskId === undefined;
      if (directTeamMemberTask && input.ownerInitiated !== true)
        throw new Error('团队空间的新任务必须先交给项目经理。');
      if (directTeamMemberTask && space.recruitment.phase !== 'confirmed')
        throw new Error('团队招募方案尚未确认，不能直接联系成员。');
      if (input.parentTaskId && space.recruitment.phase !== 'confirmed')
        throw new Error('团队招募方案尚未确认，不能执行子任务。');
      if (!space.memberRoleIds.includes(input.role))
        throw new Error('该智能体不属于当前团队。');
      const memberSettings = space.memberSettings[input.role] || {};
      teamModelHint =
        typeof memberSettings.modelHint === 'string' &&
        memberSettings.modelHint.trim()
          ? memberSettings.modelHint
          : typeof space.model === 'string'
            ? space.model
            : '';
      teamProviderIds = Array.isArray(memberSettings.providerIds)
        ? memberSettings.providerIds
        : [];
      if (
        Array.isArray(memberSettings.skillIds) &&
        memberSettings.skillIds.length
      )
        assistant = {
          ...assistant,
          skillIds: [
            ...new Set([
              ...(assistant.skillIds || []),
              ...memberSettings.skillIds,
            ]),
          ].slice(0, 3),
        };
      if (
        Array.isArray(memberSettings.capabilityIds) &&
        memberSettings.capabilityIds.length
      )
        assistant = {
          ...assistant,
          capabilityIds: [
            ...new Set([
              ...(assistant.capabilityIds || []),
              ...memberSettings.capabilityIds,
            ]),
          ],
        };
      if (
        memberSettings.toolAccess &&
        typeof memberSettings.toolAccess === 'object'
      )
        assistant = {
          ...assistant,
          tools: { ...assistant.tools, ...memberSettings.toolAccess },
        };
      if (teamProviderIds.length)
        assistant = { ...assistant, providerIds: teamProviderIds };
      const duty =
        space.responsibilities[input.role] ||
        space.memberSettings[input.role]?.responsibility;
      if (duty)
        assistant = {
          ...assistant,
          instructions: `${assistant.instructions}\n\n当前团队：${space.name}\n团队目标：${space.goal}\n本团队职责：${duty}`,
        };
    }
    if (
      requireCredential &&
      !input.check &&
      !providers.list().length &&
      !resolveApiKey(dataDir)
    )
      throw new Error('请先配置模型供应商或 DeepSeek API Key。');
    const workspace = input.workspace || store.config.workspace;
    const teamWorkspaceMode = teamId
      ? store.teamSpace(teamId)?.workspaceMode
      : null;
    const jobId = input.jobId || randomUUID();
    const taskType = taskTypeForTask(input, records, jobId);
    const groupId =
      input.groupId ||
      input.batchId ||
      records.get('jobs', jobId)?.groupId ||
      jobId;
    const batchId =
      input.batchId || records.get('jobs', jobId)?.batchId || randomUUID();
    const nodeId = input.nodeId || assistant.nodeId || 'local';
    const modelOverride =
      typeof input.model === 'string' && input.model.trim()
        ? input.model.trim().slice(0, 120)
        : teamModelHint;
    const providerIds =
      input.providerIds ??
      (typeof input.providerId === 'string' && input.providerId.trim()
        ? [input.providerId.trim()]
        : teamProviderIds.length
          ? teamProviderIds
          : teamId &&
              typeof store.teamSpace(teamId)?.providerId === 'string' &&
              store.teamSpace(teamId).providerId
            ? [store.teamSpace(teamId).providerId]
            : (assistant.providerIds ?? []));
    if (
      !Array.isArray(providerIds) ||
      providerIds.length > 100 ||
      providerIds.some((id) => typeof id !== 'string')
    )
      throw new Error('模型候选必须为供应商 ID 列表。');
    const decisionOnlyProviders = providerIds.filter(
      (id) => records.get('providers', id)?.protocol === 'typesafe-system-one',
    );
    if (decisionOnlyProviders.length)
      throw new Error(
        'TypeSafe 只能通过 evaluate_decision 使用，不能作为聊天或执行模型。',
      );
    if (
      input.budgetTokens !== undefined &&
      (!Number.isSafeInteger(input.budgetTokens) ||
        input.budgetTokens < 1000 ||
        input.budgetTokens > 100000000)
    )
      throw new Error('任务 Token 预算需要在 1000 至 100000000 之间。');
    if (nodeId !== 'local' && !records.get('nodes', nodeId))
      throw new Error('执行节点不存在。');
    const task = store.createTask({ ...input, workspace });
    const acceptance =
      typeof input.acceptance === 'string'
        ? input.acceptance.slice(0, 20000)
        : '';
    if (!input.jobId)
      records.save(
        'jobs',
        {
          title: task.title,
          goal: task.prompt,
          acceptance,
          role: task.role,
          taskType,
          groupId,
          batchId,
          status: 'queued',
          taskId: task.id,
          nodeId,
          workspace,
          workspaceKey: input.workspaceKey || 'default',
          requirementVersion: 1,
          depth: 0,
          budgetTokens: input.budgetTokens || 200000,
          maxDurationMinutes: 30,
          permissions: input.permissions || [],
          spaceId: teamId,
          teamId,
          sourceMessageId: input.sourceMessageId || null,
        },
        jobId,
      );
    records.save(
      'task-meta',
      {
        jobId,
        groupId,
        batchId,
        parentTaskId: input.parentTaskId || null,
        nodeId,
        workspaceKey: input.workspaceKey || 'default',
        workspaceMode:
          input.workspaceMode ||
          teamWorkspaceMode ||
          assistant.workspaceMode ||
          'shared',
        providerIds,
        allowedProviderIds:
          input.allowedProviderIds ??
          input.providerIds ??
          assistant.providerIds ??
          [],
        dependencies: input.dependencies || [],
        permissions: input.permissions || [],
        scheduleId: input.scheduleId || null,
        check: input.check || null,
        requirementVersion: input.requirementVersion || 1,
        taskType,
        contextExtra: input.contextExtra || '',
        acceptance,
        attachmentIds,
        spaceId: teamId,
        teamId,
        sourceMessageId: input.sourceMessageId || null,
        modelOverride: modelOverride || null,
        allowModelWithoutTools: input.allowModelWithoutTools === true,
        assistantSnapshot: {
          ...(input.assistantSnapshot || assistant),
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(providerIds.length ? { providerIds } : {}),
        },
        capabilityCommand: input.capabilityCommand || null,
        excludedProviders: [],
      },
      task.id,
    );
    queueMicrotask(() => void schedule());
    return task;
  }
  async function stopTask(id) {
    const task = store.task(id);
    if (!task) throw new Error('任务不存在。');
    stoppingTasks.add(id);
    const execution = records.get('executions', id);
    if (execution) control.revokeExecution(id, 'stopping');
    const run = runs.get(id);
    if (run) {
      await run.cancel();
      if (runs.has(id) && run.child && run.child.exitCode === null) {
        store.updateTask(id, {
          status: 'state_unknown',
          error: '尚未确认执行进程退出，原目录已隔离。',
        });
        workspaces.finish(id, 'quarantined');
        return { status: 'state_unknown' };
      }
    } else if (execution && execution.nodeId !== 'local') {
      store.updateTask(id, {
        status: 'state_unknown',
        error: '已撤销执行权限，等待远程节点确认停止。',
      });
      return { status: 'state_unknown' };
    }
    if (!['completed', 'failed'].includes(store.task(id).status))
      store.updateTask(id, {
        status: 'cancelled',
        error: '任务已停止，已有修改保留。',
      });
    return { status: store.task(id).status };
  }
  const contextFor = createContextFor({
    store,
    records,
    attachments,
  });
  const control = new ControlPlane({
    store,
    createTask: newTask,
    stopTask,
    evaluateDecision: (input) => providers.evaluateDecision(input),
    onEvent: (task, event) => recordEvent(task, event),
    onRemoteDone: (task, result) => maybeFallback(task, result),
    buildAssignment: async ({ task, execution, token }) => {
      const meta = records.get('task-meta', task.id);
      const assistant = meta.assistantSnapshot || store.role(task.role);
      const route = meta.check
        ? null
        : selectTaskRoute({
            providers,
            assistant,
            providerIds: meta.providerIds,
            modelOverride: meta.modelOverride,
            allowWithoutTools: meta.allowModelWithoutTools,
          });
      const { assistant: effectiveAssistant } = applyTextOnlyModelPolicy(
        assistant,
        route,
        meta.allowModelWithoutTools,
      );
      const cap = meta.check
        ? { patches: [], selected: [] }
        : capabilities.patch(effectiveAssistant);
      if (!route && !meta.check && requireCredential && !resolveApiKey(dataDir))
        throw new Error('没有可用于远程执行的模型凭据。');
      const { secret: _secret, ...publicRoute } = route || {};
      records.save(
        'runtime-snapshots',
        {
          assistant: effectiveAssistant,
          route: route ? publicRoute : null,
          capabilities: cap.selected,
          capabilityConfigs: Object.fromEntries(
            cap.selected.map((c) => [c.id, records.get('capabilities', c.id)]),
          ),
          requirementVersion: meta.requirementVersion,
        },
        task.id,
      );
      const bundles = cap.selected
        .map((item) => records.get('capabilities', item.id))
        .filter((item) => item.kind !== 'mcp')
        .map((item) => {
          const files = inspectBundle(item.path)
            .files.map((relative) => ({
              path: `${path.basename(item.path)}/${relative.split(path.sep).join('/')}`,
              base64: fs
                .readFileSync(path.join(item.path, relative))
                .toString('base64'),
              executable: !!(
                fs.statSync(path.join(item.path, relative)).mode & 0o111
              ),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
          const hash = createHash('sha256');
          for (const file of files)
            hash
              .update(file.path)
              .update('\0')
              .update(Buffer.from(file.base64, 'base64'));
          return {
            digest: hash.digest('hex'),
            sourceRoot: path.dirname(item.path),
            files,
          };
        });
      return {
        task,
        assistant: effectiveAssistant,
        bundles,
        config: { model: store.config.model },
        route:
          route ||
          (meta.check
            ? null
            : {
                protocol: 'deepseek',
                providerId: 'legacy',
                baseUrl: 'https://api.deepseek.com',
                model: assistant.model || store.config.model,
                secret: resolveApiKey(dataDir),
              }),
        capabilityPatch: gatewayPatches(
          cap.patches,
          process.env.WORKBENCH_PUBLIC_URL || address(),
          token,
        ),
        context: contextFor(task),
        check: meta.check,
        workspaceKey: meta.workspaceKey,
        workspaceMode: meta.workspaceMode,
        maxDurationMinutes:
          records.get('jobs', meta.jobId)?.maxDurationMinutes || 30,
        execution,
        token,
        orchestration: {
          url: `${process.env.WORKBENCH_PUBLIC_URL || address()}/api/mcp`,
          token,
        },
      };
    },
  });
  const gateway = createCapabilityGateway({ control, store, vault });
  function gatewayPatches(patches, endpoint, token) {
    return patches.map((patch) =>
      patch.name === '@deepseek-ai/dsh-mcp-client' &&
      patch.id.startsWith('cap-')
        ? {
            ...patch,
            config: {
              serverName: patch.config.serverName,
              transport: 'streamable-http',
              url: `${endpoint}/api/capability-mcp/${patch.id.slice(4)}`,
              headers: { Authorization: `Bearer ${token}` },
              failOnStartupError: true,
            },
          }
        : patch,
    );
  }
  function recordEvent(task, event, secrets = []) {
    const clean = JSON.parse(redact(JSON.stringify(event), secrets));
    const data = clean.data || clean;
    const eventId =
      typeof clean.seq === 'number'
        ? `${task.id}:${clean.seq}`
        : clean.eventId
          ? `${task.id}:${clean.eventId}`
          : undefined;
    if (eventId && records.get('task-events', eventId)) return;
    const saved = records.save(
      'task-events',
      { taskId: task.id, type: clean.type || 'event', data, at: nowIso() },
      eventId,
    );
    teamEvents.notifyTaskEvent(task.id, saved);
    const meta = records.get('task-meta', task.id) || {};
    if (clean.type === 'tool/call') {
      records.save('task-meta', { ...meta, toolActivity: true }, task.id);
    }
    const usage = measureUsage(records, task.id, clean, usageMeter);
    if (usage) {
      const jobs = records
        .list('jobs')
        .filter((job) => job.groupId === usage.groupId);
      const root = jobs.find((job) => !job.parentJobId);
      const spent = records
        .list('usage')
        .filter((u) => u.groupId === usage.groupId)
        .reduce((sum, u) => sum + u.totalTokens, 0);
      if (root?.budgetTokens && spent >= root.budgetTokens) {
        for (const job of jobs) {
          records.save(
            'jobs',
            { ...job, status: 'budget-exceeded', budgetExceeded: true },
            job.id,
          );
          const current = store.task(job.taskId);
          if (current && ['queued', 'running'].includes(current.status))
            queueMicrotask(() => void stopTask(current.id));
        }
        control.attention(
          {
            kind: 'budget',
            jobId: root.id,
            title: '任务组已达到用量预算',
            detail: `已报告 ${spent} tokens，预算 ${root.budgetTokens}。请调整预算后继续。`,
          },
          `budget:${root.id}`,
        );
      }
      const teamId = root?.teamId || root?.spaceId;
      const team = teamId ? store.teamSpace(teamId) : null;
      if (team?.autonomy?.budgetTokens) {
        const teamJobIds = new Set(
          records
            .list('jobs')
            .filter((job) => (job.teamId || job.spaceId) === team.id)
            .map((job) => job.id),
        );
        const teamSpent = records
          .list('usage')
          .filter((item) => teamJobIds.has(item.jobId))
          .reduce((sum, item) => sum + item.totalTokens, 0);
        const warningId = `team-budget-warning:${team.id}`;
        if (
          teamSpent >= team.autonomy.budgetTokens * 0.8 &&
          teamSpent < team.autonomy.budgetTokens &&
          team.status === 'active'
        ) {
          control.attention(
            {
              kind: 'team-budget-warning',
              teamId: team.id,
              title: '团队自治预算即将用尽',
              detail: `团队已使用 ${teamSpent} / ${team.autonomy.budgetTokens} tokens（${Math.round((teamSpent / team.autonomy.budgetTokens) * 100)}%）。请调整预算或暂停低优先级任务。`,
            },
            warningId,
          );
        }
        if (
          teamSpent >= team.autonomy.budgetTokens &&
          team.status === 'active'
        ) {
          const warning = records.get('attention', warningId);
          if (warning?.status === 'open')
            records.save(
              'attention',
              { ...warning, status: 'resolved', resolvedAt: nowIso() },
              warning.id,
            );
          for (const job of records
            .list('jobs')
            .filter(
              (item) =>
                (item.teamId || item.spaceId) === team.id &&
                ![
                  'completed',
                  'failed',
                  'cancelled',
                  'interrupted',
                  'state_unknown',
                ].includes(item.status),
            )) {
            records.save(
              'jobs',
              { ...job, status: 'budget-exceeded', budgetExceeded: true },
              job.id,
            );
            const current = store.task(job.taskId);
            if (current && ['queued', 'running'].includes(current.status))
              queueMicrotask(() => void stopTask(current.id));
          }
          control.setTeamStatus(team.id, 'paused');
          control.attention(
            {
              kind: 'team-budget',
              teamId: team.id,
              title: '团队自治预算已用尽',
              detail: `团队已报告 ${teamSpent} tokens，预算 ${team.autonomy.budgetTokens}。请调整团队预算后恢复自治。`,
            },
            `team-budget:${team.id}`,
          );
        }
      }
    }
  }
  function maybeFallback(task, outcome) {
    return handleModelFallback({
      task,
      outcome,
      stopping,
      stoppingTasks,
      records,
      providers,
      newTask,
      recordEvent,
      control,
      nowIso,
    });
  }
  async function launch(task) {
    const claimed = control.claimLocal(task);
    if (!claimed) return;
    const { execution, token } = claimed;
    let run,
      result = '',
      route,
      stagedAttachmentRoot = '';
    const meta = records.get('task-meta', task.id);
    const assistant = meta?.assistantSnapshot || store.role(task.role);
    const log = (value) => {
      const current = store.task(task.id);
      if (!current || stopping) return;
      store.updateTask(task.id, {
        log: `${current.log}[${new Date().toLocaleTimeString('zh-CN')}] ${redact(value, [route?.secret, token])}\n`.slice(
          -48000,
        ),
      });
    };
    const finish = (status, error = '') => {
      const heartbeat = run?._heartbeat;
      if (heartbeat) clearInterval(heartbeat);
      try {
        if (stoppingTasks.has(task.id)) {
          const current = records.get('executions', task.id);
          if (current)
            records.save(
              'executions',
              {
                ...current,
                status: 'cancelled',
                tokenHash: null,
                finishedAt: Date.now(),
              },
              task.id,
            );
          store.updateTask(task.id, {
            status: stopping ? 'interrupted' : 'cancelled',
            result,
            error: stopping
              ? '服务已停止，请从检查点继续。'
              : '用户已停止任务。',
          });
        } else
          control.finishLocal(task.id, execution.epoch, {
            status,
            result,
            error: redact(error, [route?.secret, token]),
          });
        workspaces.finish(task.id);
        if (stagedAttachmentRoot)
          fs.rmSync(stagedAttachmentRoot, { recursive: true, force: true });
      } catch (failure) {
        records.save('late-results', {
          taskId: task.id,
          status,
          result,
          error: redact(error, [route?.secret, token]),
          reason: failure.message,
        });
        workspaces.finish(task.id, 'quarantined');
      }
      runs.delete(task.id);
      maybeFallback(task, { status, error, result });
      if (!stopping) queueMicrotask(() => void schedule());
    };
    runs.set(task.id, {
      assistant,
      cancel: () => {
        stoppingTasks.add(task.id);
      },
    });
    try {
      if (meta.check) {
        result = JSON.stringify(await runCheck(meta.check));
        finish('completed');
        return;
      }
      route = selectTaskRoute({
        providers,
        assistant,
        providerIds: meta.providerIds,
        modelOverride: meta.modelOverride,
        allowWithoutTools: meta.allowModelWithoutTools,
      });
      const { assistant: effectiveAssistant, textOnlyModel } =
        applyTextOnlyModelPolicy(assistant, route, meta.allowModelWithoutTools);
      const cap = capabilities.patch(effectiveAssistant);
      const workspace = await workspaces.prepare(task, meta.workspaceMode);
      if (meta.attachmentIds?.length) {
        stagedAttachmentRoot = path.join(
          workspace.path,
          '.ggb-attachments',
          task.id,
        );
        const stagedAttachments = attachments.materialize(
          meta.attachmentIds,
          stagedAttachmentRoot,
          meta.teamId || meta.spaceId || null,
        );
        records.save('task-meta', { ...meta, stagedAttachments }, task.id);
      }
      if (stopping || stoppingTasks.has(task.id)) {
        finish('cancelled');
        return;
      }
      const { secret: _secret, ...publicRoute } = route || {};
      records.save(
        'runtime-snapshots',
        {
          assistant: effectiveAssistant,
          route: route ? publicRoute : null,
          capabilities: cap.selected,
          capabilityConfigs: Object.fromEntries(
            cap.selected.map((c) => [c.id, records.get('capabilities', c.id)]),
          ),
          workspace,
          requirementVersion: meta.requirementVersion,
        },
        task.id,
      );
      const endpoint = `${address()}/api/mcp`;
      const capabilityPatch = [
        ...gatewayPatches(cap.patches, address(), token),
        ...(textOnlyModel
          ? []
          : [
              {
                id: 'workbench-orchestration',
                name: '@deepseek-ai/dsh-mcp-client',
                config: {
                  serverName: 'workbench',
                  transport: 'streamable-http',
                  url: endpoint,
                  headers: { Authorization: `Bearer ${token}` },
                  failOnStartupError: true,
                },
              },
            ]),
      ];
      workspaces.releasePort(task.id);
      run = runtimeFactory({
        task: { ...task, workspace: workspace.path },
        assistant: effectiveAssistant,
        config: store.config,
        route,
        capabilityPatch,
        attachments: records.get('task-meta', task.id)?.stagedAttachments || [],
        dataDir,
        maxDurationMinutes:
          records.get('jobs', meta.jobId)?.maxDurationMinutes || 30,
        env: {
          TMPDIR: workspace.tempDir,
          TMP: workspace.tempDir,
          TEMP: workspace.tempDir,
          PORT: String(workspace.port),
        },
        onLog: log,
        onResult: (value) => {
          result = value;
          if (!stopping) store.updateTask(task.id, { result: value });
        },
        onDone: finish,
        onEvent: (event) => recordEvent(task, event, [route?.secret, token]),
      });
      run.assistant = effectiveAssistant;
      runs.set(task.id, run);
      run._heartbeat = setInterval(() => {
        if (!control.heartbeatLocal(task.id, execution.epoch))
          void stopTask(task.id);
      }, 10000);
      run._heartbeat.unref();
      await run.start(contextFor(task));
    } catch (error) {
      finish('failed', error.message);
      control.attention(
        {
          kind: 'execution',
          taskId: task.id,
          title: '任务无法启动',
          detail: redact(error.message, [route?.secret, token]),
        },
        `start:${task.id}`,
      );
    }
  }
  async function schedule() {
    if (stopping) return;
    if (scheduling) {
      scheduledAgain = true;
      return;
    }
    scheduling = true;
    try {
      await ready;
      for (const task of store
        .tasks()
        .filter((t) => t.status === 'queued')
        .reverse()) {
        if (runs.size >= store.config.maxConcurrent) break;
        if (!control.eligible(task, 'local')) continue;
        const meta = records.get('task-meta', task.id) || {};
        const occupied = store.tasks().filter((t) => t.status === 'running');
        if (
          occupied.some(
            (t) =>
              t.sessionId === task.sessionId ||
              (t.workspace === task.workspace &&
                (
                  records.get('task-meta', t.id)?.assistantSnapshot ||
                  store.role(t.role)
                )?.tools.terminal &&
                (meta.assistantSnapshot || store.role(task.role))?.tools
                  .terminal &&
                meta.workspaceMode !== 'isolated' &&
                records.get('task-meta', t.id)?.workspaceMode !== 'isolated'),
          )
        )
          continue;
        const pending = launch(task).catch((error) =>
          control.attention({ title: '执行器错误', detail: error.message }),
        );
        launches.set(task.id, pending);
        void pending.then(
          () => {
            if (launches.get(task.id) === pending) launches.delete(task.id);
          },
          () => {
            if (launches.get(task.id) === pending) launches.delete(task.id);
          },
        );
      }
    } finally {
      scheduling = false;
      if (scheduledAgain) {
        scheduledAgain = false;
        queueMicrotask(() => void schedule());
      }
    }
  }
  const checkMcp = createMcpChecker({ records, vault });
  const automation = new AutomationService({
    store,
    createTask: newTask,
    providers,
    checkMcp,
    attention: (input, id) => control.attention(input, id),
  });
  let timer;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (stopping) return;
      control.reconcileNodes();
      checkPlanDeadlines({ store, control });
      for (const execution of control.reconcile()) {
        workspaces.finish(execution.taskId, 'quarantined');
        const run = runs.get(execution.taskId);
        if (run) void run.cancel();
      }
      void automation
        .tick()
        .catch((error) =>
          control.attention(
            { title: '定时调度异常', detail: error.message },
            'scheduler',
          ),
        );
      void schedule();
    }, 5000);
    timer.unref();
  }
  const {
    manage,
    backups,
    saveLegacyCredential,
    validateTaskAcceptance,
    recordTaskAcceptance,
  } = createPlatformManagement({
    store,
    records,
    capabilities,
    providers,
    vault,
    control,
    dataDir,
  });
  const handle = createPlatformHandler({
    records,
    store,
    dataDir,
    attachments,
    vault,
    providers,
    automation,
    capabilities,
    manage,
    checkMcp,
    newTask,
    schedule,
    control,
    runs,
    workspaces,
    backups,
    saveLegacyCredential,
    validateTaskAcceptance,
    recordTaskAcceptance,
  });

  return {
    ready,
    auth,
    control,
    gateway,
    vault,
    providers,
    capabilities,
    automation,
    workspaces,
    attachments,
    newTask,
    stopTask,
    schedule,
    checkPlanDeadlines: (now) => checkPlanDeadlines({
      store,
      control,
      ...(now !== undefined
        ? { now: typeof now === 'function' ? now : () => now }
        : {}),
    }),
    start,
    handle,
    manage,
    subscribeTaskEvents: teamEvents.subscribeTaskEvents,
    publishTeamEvent: teamEvents.publishTeamEvent,
    subscribeTeamEvents: teamEvents.subscribeTeamEvents,
    saveLegacyCredential,
    hasCredential: () =>
      providers
        .list()
        .some(
          (p) =>
            p.enabled &&
            p.protocol !== 'typesafe-system-one' &&
            p.models?.length,
        ) || !!resolveApiKey(dataDir),
    async close() {
      stopping = true;
      clearInterval(timer);
      for (const taskId of launches.keys()) stoppingTasks.add(taskId);
      await Promise.allSettled([...runs.keys()].map((id) => stopTask(id)));
      await Promise.allSettled(launches.values());
      while (automation.busy)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await gateway.close();
      teamEvents.clear();
      records.onSave = previousRecordObserver;
      store.onTaskUpdate = previousTaskObserver;
      workspaces.close();
      vault.lock();
      releaseControl();
    },
  };
}
