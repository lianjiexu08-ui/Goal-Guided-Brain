import { randomUUID } from 'node:crypto';

export function saveTeamSpace(store, input, id) {
  const existing = id ? store.teamSpace(id) : undefined;
  if (id && !existing) throw new Error('团队空间不存在。');
  // A team space is also the durable identity of a Chat. Keep the old
  // `spaces` collection for compatibility, but expose explicit identifiers
  // so clients can maintain several independent teams.
  const spaceId = id || input.id || randomUUID();
  const chatId = String(input.chatId ?? existing?.chatId ?? spaceId).trim();
  if (!chatId || chatId.length > 150) throw new Error('Chat ID 无效。');
  const name = String(input.name ?? existing?.name ?? '').trim();
  const goal = String(
    input.goal ?? existing?.goal ?? input.purpose ?? existing?.purpose ?? '',
  ).trim();
  const pmRoleId = String(
    input.pmRoleId ?? existing?.pmRoleId ?? 'project_manager',
  ).trim();
  if (!name || name.length > 80) throw new Error('团队空间名称无效。');
  if (!goal || goal.length > 2000) throw new Error('团队空间目标无效。');
  if (!store.role(pmRoleId) || store.role(pmRoleId).archived)
    throw new Error('项目经理助手不存在或已归档。');
  const memberRoleIds = [
    ...new Set(
      (Array.isArray(input.memberRoleIds)
        ? input.memberRoleIds
        : existing?.memberRoleIds || [pmRoleId]
      ).filter((value) => typeof value === 'string' && store.role(value)),
    ),
  ];
  if (!memberRoleIds.includes(pmRoleId)) memberRoleIds.unshift(pmRoleId);
  const teamTypeInput = input.teamType ?? existing?.teamType ?? 'custom';
  const teamTypeAliases = {
    dev: 'development',
    engineering: 'development',
    ops: 'operations',
  };
  const teamType = teamTypeAliases[teamTypeInput] || teamTypeInput;
  if (
    !['custom', 'development', 'operations', 'product', 'project'].includes(
      teamType,
    )
  )
    throw new Error('团队类型无效。');
  const purpose = String(input.purpose ?? existing?.purpose ?? goal).trim();
  if (!purpose || purpose.length > 2000) throw new Error('团队职责无效。');
  const modelValue = input.model ?? existing?.model ?? null;
  const model =
    modelValue === null || modelValue === ''
      ? null
      : String(modelValue).trim().slice(0, 120);
  if (model && !modelValue) throw new Error('团队模型无效。');
  const providerValue = input.providerId ?? existing?.providerId ?? null;
  const providerId =
    providerValue === null || providerValue === ''
      ? null
      : String(providerValue).trim().slice(0, 160);
  if (providerId && !providerValue) throw new Error('团队供应商无效。');
  const workspaceMode =
    input.workspaceMode ?? existing?.workspaceMode ?? 'isolated';
  if (!['isolated', 'worktree', 'snapshot', 'shared'].includes(workspaceMode))
    throw new Error('团队执行目录模式无效。');
  const responsibilities = {};
  const suppliedResponsibilities =
    input.responsibilities ?? existing?.responsibilities ?? {};
  if (
    suppliedResponsibilities &&
    typeof suppliedResponsibilities === 'object' &&
    !Array.isArray(suppliedResponsibilities)
  ) {
    for (const [roleId, value] of Object.entries(suppliedResponsibilities)) {
      if (
        memberRoleIds.includes(roleId) &&
        typeof value === 'string' &&
        value.trim()
      )
        responsibilities[roleId] = value.trim().slice(0, 1000);
    }
  }
  const memberSettings = {};
  const suppliedSettings =
    input.memberSettings ?? existing?.memberSettings ?? {};
  if (
    suppliedSettings &&
    typeof suppliedSettings === 'object' &&
    !Array.isArray(suppliedSettings)
  ) {
    for (const roleId of memberRoleIds) {
      const value = suppliedSettings[roleId];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      memberSettings[roleId] = {
        ...(typeof value.label === 'string'
          ? { label: value.label.trim().slice(0, 120) }
          : {}),
        ...(typeof value.responsibility === 'string'
          ? { responsibility: value.responsibility.trim().slice(0, 1000) }
          : {}),
        ...(Array.isArray(value.providerIds)
          ? {
              providerIds: [
                ...new Set(
                  value.providerIds
                    .filter((v) => typeof v === 'string')
                    .slice(0, 20),
                ),
              ],
            }
          : {}),
        ...(typeof value.memberId === 'string'
          ? { memberId: value.memberId.trim().slice(0, 64) }
          : {}),
        ...(typeof value.templateRoleId === 'string'
          ? { templateRoleId: value.templateRoleId.trim().slice(0, 150) }
          : {}),
        ...(typeof value.modelHint === 'string'
          ? { modelHint: value.modelHint.trim().slice(0, 160) }
          : {}),
        ...(Array.isArray(value.skills)
          ? {
              skills: [
                ...new Set(
                  value.skills
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 160))
                    .slice(0, 12),
                ),
              ],
            }
          : {}),
        ...(Array.isArray(value.skillIds)
          ? {
              skillIds: [
                ...new Set(
                  value.skillIds
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 80))
                    .slice(0, 3),
                ),
              ],
            }
          : {}),
        ...(Array.isArray(value.capabilityIds)
          ? {
              capabilityIds: [
                ...new Set(
                  value.capabilityIds
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 160))
                    .slice(0, 100),
                ),
              ],
            }
          : {}),
        ...(Array.isArray(value.providerIds)
          ? {
              providerIds: [
                ...new Set(
                  value.providerIds
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 160))
                    .slice(0, 32),
                ),
              ],
            }
          : {}),
        ...(Array.isArray(value.tools)
          ? {
              tools: [
                ...new Set(
                  value.tools
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 160))
                    .slice(0, 12),
                ),
              ],
            }
          : {}),
        ...(value.toolAccess &&
        typeof value.toolAccess === 'object' &&
        !Array.isArray(value.toolAccess)
          ? {
              toolAccess: Object.fromEntries(
                ['files', 'web', 'terminal']
                  .filter(
                    (key) =>
                      value.toolAccess[key] !== undefined &&
                      typeof value.toolAccess[key] === 'boolean',
                  )
                  .map((key) => [key, value.toolAccess[key]]),
              ),
            }
          : {}),
        ...(Array.isArray(value.dependencies)
          ? {
              dependencies: [
                ...new Set(
                  value.dependencies
                    .filter((v) => typeof v === 'string' && v.trim())
                    .map((v) => v.trim().slice(0, 64))
                    .slice(0, 12),
                ),
              ],
            }
          : {}),
      };
    }
  }
  const status = input.status ?? existing?.status ?? 'active';
  if (!['active', 'paused', 'archived'].includes(status))
    throw new Error('团队空间状态无效。');
  const autonomy = {
    mode: input.autonomy?.mode ?? existing?.autonomy?.mode ?? 'auto',
    maxDepth: input.autonomy?.maxDepth ?? existing?.autonomy?.maxDepth ?? 4,
    maxJobs: input.autonomy?.maxJobs ?? existing?.autonomy?.maxJobs ?? 32,
    budgetTokens:
      input.autonomy?.budgetTokens ??
      existing?.autonomy?.budgetTokens ??
      200000,
    requireApprovalKinds:
      input.autonomy?.requireApprovalKinds ??
      existing?.autonomy?.requireApprovalKinds ??
      [],
  };
  if (!['assist', 'auto'].includes(autonomy.mode))
    throw new Error('团队空间自治模式无效。');
  if (
    !Number.isSafeInteger(autonomy.maxDepth) ||
    autonomy.maxDepth < 1 ||
    autonomy.maxDepth > 4
  )
    throw new Error('团队空间最大层级需要在 1 至 4 之间。');
  if (
    !Number.isSafeInteger(autonomy.maxJobs) ||
    autonomy.maxJobs < 1 ||
    autonomy.maxJobs > 32
  )
    throw new Error('团队空间最大任务数需要在 1 至 32 之间。');
  if (
    !Number.isSafeInteger(autonomy.budgetTokens) ||
    autonomy.budgetTokens < 1000 ||
    autonomy.budgetTokens > 100000000
  )
    throw new Error('团队空间预算需要在 1000 至 100000000 之间。');
  const collaborationInput =
    input.collaboration ?? existing?.collaboration ?? {};
  const collaboration = {
    enabled: collaborationInput.enabled !== false,
    autoHandoff: collaborationInput.autoHandoff !== false,
    sharedBoard: collaborationInput.sharedBoard !== false,
    allowedTeamIds: Array.isArray(collaborationInput.allowedTeamIds)
      ? [
          ...new Set(
            collaborationInput.allowedTeamIds
              .filter((value) => typeof value === 'string' && value !== spaceId)
              .slice(0, 50),
          ),
        ]
      : existing?.collaboration?.allowedTeamIds || [],
  };
  const recruitmentInput = input.recruitment ?? existing?.recruitment ?? {};
  const recruitmentPhase = ['discovery', 'proposed', 'confirmed'].includes(
    recruitmentInput.phase,
  )
    ? recruitmentInput.phase
    : !existing && input.recruitment === undefined
      ? 'confirmed'
      : 'discovery';
  const recruitment = {
    phase: recruitmentPhase,
    sessionId:
      typeof recruitmentInput.sessionId === 'string' &&
      recruitmentInput.sessionId.trim()
        ? recruitmentInput.sessionId.trim().slice(0, 160)
        : null,
    turns:
      Number.isSafeInteger(recruitmentInput.turns) &&
      recruitmentInput.turns >= 0
        ? Math.min(recruitmentInput.turns, 1000)
        : 0,
    brief:
      typeof recruitmentInput.brief === 'string'
        ? recruitmentInput.brief.trim().slice(0, 20000)
        : '',
    proposal:
      recruitmentInput.proposal &&
      typeof recruitmentInput.proposal === 'object' &&
      !Array.isArray(recruitmentInput.proposal)
        ? recruitmentInput.proposal
        : null,
    confirmedAt:
      typeof recruitmentInput.confirmedAt === 'string'
        ? recruitmentInput.confirmedAt
        : null,
  };
  return store.records.save(
    'spaces',
    {
      ...existing,
      id: spaceId,
      chatId,
      name,
      goal,
      purpose,
      model,
      providerId,
      workspaceMode,
      teamType,
      workspace:
        input.workspace || existing?.workspace || store.config.workspace,
      pmRoleId,
      memberRoleIds,
      responsibilities,
      memberSettings,
      recruitment,
      status,
      autonomy,
      collaboration,
      archivedAt:
        status === 'archived'
          ? (input.archivedAt ??
            existing?.archivedAt ??
            new Date().toISOString())
          : null,
      archivedFromStatus:
        status === 'archived'
          ? (input.archivedFromStatus ?? existing?.archivedFromStatus ?? null)
          : null,
    },
    spaceId,
  );
}
