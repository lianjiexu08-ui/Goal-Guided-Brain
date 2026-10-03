import fs from 'node:fs';
import path from 'node:path';
import { assessCapabilityRisk } from '../capabilities.mjs';
const nowIso = () => new Date().toISOString();

export function createPlatformManagement({
  store,
  records,
  capabilities,
  providers,
  vault,
  control,
  dataDir,
}) {
  function manage() {
    control.reconcileNodes();
    const roles = store.roles();
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const capabilityBindings = new Map();
    const ensureBinding = (id) => {
      if (!capabilityBindings.has(id))
        capabilityBindings.set(id, { assistants: [], teams: [] });
      return capabilityBindings.get(id);
    };
    for (const role of roles) {
      for (const capabilityId of Array.isArray(role.capabilityIds)
        ? role.capabilityIds
        : []) {
        const binding = ensureBinding(capabilityId);
        if (!binding.assistants.some((item) => item.id === role.id))
          binding.assistants.push({ id: role.id, name: role.name });
      }
    }
    for (const team of store.teamSpaces()) {
      for (const [roleId, settings] of Object.entries(
        team.memberSettings || {},
      )) {
        for (const capabilityId of Array.isArray(settings?.capabilityIds)
          ? settings.capabilityIds
          : []) {
          const binding = ensureBinding(capabilityId);
          const entry = {
            id: `${team.id}:${roleId}`,
            teamId: team.id,
            teamName: team.name,
            roleId,
            roleName: roleNames.get(roleId) || roleId,
          };
          if (!binding.teams.some((item) => item.id === entry.id))
            binding.teams.push(entry);
        }
      }
    }
    const capabilitiesWithBindings = capabilities.list().map((capability) => {
      const binding = capabilityBindings.get(capability.id) || {
        assistants: [],
        teams: [],
      };
      const audits = records
        .list('capability-audits')
        .filter((item) => item.capabilityId === capability.id)
        .sort((a, b) =>
          String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
        )
        .slice(0, 20);
      return {
        ...capability,
        risk: assessCapabilityRisk(capability),
        audits,
        latestAudit: audits[0] || null,
        bindings: binding,
        boundAssistantCount: binding.assistants.length,
        boundTeamCount: binding.teams.length,
      };
    });
    const attention = records
      .list('attention')
      .slice(0, 100)
      .map((item) => {
        const task = item.taskId ? store.task(item.taskId) : null;
        const meta = task ? records.get('task-meta', task.id) || {} : {};
        const job = item.jobId
          ? records.get('jobs', item.jobId)
          : meta.jobId
            ? records.get('jobs', meta.jobId)
            : null;
        const delivery = task ? store.taskDelivery(task) : null;
        return {
          ...item,
          taskTitle: task?.title || null,
          taskStatus: task?.status || null,
          jobTitle: job?.title || null,
          jobStatus: job?.status || null,
          deliveryStatus: delivery?.deliveryStatus || null,
          acceptanceDecision: delivery?.acceptanceDecision || null,
        };
      });
    const output = Object.fromEntries(
      [
        'resources',
        'jobs',
        'messages',
        'schedules',
        'monitors',
        'notifications',
        'workflows',
        'schedule-runs',
        'usage',
        'integrations',
      ].map((name) => [name, records.list(name).slice(0, 100)]),
    );
    const nodes = records.list('nodes').map((node) => control.nodeView(node));
    const spaces = store.teamSpaces().map((team) => ({
      id: team.id,
      name: team.name,
      goal: team.goal || '',
      status: team.status || 'active',
      teamType: team.teamType || 'custom',
      recruitmentPhase: team.recruitment?.phase || null,
    }));
    return {
      ...output,
      attention,
      spaces,
      providers: providers.list(),
      nodes,
      capabilities: capabilitiesWithBindings,
      vault: vault.status(),
      credentials: vault.list(),
      roles,
      backups: backups(),
      localNode: {
        id: 'local',
        name: '控制端本机',
        platform: process.platform,
      },
      limits: { maxConcurrent: store.config.maxConcurrent, maxRunMinutes: 30 },
    };
  }
  function backups() {
    const directory = path.join(dataDir, 'backups');
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.sqlite'))
      .sort()
      .reverse()
      .map((filename) => ({
        id: filename,
        filename,
        name: filename,
        bytes: fs.statSync(path.join(directory, filename)).size,
        createdAt: fs
          .statSync(path.join(directory, filename))
          .mtime.toISOString(),
        hasVault: fs.existsSync(path.join(directory, `${filename}.vault.json`)),
      }));
  }
  async function saveLegacyCredential(value) {
    if (!vault.status().unlocked)
      throw new Error('请先在模型管理中创建或解锁凭据库。');
    const existing = records.get('providers', 'legacy-deepseek');
    const credential = await vault.put(
      { name: 'DeepSeek', value, kind: 'api-key' },
      existing?.credentialId || undefined,
    );
    if (vault.get(credential.id) !== value)
      throw new Error('加密凭据校验失败，旧密钥仍保留。');
    const provider = providers.save(
      {
        name: 'DeepSeek',
        protocol: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        credentialId: credential.id,
        models: [{ id: store.config.model || 'deepseek-chat', tools: true }],
        enabled: true,
        priority: existing?.priority ?? 100,
      },
      existing?.id,
    );
    if (!existing) {
      records.remove('providers', provider.id);
      records.save('providers', provider, 'legacy-deepseek');
    }
    return {
      credential,
      provider: records.get('providers', 'legacy-deepseek'),
    };
  }
  function validateTaskAcceptance(task, decision, note) {
    if (!task) throw Object.assign(new Error('任务不存在。'), { status: 404 });
    if (task.status !== 'completed')
      throw Object.assign(new Error('只有已完成的任务可以进行交付验收。'), {
        status: 409,
      });
    const delivery = store.taskDelivery(task);
    if (decision === 'accepted' && !delivery.hasCurrentVerificationEvidence)
      throw Object.assign(
        new Error('当前需求版本还没有通过的验收证据，请先运行验证。'),
        { status: 409 },
      );
    if (decision === 'rejected' && !note)
      throw new Error('退回复核时需要说明需要补充或修改的内容。');
    return delivery;
  }
  function recordTaskAcceptance(
    task,
    decision,
    note,
    delivery = store.taskDelivery(task),
  ) {
    const meta = records.get('task-meta', task.id) || {};
    const job = meta.jobId ? records.get('jobs', meta.jobId) : null;
    const acceptance = records.save(
      'task-acceptance',
      {
        taskId: task.id,
        groupId: meta.groupId || job?.groupId || null,
        jobId: meta.jobId || null,
        spaceId: meta.spaceId || job?.spaceId || null,
        decision,
        status: 'active',
        note,
        requirementVersion: delivery.currentRequirementVersion,
        verificationId: delivery.latestVerificationId,
        decidedBy: 'owner',
        decidedAt: nowIso(),
      },
      task.id,
    );
    const attentionId = `acceptance:${task.id}:${delivery.currentRequirementVersion}`;
    const existingAttention = records.get('attention', attentionId);
    if (decision === 'rejected') {
      control.attention(
        {
          taskId: task.id,
          groupId: meta.groupId || job?.groupId || null,
          jobId: meta.jobId || null,
          spaceId: meta.spaceId || job?.spaceId || null,
          kind: 'acceptance',
          title: '交付被退回复核',
          detail: note,
          requirementVersion: delivery.currentRequirementVersion,
        },
        attentionId,
      );
    } else if (existingAttention) {
      records.save(
        'attention',
        {
          ...existingAttention,
          status: 'resolved',
          resolution: note || '所有者已确认交付。',
        },
        attentionId,
      );
    }
    return {
      ...acceptance,
      delivery: store.taskDelivery(task),
    };
  }
  return {
    manage,
    backups,
    saveLegacyCredential,
    validateTaskAcceptance,
    recordTaskAcceptance,
  };
}
