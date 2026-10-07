// Team Charter proposal, owner confirmation and roster projection.
import { SKILLS } from '../roles.mjs';
import {
  assessCapabilityRisk,
  capabilityFingerprint,
} from '../capabilities.mjs';
import { fail, required } from './primitives.mjs';

export function proposeTeam(plane, body, principal) {
  const { team } = plane.recruitmentContext(principal);
  if (team.recruitment.phase === 'confirmed')
    throw fail(
      '该团队已经开始协作，无需重复招募。请为新的需求建立新的招募空间。',
      409,
    );
  const teamName = required(body.teamName || body.name, '团队名称', 80);
  const goal = required(body.goal, '团队目标', 2000);
  const purpose = required(
    body.purpose || body.responsibility || goal,
    '团队职责',
    2000,
  );
  if (
    !Array.isArray(body.members) ||
    body.members.length < 1 ||
    body.members.length > 8
  )
    throw fail('团队成员需要在 1 至 8 个之间。');
  const seen = new Set();
  const capabilityRows = plane.records.list('capabilities');
  const providerRows = plane.records.list('providers');
  const members = body.members.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member))
      throw fail(`第 ${index + 1} 个成员无效。`);
    const roleId = required(member.roleId, `第 ${index + 1} 个成员的助手`, 150);
    const role = plane.store.role(roleId);
    if (!role || role.archived)
      throw fail(`成员助手 ${roleId} 不存在或已归档。`);
    const memberId =
      roleId === team.pmRoleId
        ? 'manager'
        : String(member.memberId || `member-${index + 1}`);
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(memberId) ||
      (memberId === 'manager' && roleId !== team.pmRoleId)
    )
      throw fail(
        '成员标识需要为 1 至 64 位字母、数字、下划线或连字符，manager 保留给项目经理。',
      );
    if (seen.has(memberId)) throw fail(`成员标识 ${memberId} 重复。`);
    seen.add(memberId);
    const responsibility = required(
      member.responsibility,
      `${role.name || roleId} 的职责`,
      1000,
    );
    const list = (value) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value
                .filter((item) => typeof item === 'string' && item.trim())
                .map((item) => item.trim().slice(0, 500))
                .slice(0, 12),
            ),
          ]
        : [];
    const idList = (value, max = 32) => [
      ...new Set(
        (Array.isArray(value) ? value : [])
          .filter((item) => typeof item === 'string' && item.trim())
          .map((item) => item.trim().slice(0, 160))
          .slice(0, max),
      ),
    ];
    const skillIds = idList(member.skillIds, 3);
    if (skillIds.some((id) => !SKILLS.some((skill) => skill.id === id)))
      throw fail(
        `成员 ${memberId} 包含未知 Skill：${skillIds.filter((id) => !SKILLS.some((skill) => skill.id === id)).join('、')}`,
      );
    const capabilityIds = idList([
      ...(role.capabilityIds || []),
      ...(Array.isArray(member.capabilityIds) ? member.capabilityIds : []),
    ]);
    if (
      capabilityIds.some(
        (id) => !capabilityRows.some((capability) => capability.id === id),
      )
    )
      throw fail(
        `成员 ${memberId} 包含未知能力：${capabilityIds.filter((id) => !capabilityRows.some((capability) => capability.id === id)).join('、')}`,
      );
    const providerIds = idList(member.providerIds);
    if (
      providerIds.some(
        (id) => !providerRows.some((provider) => provider.id === id),
      )
    )
      throw fail(
        `成员 ${memberId} 包含未知模型供应商：${providerIds.filter((id) => !providerRows.some((provider) => provider.id === id)).join('、')}`,
      );
    if (
      member.toolAccess !== undefined &&
      (!member.toolAccess ||
        typeof member.toolAccess !== 'object' ||
        Array.isArray(member.toolAccess) ||
        ['files', 'web', 'terminal'].some(
          (key) =>
            member.toolAccess[key] !== undefined &&
            typeof member.toolAccess[key] !== 'boolean',
        ))
    ) {
      throw fail(
        `成员 ${memberId} 的工具权限必须使用 files、web、terminal 布尔值。`,
      );
    }
    const toolAccess =
      member.toolAccess && typeof member.toolAccess === 'object'
        ? Object.fromEntries(
            ['files', 'web', 'terminal']
              .filter((key) => member.toolAccess[key] !== undefined)
              .map((key) => [key, member.toolAccess[key]]),
          )
        : null;
    return {
      memberId,
      roleId,
      name:
        typeof member.name === 'string' && member.name.trim()
          ? member.name.trim().slice(0, 40)
          : role.name || roleId,
      responsibility,
      deliverables: list(member.deliverables),
      skills: list(member.skills),
      skillIds,
      capabilityIds,
      providerIds,
      tools: list(member.tools),
      toolAccess,
      modelHint:
        typeof member.modelHint === 'string'
          ? member.modelHint.trim().slice(0, 160)
          : '',
      dependencies: list(member.dependencies),
    };
  });
  if (!seen.has('manager')) {
    const pm = plane.store.role(team.pmRoleId);
    members.unshift({
      memberId: 'manager',
      roleId: team.pmRoleId,
      name: pm?.name || team.pmRoleId,
      responsibility: '持续澄清目标、协调成员、跟踪风险并汇总交付。',
      deliverables: ['Team Charter 和阶段性结论'],
      skills: [],
      skillIds: [],
      capabilityIds: [],
      providerIds: [],
      tools: [],
      toolAccess: null,
      modelHint: '',
      dependencies: [],
    });
  }
  if (members.length > 8) throw fail('团队成员（含项目经理）不能超过 8 个。');
  const memberIds = new Set(members.map((member) => member.memberId));
  for (const member of members) {
    if (
      member.dependencies.some(
        (id) => !memberIds.has(id) || id === member.memberId,
      )
    )
      throw fail('成员依赖必须使用方案内其他成员的 memberId。');
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = (member) => {
    if (visiting.has(member.memberId)) throw fail('成员依赖不能形成循环。');
    if (visited.has(member.memberId)) return;
    visiting.add(member.memberId);
    member.dependencies.forEach((id) =>
      visit(members.find((candidate) => candidate.memberId === id)),
    );
    visiting.delete(member.memberId);
    visited.add(member.memberId);
  };
  members.forEach(visit);
  const openQuestions = Array.isArray(body.openQuestions)
    ? [
        ...new Set(
          body.openQuestions
            .filter((item) => typeof item === 'string' && item.trim())
            .map((item) => item.trim().slice(0, 1000))
            .slice(0, 20),
        ),
      ]
    : [];
  const proposal = {
    version: Number.isSafeInteger(team.recruitment?.proposal?.version)
      ? team.recruitment.proposal.version + 1
      : 1,
    teamName,
    goal,
    purpose,
    size: members.length,
    members,
    openQuestions,
    ready: openQuestions.length === 0,
    createdAt: new Date().toISOString(),
  };
  const saved = plane.store.saveTeamSpace(
    {
      ...team,
      name: team.name,
      recruitment: {
        ...team.recruitment,
        phase: 'proposed',
        brief: goal,
        proposal,
      },
    },
    team.id,
  );
  return {
    teamId: saved.id,
    phase: saved.recruitment.phase,
    proposal: saved.recruitment.proposal,
  };
}

export function confirmTeamRecruitment(
  plane,
  spaceId,
  { version, capabilityApprovals = {} } = {},
  principal = { type: 'owner' },
) {
  if (principal.type !== 'owner') throw fail('团队方案需要由用户确认。', 403);
  const team = plane.store.teamSpace(spaceId);
  if (!team) throw fail('团队空间不存在。', 404);
  if (team.status !== 'active') throw fail('团队当前不可创建成员。', 409);
  const recruitment = team.recruitment || {};
  if (recruitment.phase === 'confirmed') return team;
  const proposal = recruitment.proposal;
  if (!proposal || !Array.isArray(proposal.members) || !proposal.members.length)
    throw fail('团队还没有可确认的招募方案。');
  if (version !== undefined && version !== proposal.version)
    throw fail('招募方案已更新，请刷新并确认最新版本。', 409);
  if (proposal.openQuestions?.length)
    throw fail('请先回答 Team Charter 中的待确认问题。');
  if (
    !capabilityApprovals ||
    typeof capabilityApprovals !== 'object' ||
    Array.isArray(capabilityApprovals)
  )
    throw fail('能力确认记录格式无效。');
  const capabilityRows = plane.records.list('capabilities');
  const capabilityById = new Map(
    capabilityRows.map((capability) => [capability.id, capability]),
  );
  const providerRows = plane.records.list('providers');
  const decisionOnlyProviders = proposal.members.flatMap((member) => {
    const ids = member.providerIds?.length
      ? member.providerIds
      : plane.store.role(member.roleId)?.providerIds || [];
    return ids
      .filter((id) =>
        providerRows.some(
          (provider) =>
            provider.id === id && provider.protocol === 'typesafe-system-one',
        ),
      )
      .map((id) => `${member.memberId || member.roleId}:${id}`);
  });
  if (decisionOnlyProviders.length)
    throw fail(
      `招募方案不能把 TypeSafe 作为成员执行模型：${decisionOnlyProviders.join('、')}。请改用普通聊天模型；TypeSafe 只能用于 evaluate_decision。`,
      409,
    );
  const unavailableCapabilities = proposal.members.flatMap((member) =>
    (member.capabilityIds || [])
      .filter(
        (id) =>
          !capabilityRows.some(
            (capability) =>
              capability.id === id && capability.enabled !== false,
          ),
      )
      .map((id) => `${member.memberId || member.roleId}:${id}`),
  );
  if (unavailableCapabilities.length)
    throw fail(
      `招募方案包含未启用的能力：${unavailableCapabilities.join('、')}。请先启用能力或移除该绑定。`,
      409,
    );
  const reviewedCapabilities = [];
  const memberApprovals = new Map();
  for (const member of proposal.members) {
    const template = plane.store.role(member.roleId);
    const ids = [
      ...new Set([
        ...(template?.capabilityIds || []),
        ...(member.capabilityIds || []),
      ]),
    ];
    const approvals = { ...template?.capabilityApprovals };
    for (const capabilityId of ids) {
      const capability = capabilityById.get(capabilityId);
      if (!capability) continue;
      const risk = assessCapabilityRisk(capability);
      if (!risk.requiresReview) continue;
      const key = `${member.memberId || member.roleId}:${capabilityId}`;
      const approval =
        capabilityApprovals[key] ||
        capabilityApprovals[capabilityId] ||
        approvals[capabilityId];
      const digest = capabilityFingerprint(capability);
      if (
        !approval ||
        approval.confirmed !== true ||
        approval.digest !== digest
      ) {
        throw fail(
          `确认能力「${capability.name || capabilityId}」前需要逐项确认：${risk.reasons.join('；')}`,
          409,
        );
      }
      const normalizedApproval = {
        confirmed: true,
        digest,
        riskLevel: risk.level,
        confirmedAt:
          typeof approval.confirmedAt === 'string' && approval.confirmedAt
            ? approval.confirmedAt
            : new Date().toISOString(),
      };
      approvals[capabilityId] = normalizedApproval;
      reviewedCapabilities.push({
        capability,
        risk,
        memberId: member.memberId || member.roleId,
        approval: normalizedApproval,
      });
    }
    memberApprovals.set(member.memberId || member.roleId, approvals);
  }
  const unavailableProviders = proposal.members.flatMap((member) =>
    (member.providerIds || [])
      .filter(
        (id) =>
          !providerRows.some(
            (provider) => provider.id === id && provider.enabled !== false,
          ),
      )
      .map((id) => `${member.memberId || member.roleId}:${id}`),
  );
  if (unavailableProviders.length)
    throw fail(
      `招募方案包含未启用的模型供应商：${unavailableProviders.join('、')}。请先启用供应商或移除该绑定。`,
      409,
    );
  const invalidModels = proposal.members
    .filter((member) => {
      if (!member.modelHint) return false;
      const templateProviderIds =
        plane.store.role(member.roleId)?.providerIds || [];
      const allowedProviderIds = member.providerIds?.length
        ? member.providerIds
        : templateProviderIds;
      const candidates = allowedProviderIds.length
        ? providerRows.filter(
            (provider) =>
              allowedProviderIds.includes(provider.id) &&
              provider.enabled !== false &&
              provider.protocol !== 'typesafe-system-one',
          )
        : providerRows.filter(
            (provider) =>
              provider.enabled !== false &&
              provider.protocol !== 'typesafe-system-one',
          );
      return !candidates.some((provider) =>
        provider.models?.some((model) => model.id === member.modelHint),
      );
    })
    .map((member) => `${member.memberId || member.roleId}:${member.modelHint}`);
  if (invalidModels.length)
    throw fail(
      `招募方案中的模型未在可用供应商中配置：${invalidModels.join('、')}。请先配置模型或移除该建议。`,
      409,
    );
  const incompatibleModels = proposal.members.flatMap((member) => {
    if (!member.modelHint) return [];
    const template = plane.store.role(member.roleId);
    const effectiveTools = { ...template?.tools, ...member.toolAccess };
    const requiresToolCalling =
      Object.values(effectiveTools).some(Boolean) ||
      (member.capabilityIds || []).length > 0;
    if (!requiresToolCalling) return [];
    const templateProviderIds = template?.providerIds || [];
    const allowedProviderIds = member.providerIds?.length
      ? member.providerIds
      : templateProviderIds;
    const candidates = allowedProviderIds.length
      ? providerRows.filter(
          (provider) =>
            allowedProviderIds.includes(provider.id) &&
            provider.enabled !== false &&
            provider.protocol !== 'typesafe-system-one',
        )
      : providerRows.filter(
          (provider) =>
            provider.enabled !== false &&
            provider.protocol !== 'typesafe-system-one',
        );
    const model = candidates
      .flatMap((provider) => provider.models || [])
      .find(
        (candidate) =>
          candidate.id === member.modelHint &&
          (!requiresToolCalling || candidate.tools === true),
      );
    return model
      ? []
      : [`${member.memberId || member.roleId}:${member.modelHint}`];
  });
  if (incompatibleModels.length)
    throw fail(
      `招募方案中的模型不支持成员所需的工具或能力：${incompatibleModels.join('、')}。请更换支持工具调用的模型，或明确关闭该成员的工具权限。`,
      409,
    );
  const unavailable = proposal.members
    .map((member) => member.roleId)
    .filter((roleId) => {
      const role = plane.store.role(roleId);
      return !role || role.archived;
    });
  if (unavailable.length)
    throw fail(
      `招募方案中的助手不可用：${[...new Set(unavailable)].join('、')}`,
    );
  return plane.atomic(() => {
    const fresh = plane.store.teamSpace(spaceId);
    if (fresh.recruitment.phase === 'confirmed') return fresh;
    if (fresh.recruitment.proposal?.version !== proposal.version)
      throw fail('招募方案已更新，请刷新并确认最新版本。', 409);
    const members = proposal.members.map((member, index) => {
      const template = plane.store.role(member.roleId);
      const memberId = member.memberId || `member-${index + 1}`;
      if (member.roleId === fresh.pmRoleId)
        return { ...member, memberId, agentId: fresh.pmRoleId };
      const requestedSkillIds = Array.isArray(member.skillIds)
        ? member.skillIds
        : [];
      const requestedCapabilityIds = Array.isArray(member.capabilityIds)
        ? member.capabilityIds
        : [];
      const tools = {
        ...template.tools,
        ...member.toolAccess,
      };
      const role = plane.store.saveRole({
        ...template,
        name: member.name,
        desc: member.responsibility.slice(0, 240),
        skillIds: [
          ...new Set([...(template.skillIds || []), ...requestedSkillIds]),
        ].slice(0, 3),
        capabilityIds: [
          ...new Set([
            ...(template.capabilityIds || []),
            ...requestedCapabilityIds,
          ]),
        ],
        capabilityApprovals:
          memberApprovals.get(member.memberId || member.roleId) ||
          template.capabilityApprovals,
        providerIds: member.providerIds?.length
          ? member.providerIds
          : template.providerIds,
        tools,
        ...(member.modelHint ? { model: member.modelHint } : {}),
        instructions:
          `${template.instructions.slice(0, 7000)}\n\n团队：${proposal.teamName}\n团队目标：${proposal.goal}\n你的职责：${member.responsibility}\n验收产物：${member.deliverables.join('；')}\n建议技能：${member.skills.join('、')}\n建议工具：${member.tools.join('、')}\n建议模型：${member.modelHint || '沿用角色配置'}`.slice(
            0,
            12000,
          ),
      });
      return { ...member, memberId, agentId: role.id };
    });
    const memberRoleIds = members.map((member) => member.agentId);
    const responsibilities = Object.fromEntries(
      members.map((member) => [member.agentId, member.responsibility]),
    );
    const memberSettings = Object.fromEntries(
      members.map((member) => [
        member.agentId,
        {
          label: member.name,
          responsibility: member.responsibility,
          memberId: member.memberId,
          templateRoleId: member.roleId,
          modelHint: member.modelHint,
          skills: member.skills,
          skillIds: member.skillIds,
          capabilityIds: member.capabilityIds,
          providerIds: member.providerIds,
          tools: member.tools,
          toolAccess: member.toolAccess,
          dependencies: member.dependencies,
        },
      ]),
    );
    const savedTeam = plane.store.saveTeamSpace(
      {
        ...fresh,
        name: proposal.teamName,
        goal: proposal.goal,
        purpose: proposal.purpose,
        memberRoleIds,
        responsibilities,
        memberSettings,
        recruitment: {
          ...fresh.recruitment,
          proposal: { ...proposal, members },
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
      },
      team.id,
    );
    for (const {
      capability,
      risk,
      memberId,
      approval,
    } of reviewedCapabilities) {
      const member = members.find(
        (candidate) => candidate.memberId === memberId,
      );
      plane.records.save('capability-audits', {
        capabilityId: capability.id,
        action: 'bind',
        roleId: member?.agentId || member?.roleId || null,
        teamId: savedTeam.id,
        memberId,
        actor: 'owner',
        confirmed: true,
        riskLevel: risk.level,
        requiresReview: true,
        digest: approval.digest,
        reasons: risk.reasons.slice(0, 12),
        confirmedAt: approval.confirmedAt,
        createdAt: new Date().toISOString(),
      });
    }
    return savedTeam;
  });
}

export function readTeamRoster(plane, principal) {
  const { team } = plane.currentTeam(principal);
  const roles = plane.store.roles().filter((role) => !role.archived);
  const rosterRoleIds =
    team.recruitment.phase === 'confirmed'
      ? team.memberRoleIds
      : [team.pmRoleId];
  const dynamicRoleIds = new Set(
    plane.store.teamSpaces().flatMap((space) =>
      Object.entries(space.memberSettings || {})
        .filter(
          ([roleId, settings]) =>
            settings?.templateRoleId && roleId !== space.pmRoleId,
        )
        .map(([roleId]) => roleId),
    ),
  );
  return {
    teamId: team.id,
    name: team.name,
    recruitment: team.recruitment,
    members: roles
      .filter((role) => rosterRoleIds.includes(role.id))
      .map((role) => ({
        id: role.id,
        name: team.memberSettings[role.id]?.label || role.name,
        responsibility: team.responsibilities[role.id] || '',
        model: role.model,
        templateRoleId: team.memberSettings[role.id]?.templateRoleId || null,
        memberId: team.memberSettings[role.id]?.memberId || null,
        modelHint: team.memberSettings[role.id]?.modelHint || null,
        skills: team.memberSettings[role.id]?.skills || [],
        tools: team.memberSettings[role.id]?.tools || [],
        skillIds: role.skillIds || [],
        capabilityIds: role.capabilityIds || [],
        providerIds: role.providerIds || [],
        runtimeTools: role.tools || {
          files: false,
          web: false,
          terminal: false,
        },
        toolAccess: team.memberSettings[role.id]?.toolAccess || null,
        dependencies: team.memberSettings[role.id]?.dependencies || [],
      })),
    templates: roles
      .filter((role) => !dynamicRoleIds.has(role.id))
      .map((role) => ({
        id: role.id,
        name: role.name,
        desc: role.desc,
        model: role.model,
        skillIds: role.skillIds,
        tools: role.tools,
      })),
  };
}
