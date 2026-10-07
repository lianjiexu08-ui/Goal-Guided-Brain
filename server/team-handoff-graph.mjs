import {
  validHandoffSource,
  readHandoffOrigin,
} from './team-handoff-origin.mjs';

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const compare = (a, b) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

// Owner-only graph: agent readers must continue to enforce their own team scope.
export function buildHandoffGraph(read, teamId, messageId) {
  const rows = read
    .list('space-messages')
    .filter((row) => validHandoffSource(read, row));
  const requested = read.get('space-messages', messageId);
  const selected = rows.find(
    (row) =>
      (row.fromTeamId === teamId || row.toTeamId === teamId) &&
      (row.id === messageId ||
        row.relatedMessageId === messageId ||
        (requested?.kind === 'reply' &&
          requested.spaceId === row.spaceId &&
          requested.relatedMessageId === row.id &&
          requested.taskId === row.taskId &&
          requested.fromTeamId === row.toTeamId &&
          requested.toTeamId === row.fromTeamId)),
  );
  if (!selected) throw fail('当前团队没有这条协作的有效共享记录。', 404);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const origins = new Map(
    rows.map((row) => [row.id, readHandoffOrigin(read, row)]),
  );
  const links = new Map();
  const neighbors = new Map(rows.map((row) => [row.id, new Set()]));
  for (const row of rows) {
    const origin = origins.get(row.id);
    const parents = [];
    let incomplete = ['unresolved', 'legacy'].includes(origin.status);
    if (row.followupMessageId) {
      const parent = byId.get(row.followupMessageId);
      if (
        parent?.fromTeamId === row.fromTeamId &&
        parent.toTeamId === row.toTeamId
      )
        parents.push({ id: parent.id, kind: 'followup' });
      else incomplete = true;
    }
    if (origin.parentMessageId) {
      const parent = byId.get(origin.parentMessageId);
      if (origin.status === 'linked' && parent?.toTeamId === row.fromTeamId)
        parents.push({ id: parent.id, kind: 'delegation' });
      else incomplete = true;
    }
    links.set(row.id, { parents, incomplete });
    for (const parent of parents) {
      neighbors.get(row.id).add(parent.id);
      neighbors.get(parent.id).add(row.id);
    }
  }
  // Both a follow-up reference and the task that initiated it can be relevant.
  // Traverse all verified edges, counting shared descendants only once.
  const included = new Set();
  const pending = [selected.id];
  while (pending.length) {
    const id = pending.pop();
    if (included.has(id)) continue;
    included.add(id);
    for (const neighbor of neighbors.get(id)) pending.push(neighbor);
  }
  const component = rows.filter((row) => included.has(row.id)).sort(compare);
  const ordered = [];
  const colors = new Map();
  for (const row of component) {
    const stack = [{ id: row.id, exit: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (frame.exit) {
        colors.set(frame.id, 2);
        ordered.push(byId.get(frame.id));
        continue;
      }
      if (colors.get(frame.id) === 2) continue;
      if (colors.get(frame.id) === 1)
        throw fail('协作引用存在循环，请核对原始记录。');
      colors.set(frame.id, 1);
      stack.push({ id: frame.id, exit: true });
      const parents = links
        .get(frame.id)
        .parents.map((parent) => byId.get(parent.id))
        .sort(compare);
      for (const parent of parents.toReversed())
        stack.push({ id: parent.id, exit: false });
    }
  }
  const roots = component.filter((row) => !links.get(row.id).parents.length);
  const omittedLinks = read
    .list('handoff-origins')
    .filter(
      (origin) =>
        included.has(origin.parentMessageId) && !included.has(origin.messageId),
    ).length;
  return {
    selected,
    ordered,
    origins,
    links,
    roots,
    root: roots[0],
    omittedLinks,
    incomplete:
      omittedLinks > 0 || component.some((row) => links.get(row.id).incomplete),
  };
}
