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
    timelineHistory,
    timelineHasMore,
    timelineFilter,
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
  const primarySpace = confirmedSpaces[0] || recruitmentSpaces[0] || spaces[0];
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
  const teamMessages = [...(teamSpace?.messages || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const currentServerTimeline = teamSpace?.timeline || [];
  const currentTimelineHistory = teamSpace
    ? timelineHistory[teamSpace.id] || []
    : [];
  const teamTimeline = [
    ...currentTimelineHistory,
    ...currentServerTimeline,
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const teamTimelineHasMore = teamSpace
    ? (timelineHasMore[teamSpace.id] ?? currentServerTimeline.length >= 120)
    : false;
  const teamTasks = tasks.filter((task) => task.spaceId === teamSpace?.id);
  const legacyTeamTimeline: TeamTimelineItem[] = [
    ...teamMessages.map((message) => ({
      id: `message:${message.id}`,
      type: 'message' as const,
      at: message.createdAt,
      messageId: message.id,
      clientMessageId: message.clientMessageId || null,
      senderType: message.senderType,
      senderId: message.senderId,
      fromTeamId: message.fromTeamId || null,
      toTeamId: message.toTeamId || null,
      relatedMessageId: message.relatedMessageId || null,
      kind: message.kind,
      taskId: message.taskId || null,
      content: message.content,
      status: message.status,
      error: message.error || null,
      attachmentIds: message.attachmentIds || [],
      attachments: message.attachments || [],
    })),
    ...teamTasks.slice(0, 8).map((task) => ({
      id: `task:${task.id}`,
      type: 'task' as const,
      at: task.createdAt,
      taskId: task.id,
      role: task.role,
      title: task.title,
      status: task.status,
      result: task.result || '',
      error: task.error || '',
      workspaceMode: task.workspaceMode || null,
      artifactCount: task.artifactCount || 0,
      verificationStatus: task.verificationStatus || null,
      deliveryStatus: task.deliveryStatus || null,
      acceptanceDecision: task.acceptanceDecision || null,
      acceptanceNote: task.acceptanceNote || null,
    })),
  ];
  const timelineItems =
    teamTimeline.length > 0 ? teamTimeline : legacyTeamTimeline;
  const timelineNeedsAttention = (item: TeamTimelineItem) => {
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
      return /fail|error|block|interrupt|budget/i.test(item.eventType || '');
    if (item.type === 'acceptance')
      return item.acceptanceDecision === 'rejected';
    if (item.type === 'attention') return item.status !== 'resolved';
    return false;
  };
  const visibleTeamTimeline = timelineItems.filter((item) => {
    if (timelineFilter === 'messages') return item.type === 'message';
    if (timelineFilter === 'execution')
      return item.type === 'task' || item.type === 'task-event';
    if (timelineFilter === 'evidence')
      return (
        item.type === 'artifact' ||
        item.type === 'verification' ||
        item.type === 'acceptance'
      );
    if (timelineFilter === 'risk') return timelineNeedsAttention(item);
    return true;
  });
  const timelineFilterOptions: Array<{ id: TimelineFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'messages', label: '消息' },
    { id: 'execution', label: '执行' },
    { id: 'evidence', label: '证据' },
    { id: 'risk', label: '风险' },
  ];
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
    teamTimeline,
    teamTimelineHasMore,
    teamTasks,
    timelineItems,
    visibleTeamTimeline,
    timelineFilterOptions,
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
