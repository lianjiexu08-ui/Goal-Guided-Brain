/**
 * Pure Store data helpers.
 *
 * Keeping normalization and read-model assembly outside Store makes the
 * persistence facade easier to review without changing its public API.
 */

export function normalizeTaskRow(row) {
  return row
    ? {
        ...row,
        knowledgeIds: JSON.parse(row.knowledgeIds || '[]'),
        knowledgeRefs: JSON.parse(row.knowledgeRefs || '[]'),
      }
    : null;
}

export function normalizeTeamTemplate(template) {
  if (!template) return template;
  return {
    description: '',
    sourceTeamId: null,
    sourceTeamName: null,
    teamType: 'custom',
    purpose: '',
    goal: '',
    model: null,
    providerId: null,
    workspaceMode: 'isolated',
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    responsibilities: {},
    memberSettings: {},
    autonomy: {
      mode: 'auto',
      maxDepth: 4,
      maxJobs: 32,
      budgetTokens: 200000,
      requireApprovalKinds: [],
    },
    collaboration: {
      enabled: true,
      autoHandoff: true,
      sharedBoard: true,
      allowedTeamIds: [],
    },
    ...template,
  };
}

export function normalizeTeamSpace(space) {
  if (!space) return space;
  // Spaces created before recruitment existed were already user-created
  // teams. Keep them in “我的团队”; new drafts always carry an explicit
  // recruitment phase when they are saved.
  const legacyPhase = space.recruitment ? undefined : 'confirmed';
  const collaboration = {
    enabled: true,
    autoHandoff: true,
    sharedBoard: true,
    allowedTeamIds: [],
    ...(space.collaboration ? space.collaboration : {}),
  };
  return {
    teamType: 'custom',
    purpose: space.goal || '',
    // Team work defaults to a private execution directory. Callers can
    // explicitly opt into shared mode for teams that need it.
    workspaceMode: 'isolated',
    chatId: space.id,
    model: null,
    providerId: null,
    archivedAt: null,
    archivedFromStatus: null,
    responsibilities: {},
    memberSettings: {},
    ...space,
    collaboration,
    recruitment: {
      phase: legacyPhase || 'discovery',
      sessionId: null,
      turns: 0,
      brief: '',
      proposal: null,
      confirmedAt: null,
      ...space.recruitment,
    },
  };
}

export function draftKey(spaceId, roleId) {
  const scope = spaceId ? String(spaceId).trim() : 'standalone';
  const role = String(roleId || '').trim();
  return `draft:${encodeURIComponent(scope)}:${encodeURIComponent(role)}`;
}

export function normalizeVersion(value) {
  const version = Number(value || 1);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

export function buildRecruitmentPage({
  space,
  tasks,
  messages,
  after = null,
  limit = 100,
}) {
  if (!space) return { items: [], hasMore: false, cursor: null };
  const sessionId = space.recruitment?.sessionId || null;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const items = messages
    .filter((message) => {
      if (!sessionId || !message.taskId) return true;
      return taskById.get(message.taskId)?.sessionId === sessionId;
    })
    .map((message) => ({
      ...message,
      cursorAt: message.updatedAt || message.createdAt,
    }))
    .sort(
      (a, b) =>
        a.cursorAt.localeCompare(b.cursorAt) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const cursorParts =
    typeof after === 'string' && after.trim() ? after.split('|') : [];
  const afterAt = cursorParts[0] || null;
  const afterId = cursorParts.slice(1).join('|') || null;
  const filtered = items.filter(
    (message) =>
      !afterAt ||
      message.cursorAt > afterAt ||
      (message.cursorAt === afterAt &&
        Boolean(afterId && String(message.id) > afterId)),
  );
  const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
  const page = filtered.slice(0, pageSize + 1);
  const hasMore = page.length > pageSize;
  const pageItems = (hasMore ? page.slice(0, pageSize) : page).map(
    ({ cursorAt: _cursorAt, ...message }) => message,
  );
  const last = page[page.length - (hasMore ? 2 : 1)];
  return {
    items: pageItems,
    hasMore,
    cursor: last ? `${last.cursorAt}|${last.id}` : after || null,
    sessionId,
    recruitment: space.recruitment,
  };
}

export function deriveTaskDelivery({
  task,
  meta = {},
  job = null,
  artifacts = [],
  savedAcceptance = null,
}) {
  const currentRequirementVersion = normalizeVersion(
    job?.requirementVersion || meta.requirementVersion,
  );
  const verifications = artifacts
    .filter((artifact) => artifact.kind === 'verification')
    .sort((a, b) => {
      const at = a.finishedAt || a.updatedAt || a.createdAt || '';
      const bt = b.finishedAt || b.updatedAt || b.createdAt || '';
      return bt.localeCompare(at) || String(b.id).localeCompare(String(a.id));
    });
  const latestVerification = verifications[0] || null;
  const verificationRequirementVersion = normalizeVersion(
    latestVerification?.requirementVersion,
  );
  const verificationStatus = latestVerification
    ? latestVerification.status ||
      (latestVerification.verified === true ? 'verified' : 'pending-review')
    : task.status === 'completed'
      ? 'pending-review'
      : null;
  const hasCurrentVerificationEvidence = Boolean(
    latestVerification &&
    verificationRequirementVersion === currentRequirementVersion &&
    verificationStatus === 'verified',
  );
  const acceptance =
    savedAcceptance &&
    savedAcceptance.status !== 'stale' &&
    normalizeVersion(savedAcceptance.requirementVersion) ===
      currentRequirementVersion
      ? savedAcceptance
      : null;
  const acceptanceMatchesEvidence = Boolean(
    acceptance &&
    acceptance.verificationId === (latestVerification?.id || null),
  );
  const effectiveAcceptance = acceptanceMatchesEvidence ? acceptance : null;
  let deliveryStatus = task.status;
  if (task.status === 'completed') {
    if (
      effectiveAcceptance?.decision === 'accepted' &&
      hasCurrentVerificationEvidence
    )
      deliveryStatus = 'accepted';
    else if (effectiveAcceptance?.decision === 'rejected')
      deliveryStatus = 'rejected';
    else if (hasCurrentVerificationEvidence) deliveryStatus = 'awaiting-owner';
    else if (verificationStatus === 'failed') deliveryStatus = 'failed';
    else deliveryStatus = 'pending-review';
  }
  return {
    executionStatus: task.status,
    deliveryStatus,
    acceptanceStatus: verificationStatus,
    acceptanceDecision: effectiveAcceptance?.decision || null,
    acceptanceNote: effectiveAcceptance?.note || null,
    acceptanceAt: effectiveAcceptance?.decidedAt || null,
    acceptanceCriteria: job?.acceptance || null,
    currentRequirementVersion,
    verificationRequirementVersion: latestVerification
      ? verificationRequirementVersion
      : null,
    hasCurrentVerificationEvidence,
    evidenceCount: artifacts.length,
    hasVerificationEvidence: Boolean(latestVerification),
    latestVerificationId: latestVerification?.id || null,
    latestVerificationAt:
      latestVerification?.finishedAt ||
      latestVerification?.updatedAt ||
      latestVerification?.createdAt ||
      null,
    latestVerification,
    acceptance: effectiveAcceptance,
  };
}
