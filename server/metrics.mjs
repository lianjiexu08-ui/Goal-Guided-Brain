const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timestampMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseWindow = (query) => {
  const sinceValue = query?.get?.('since') || '';
  const untilValue = query?.get?.('until') || '';
  const since = sinceValue ? timestampMs(sinceValue) : null;
  const until = untilValue ? timestampMs(untilValue) : null;
  if (sinceValue && since === null) throw new Error('since 必须是有效的 ISO 时间。');
  if (untilValue && until === null) throw new Error('until 必须是有效的 ISO 时间。');
  if (since !== null && until !== null && since > until)
    throw new Error('since 不能晚于 until。');
  return {
    since,
    until,
    sinceIso: since === null ? null : new Date(since).toISOString(),
    untilIso: until === null ? null : new Date(until).toISOString(),
  };
};

const withinWindow = (task, window) => {
  const at = timestampMs(task.createdAt) ?? timestampMs(task.updatedAt);
  if (at === null) return true;
  if (window.since !== null && at < window.since) return false;
  if (window.until !== null && at > window.until) return false;
  return true;
};

const nameOf = (items, id, fallback = null) =>
  items.find((item) => item.id === id)?.name || fallback || id || null;

// A model comparison must remain comparable across teams and roles. Team and
// role are filters/context on this endpoint, rather than separate buckets;
// callers can narrow the same provider/model aggregate with query parameters.
const routeKey = ({ providerId, model }) =>
  [providerId || '', model || ''].join('\u001f');

const emptyBucket = ({ providerId, model, providerName, teamId, teamName, roleId, roleName }) => ({
  providerId: providerId || null,
  providerName: providerName || providerId || '未识别供应商',
  model: model || null,
  teamId: teamId || null,
  teamName: teamName || (teamId ? teamId : '未归属团队'),
  roleId: roleId || null,
  roleName: roleName || roleId || '未识别助手',
  attempts: new Set(),
  completed: 0,
  failed: 0,
  fallbacks: 0,
  fallbackTargets: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  usageRows: [],
  latencies: [],
  logicalGroups: new Set(),
  verificationPassed: 0,
  accepted: 0,
  rejected: 0,
  pending: 0,
  candidateDecisions: new Map(),
});

const addCandidateDecision = (bucket, candidate) => {
  if (!candidate || typeof candidate !== 'object') return;
  const normalized = {
    providerId: candidate.providerId || null,
    providerName: candidate.providerName || null,
    model: candidate.model || null,
    status: candidate.status || 'unknown',
    reason: typeof candidate.reason === 'string' ? candidate.reason.slice(0, 500) : null,
  };
  const key = JSON.stringify(normalized);
  const existing = bucket.candidateDecisions.get(key) || { ...normalized, count: 0 };
  existing.count += 1;
  bucket.candidateDecisions.set(key, existing);
};

const addBucket = (buckets, dimensions, providers) => {
  const key = routeKey(dimensions);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = emptyBucket({
      ...dimensions,
      providerName: nameOf(providers, dimensions.providerId),
    });
    buckets.set(key, bucket);
  } else {
    if (bucket.teamId !== dimensions.teamId) {
      bucket.teamId = null;
      bucket.teamName = '多个团队';
    }
    if (bucket.roleId !== dimensions.roleId) {
      bucket.roleId = null;
      bucket.roleName = '多个助手';
    }
  }
  return bucket;
};

const usageDimensions = (usage, route, context) => ({
  providerId: usage.providerId || route?.providerId || null,
  model: usage.model || route?.model || null,
  teamId: context.teamId,
  teamName: context.teamName,
  roleId: context.roleId,
  roleName: context.roleName,
});

const routeDimensions = (route, context) => ({
  providerId: route?.providerId || null,
  model: route?.model || null,
  teamId: context.teamId,
  teamName: context.teamName,
  roleId: context.roleId,
  roleName: context.roleName,
});

const asTaskGroup = (task, meta, job) =>
  meta.groupId || job?.groupId || meta.jobId || task.id;

const p50 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const publicBucket = (bucket) => {
  const costKnown = bucket.usageRows.length > 0 && bucket.usageRows.every((row) => numberOrNull(row.cost) !== null);
  const cost = costKnown
    ? bucket.usageRows.reduce((sum, row) => sum + numberOrNull(row.cost), 0)
    : null;
  const avgLatencyMs = bucket.latencies.length
    ? Math.round(bucket.latencies.reduce((sum, value) => sum + value, 0) / bucket.latencies.length)
    : null;
  return {
    providerId: bucket.providerId,
    providerName: bucket.providerName,
    model: bucket.model,
    teamId: bucket.teamId,
    teamName: bucket.teamName,
    roleId: bucket.roleId,
    roleName: bucket.roleName,
    attempts: bucket.attempts.size,
    logicalTasks: bucket.logicalGroups.size,
    completed: bucket.completed,
    failed: bucket.failed,
    fallbacks: bucket.fallbacks,
    fallbackTargets: bucket.fallbackTargets,
    avgLatencyMs,
    p50LatencyMs: p50(bucket.latencies),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.totalTokens,
    cost,
    costKnown,
    verificationPassed: bucket.verificationPassed,
    accepted: bucket.accepted,
    rejected: bucket.rejected,
    pending: bucket.pending,
    candidateDecisions: [...bucket.candidateDecisions.values()]
      .sort((a, b) => b.count - a.count || String(a.providerId || '').localeCompare(String(b.providerId || '')) || String(a.model || '').localeCompare(String(b.model || '')))
      .slice(0, 50),
  };
};

/**
 * Aggregate durable execution evidence. Every task is one execution attempt;
 * groupId is the logical task identity shared by retries and model fallbacks.
 * Costs remain null when any usage row lacks a price, so the UI never turns
 * an unknown price into a misleading zero.
 */
export function modelMetrics(store, query) {
  const window = parseWindow(query);
  const teamFilter = query?.get?.('teamId') || '';
  const roleFilter = query?.get?.('roleId') || '';
  const providerFilter = query?.get?.('providerId') || '';
  const modelFilter = query?.get?.('model') || '';
  const teams = store.teamSpaces();
  const roles = store.roles().filter((role) => !role.archived);
  const providers = store.records.list('providers');
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const buckets = new Map();
  const groups = new Map();
  const taskRows = [];
  const selectedTaskIds = new Set();
  const selectedFinalGroups = new Set();
  const usages = store.records.list('usage');
  const usageByTask = new Map();
  for (const usage of usages) {
    if (!usageByTask.has(usage.taskId)) usageByTask.set(usage.taskId, []);
    usageByTask.get(usage.taskId).push(usage);
  }

  for (const task of store.tasks()) {
    if (!withinWindow(task, window)) continue;
    const meta = store.records.get('task-meta', task.id) || {};
    const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
    const teamId = meta.teamId || meta.spaceId || job?.teamId || job?.spaceId || null;
    const team = teamId ? teamById.get(teamId) : null;
    const role = roles.find((item) => item.id === task.role);
    if (teamFilter && teamId !== teamFilter) continue;
    if (roleFilter && task.role !== roleFilter) continue;
    const snapshot = store.records.get('runtime-snapshots', task.id) || {};
    const route = snapshot.route || null;
    const taskUsages = usageByTask.get(task.id) || [];
    const context = {
      teamId,
      teamName: team?.name || teamId || '未归属团队',
      roleId: task.role,
      roleName: role?.name || task.role,
    };
    const usageGroups = new Map();
    for (const usage of taskUsages) {
      const dimensions = usageDimensions(usage, route, context);
      if (!dimensions.providerId && !dimensions.model) continue;
      const key = routeKey(dimensions);
      if (!usageGroups.has(key)) usageGroups.set(key, { dimensions, rows: [] });
      usageGroups.get(key).rows.push(usage);
    }
    if (!usageGroups.size && (route?.providerId || route?.model)) {
      const dimensions = routeDimensions(route, context);
      usageGroups.set(routeKey(dimensions), { dimensions, rows: [] });
    }
    if (!usageGroups.size) continue;
    const groupId = asTaskGroup(task, meta, job);
    const execution = store.records.get('executions', task.id);
    const started = timestampMs(execution?.startedAt);
    const finished = timestampMs(execution?.finishedAt);
    const latency = started !== null && finished !== null && finished >= started
      ? finished - started
      : null;
    const row = { task, meta, job, context, groupId, execution, latency, route, usageGroups };
    taskRows.push(row);
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(row);
  }

  const finalRows = new Map();
  for (const [groupId, rows] of groups) {
    const jobCurrent = rows.find((row) => row.job?.taskId && row.job.taskId === row.task.id);
    const final = jobCurrent || [...rows].sort((a, b) =>
      String(a.task.createdAt || '').localeCompare(String(b.task.createdAt || '')) ||
      String(a.task.id).localeCompare(String(b.task.id)),
    ).at(-1);
    if (final) finalRows.set(groupId, final);
  }

  for (const row of taskRows) {
    for (const { dimensions, rows } of row.usageGroups.values()) {
      if (providerFilter && dimensions.providerId !== providerFilter) continue;
      if (modelFilter && dimensions.model !== modelFilter) continue;
      selectedTaskIds.add(row.task.id);
      const bucket = addBucket(buckets, dimensions, providers);
      const snapshotRoute = row.context && row.route
        ? routeDimensions(row.route, row.context)
        : null;
      if (snapshotRoute && row.route && routeKey(snapshotRoute) === routeKey(dimensions) && Array.isArray(row.route.routingCandidates))
        row.route.routingCandidates.forEach((candidate) => addCandidateDecision(bucket, candidate));
      bucket.attempts.add(row.task.id);
      if (row.task.status === 'completed') bucket.completed += 1;
      if (row.task.status === 'failed') bucket.failed += 1;
      if (row.latency !== null) bucket.latencies.push(row.latency);
      for (const usage of rows) {
        bucket.usageRows.push(usage);
        bucket.inputTokens += numberOrNull(usage.inputTokens) || 0;
        bucket.outputTokens += numberOrNull(usage.outputTokens) || 0;
        bucket.totalTokens += numberOrNull(usage.totalTokens) ||
          (numberOrNull(usage.inputTokens) || 0) + (numberOrNull(usage.outputTokens) || 0);
      }
    }
  }

  for (const [groupId, row] of finalRows) {
    const delivery = store.taskDelivery(row.task);
    const finalRoutes = [...row.usageGroups.values()].map((entry) => entry.dimensions);
    if (!finalRoutes.length && row.task) {
      const snapshot = store.records.get('runtime-snapshots', row.task.id) || {};
      if (snapshot.route) finalRoutes.push(routeDimensions(snapshot.route, row.context));
    }
    const uniqueKeys = new Set(finalRoutes.map((dimensions) => routeKey(dimensions)));
    for (const key of uniqueKeys) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      selectedFinalGroups.add(groupId);
      bucket.logicalGroups.add(groupId);
      if (row.task.status === 'completed' && delivery.hasCurrentVerificationEvidence) bucket.verificationPassed += 1;
      if (delivery.acceptanceDecision === 'accepted') bucket.accepted += 1;
      else if (delivery.acceptanceDecision === 'rejected') bucket.rejected += 1;
      else bucket.pending += 1;
    }
  }

  const fallbackEvents = [];
  for (const event of store.records.list('task-events')) {
    if (event.type !== 'routing/fallback' || !event.taskId) continue;
    const row = taskRows.find((candidate) => candidate.task.id === event.taskId);
    if (!row) continue;
    const data = event.data || {};
    const from = data.from || {};
    const to = data.to || {};
    const dimensions = (spec) => ({
      providerId: spec.providerId || null,
      model: spec.model || null,
      teamId: row.context.teamId,
      teamName: row.context.teamName,
      roleId: row.context.roleId,
      roleName: row.context.roleName,
    });
    const fromDimensions = dimensions(from);
    const toDimensions = dimensions(to);
    const matches = (dimensionsValue) =>
      (!providerFilter || dimensionsValue.providerId === providerFilter) &&
      (!modelFilter || dimensionsValue.model === modelFilter);
    if (fromDimensions.providerId || fromDimensions.model) {
      const bucket = addBucket(buckets, fromDimensions, providers);
      if ((!providerFilter || fromDimensions.providerId === providerFilter) && (!modelFilter || fromDimensions.model === modelFilter)) bucket.fallbacks += 1;
    }
    if (toDimensions.providerId || toDimensions.model) {
      const bucket = addBucket(buckets, toDimensions, providers);
      if ((!providerFilter || toDimensions.providerId === providerFilter) && (!modelFilter || toDimensions.model === modelFilter)) bucket.fallbackTargets += 1;
    }
    if (matches(fromDimensions) || matches(toDimensions))
      fallbackEvents.push(event.id || `${event.taskId}:${event.createdAt}`);
  }

  const items = [...buckets.values()]
    .map(publicBucket)
    .filter((item) => item.attempts || item.fallbacks || item.fallbackTargets)
    .sort((a, b) => b.totalTokens - a.totalTokens || b.attempts - a.attempts || String(a.model).localeCompare(String(b.model)));
  const finalGroupRows = [...finalRows.entries()]
    .filter(([groupId]) => selectedFinalGroups.has(groupId))
    .map(([, row]) => row);
  const matchingUsage = (dimensions) =>
    (!providerFilter || dimensions.providerId === providerFilter) &&
    (!modelFilter || dimensions.model === modelFilter);
  const totalUsageRows = taskRows.flatMap((row) => [...row.usageGroups.values()]
    .filter((entry) => matchingUsage(entry.dimensions))
    .flatMap((entry) => entry.rows));
  const costKnown = totalUsageRows.length > 0 && totalUsageRows.every((row) => numberOrNull(row.cost) !== null);
  const cost = costKnown ? totalUsageRows.reduce((sum, row) => sum + numberOrNull(row.cost), 0) : null;
  const totalLatency = taskRows
    .filter((row) => selectedTaskIds.has(row.task.id))
    .map((row) => row.latency)
    .filter((value) => value !== null);
  return {
    generatedAt: new Date().toISOString(),
    window: { since: window.sinceIso, until: window.untilIso },
    filters: { teamId: teamFilter || null, roleId: roleFilter || null, providerId: providerFilter || null, model: modelFilter || null },
    options: {
      teams: teams.filter((team) => team.status !== 'archived').map((team) => ({ id: team.id, name: team.name })),
      roles: roles.map((role) => ({ id: role.id, name: role.name })),
      providers: providers.map((provider) => ({ id: provider.id, name: provider.name })),
      models: [...new Set(providers.flatMap((provider) => (Array.isArray(provider.models) ? provider.models : []).map((model) => model.id).filter(Boolean)))].map((model) => ({ id: model, name: model })),
    },
    totals: {
      attempts: selectedTaskIds.size,
      logicalTasks: selectedFinalGroups.size,
      completed: finalGroupRows.filter((row) => row.task.status === 'completed').length,
      failed: finalGroupRows.filter((row) => row.task.status === 'failed').length,
      accepted: finalGroupRows.filter((row) => store.taskDelivery(row.task).acceptanceDecision === 'accepted').length,
      rejected: finalGroupRows.filter((row) => store.taskDelivery(row.task).acceptanceDecision === 'rejected').length,
      pending: finalGroupRows.filter((row) => !['accepted', 'rejected'].includes(store.taskDelivery(row.task).acceptanceDecision)).length,
      verificationPassed: finalGroupRows.filter((row) => row.task.status === 'completed' && store.taskDelivery(row.task).hasCurrentVerificationEvidence).length,
      fallbacks: fallbackEvents.length,
      inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
      totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      cost,
      costKnown,
      avgLatencyMs: totalLatency.length ? Math.round(totalLatency.reduce((sum, value) => sum + value, 0) / totalLatency.length) : null,
      p50LatencyMs: p50(totalLatency),
    },
    items,
  };
}
