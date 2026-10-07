/* oxlint-disable */
// @ts-nocheck
import { Sparkles } from 'lucide-react';
import { blankAssistant, assistantIcons } from '../assistant-editor';
import type {
  State,
  RoleId,
  TeamTimelineItem,
  TimelineFilter,
  CapabilityApproval,
} from './model';
import { isActive, taskNeedsAttention, taskNeedsOwnerAction } from './model';

export function deriveWorkbenchState(input: Record<string, any>) {
  const {
    data,
    role,
    view,
    selectedReviewTaskIds,
    mobileTeamQuery,
    selectedSpaceId,
    expandedCharters,
    recruitmentApprovals,
  } = input;
  const roles = data?.roles || [];
  const activeRoles = roles.filter((r) => !r.archived);
  const teamTemplates = data?.teamTemplates || [];
  const assistant = roles.find((r) => r.id === role) || {
    ...blankAssistant,
    name: data ? '暂无助手' : '载入中',
  };
  const Icon =
    assistantIcons[assistant.icon as keyof typeof assistantIcons] || Sparkles;
  const tasks = data?.tasks || [];
  const allSessions = (data?.sessions || []).filter((s) => s.role === role);
  const reviewTasks = tasks.filter(taskNeedsOwnerAction);
  const actionableNotificationCount = Math.max(
    Number(data?.unreadNotificationCount || 0),
    Number(data?.openAttentionCount || 0),
  );
  const allReviewTasksSelected =
    reviewTasks.length > 0 &&
    reviewTasks.every((task) => selectedReviewTaskIds.includes(task.id));
  const spaces = data?.spaces || [];
  const confirmedSpaces = spaces.filter(
    (space) =>
      space.status !== 'archived' && space.recruitment?.phase === 'confirmed',
  );
  const archivedSpaces = spaces.filter(
    (space) =>
      space.status === 'archived' && space.recruitment?.phase === 'confirmed',
  );
  const mobileTeamMatches = confirmedSpaces.filter((space) => {
    const query = mobileTeamQuery.trim().toLowerCase();
    if (!query) return true;
    return `${space.name} ${space.goal || ''}`.toLowerCase().includes(query);
  });
  const recruitmentSpaces = spaces.filter(
    (space) =>
      space.status !== 'archived' && space.recruitment?.phase !== 'confirmed',
  );
  const recruitmentSpace =
    recruitmentSpaces.find((space) => space.id === selectedSpaceId) ||
    recruitmentSpaces[0];
  const primarySpace = confirmedSpaces[0] || recruitmentSpaces[0];
  const teamSpace =
    spaces.find(
      (space) => space.id === selectedSpaceId && space.status !== 'archived',
    ) || primarySpace;
  const isRecruitmentView = view === 'recruitment';
  const isConversationView = view === 'workspace' || isRecruitmentView;
  const isTeamConversation = teamSpace?.pmRoleId === role;
  const assistantName =
    teamSpace?.memberSettings?.[role]?.label || assistant.name;
  const running = tasks.filter(isActive);
  const rosterReady = teamSpace?.recruitment?.phase === 'confirmed';
  const visibleMemberIds = teamSpace
    ? rosterReady
      ? teamSpace.memberRoleIds
      : [teamSpace.pmRoleId]
    : [];
  const teamMembers = teamSpace
    ? activeRoles
        .filter((item) => visibleMemberIds.includes(item.id))
        .sort(
          (a, b) =>
            Number(b.id === teamSpace.pmRoleId) -
            Number(a.id === teamSpace.pmRoleId),
        )
    : activeRoles;
  const teamTasks = tasks.filter((task) => task.spaceId === teamSpace?.id);
  const teamOpenTasks = teamTasks.filter(isActive);
  const teamReviewTasks = teamTasks.filter(taskNeedsOwnerAction);
  const teamRiskTasks = teamTasks.filter(taskNeedsAttention);
  const teamEvidenceCount = teamTasks.reduce(
    (total, task) => total + (task.artifactCount || 0),
    0,
  );
  const projectManager = roles.find((item) => item.id === teamSpace?.pmRoleId);
  const recruitment = teamSpace?.recruitment;
  const recruitmentProposal = recruitment?.proposal;
  const isRecruiting = isTeamConversation && recruitment?.phase !== 'confirmed';
  const recruitmentPhaseMeta =
    recruitment?.phase === 'proposed'
      ? {
          label: '方案待确认',
          description: '项目经理已经整理 Team Charter，等待你确认成员和职责。',
          next: '确认后才会创建成员并进入“我的团队”。',
        }
      : {
          label: '正在澄清',
          description: '项目经理正在收集目标、交付物、约束和权限。',
          next: '信息充分后会生成团队名称、成员和职责方案。',
        };
  const charterKey = `${teamSpace?.id}:${recruitmentProposal?.version}:${recruitment?.phase}`;
  const recruitmentCapabilityRequirements = (
    recruitmentProposal?.members || []
  ).flatMap((member) =>
    (member.capabilityIds || []).flatMap((capabilityId) => {
      const capability = data?.capabilities.find(
        (item) => item.id === capabilityId,
      );
      return capability?.risk?.requiresReview === true
        ? [
            {
              key: `${member.memberId || member.roleId}:${capabilityId}`,
              member,
              capability,
            },
          ]
        : [];
    }),
  );
  const recruitmentReviewsComplete = recruitmentCapabilityRequirements.every(
    (item) => {
      const approval = recruitmentApprovals[item.key];
      const digest =
        item.capability.digest ||
        String(
          item.capability.revision ||
            `${item.capability.kind}:${item.capability.id}`,
        );
      return approval?.confirmed === true && approval.digest === digest;
    },
  );
  const charterExpanded =
    expandedCharters[charterKey] ?? recruitment?.phase !== 'confirmed';
  const modelOptions = (data?.providers || [])
    // TypeSafe is a structured decision backend. It does not generate chat
    // replies or code, so it must never appear in the conversation model
    // switcher. It remains configurable in Management and callable through
    // the dedicated decision flow.
    .filter(
      (provider) =>
        provider.enabled && provider.protocol !== 'typesafe-system-one',
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.id}::${model.id}`,
        providerId: provider.id,
        providerName: provider.name,
        providerHealth:
          provider.health && provider.health.model === model.id
            ? provider.health
            : null,
        model,
      })),
    );
  return {
    roles,
    activeRoles,
    teamTemplates,
    assistant,
    Icon,
    tasks,
    allSessions,
    reviewTasks,
    actionableNotificationCount,
    allReviewTasksSelected,
    spaces,
    confirmedSpaces,
    archivedSpaces,
    mobileTeamMatches,
    recruitmentSpaces,
    recruitmentSpace,
    teamSpace,
    isRecruitmentView,
    isConversationView,
    isTeamConversation,
    assistantName,
    running,
    rosterReady,
    teamMembers,
    teamTasks,
    teamOpenTasks,
    teamReviewTasks,
    teamRiskTasks,
    teamEvidenceCount,
    projectManager,
    recruitment,
    recruitmentProposal,
    isRecruiting,
    recruitmentPhaseMeta,
    charterKey,
    recruitmentReviewsComplete,
    charterExpanded,
    modelOptions,
  };
}
