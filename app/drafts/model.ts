export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
};

export type DraftScope = { spaceId: string | null; roleId: string };
export type DraftSyncState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'offline'
  | 'conflict';
export type DraftBase = { content: string; attachmentIds: string[] };
export type DraftCache = {
  drafts?: Record<string, string>;
  attachments?: Record<string, Attachment[]>;
  updatedAt?: Record<string, string>;
  revisions?: Record<string, number>;
  bases?: Record<string, DraftBase>;
  pending?: Record<string, DraftScope>;
};
export type ServerDraft = {
  spaceId: string | null;
  roleId: string;
  content: string;
  attachmentIds: string[];
  attachments: Attachment[];
  revision?: number;
  updatedAt?: string;
};
export type DraftConflict = {
  key: string;
  spaceId: string | null;
  roleId: string;
  localContent: string;
  remoteContent: string;
  localAttachments: Attachment[];
  remoteAttachments: Attachment[];
  remoteRevision?: number;
  remoteUpdatedAt?: string;
};
export type DraftTextChange = {
  start: number;
  end: number;
  replacement: string;
};

export const DRAFT_CACHE_KEY = 'ggb.composer-drafts.v1';
export const MAX_ATTACHMENTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validAttachment(value: unknown): value is Attachment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.mime === 'string' &&
    Number.isFinite(value.size)
  );
}

export function readDraftCache(): DraftCache {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(
      window.localStorage.getItem(DRAFT_CACHE_KEY) || '{}',
    ) as DraftCache;
    const drafts = isRecord(value.drafts)
      ? Object.fromEntries(
          Object.entries(value.drafts).filter(
            ([, draft]) => typeof draft === 'string',
          ),
        )
      : {};
    const attachments = isRecord(value.attachments)
      ? Object.fromEntries(
          Object.entries(value.attachments).map(([key, items]) => [
            key,
            Array.isArray(items)
              ? items.filter(validAttachment).slice(0, MAX_ATTACHMENTS)
              : [],
          ]),
        )
      : {};
    const updatedAt = isRecord(value.updatedAt)
      ? Object.fromEntries(
          Object.entries(value.updatedAt).filter(
            ([, timestamp]) => typeof timestamp === 'string',
          ),
        )
      : {};
    const revisions = isRecord(value.revisions)
      ? Object.fromEntries(
          Object.entries(value.revisions).filter(([, revision]) =>
            Number.isSafeInteger(revision),
          ),
        )
      : {};
    const bases = isRecord(value.bases)
      ? Object.fromEntries(
          Object.entries(value.bases)
            .filter(
              ([, base]) =>
                isRecord(base) &&
                typeof base.content === 'string' &&
                Array.isArray(base.attachmentIds) &&
                base.attachmentIds.every((id) => typeof id === 'string'),
            )
            .map(([key, base]) => [
              key,
              {
                content: base.content as string,
                attachmentIds: (base.attachmentIds as string[]).slice(
                  0,
                  MAX_ATTACHMENTS,
                ),
              },
            ]),
        )
      : {};
    const pending = isRecord(value.pending)
      ? Object.fromEntries(
          Object.entries(value.pending)
            .filter(
              ([key, scope]) =>
                isRecord(scope) &&
                (scope.spaceId === null || typeof scope.spaceId === 'string') &&
                typeof scope.roleId === 'string' &&
                scope.roleId &&
                key === `${scope.spaceId || 'standalone'}:${scope.roleId}`,
            )
            .map(([key, scope]) => [key, scope as DraftScope]),
        )
      : {};
    return { drafts, attachments, updatedAt, revisions, bases, pending };
  } catch {
    return {};
  }
}

export function draftChangeFromBase(
  base: string,
  next: string,
): DraftTextChange | null {
  if (base === next) return null;
  let start = 0;
  while (
    start < base.length &&
    start < next.length &&
    base[start] === next[start]
  )
    start += 1;
  let baseEnd = base.length;
  let nextEnd = next.length;
  while (
    baseEnd > start &&
    nextEnd > start &&
    base[baseEnd - 1] === next[nextEnd - 1]
  ) {
    baseEnd -= 1;
    nextEnd -= 1;
  }
  return { start, end: baseEnd, replacement: next.slice(start, nextEnd) };
}

export function draftRangesOverlap(a: DraftTextChange, b: DraftTextChange) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function mergeDraftText(base: string, local: string, remote: string) {
  if (local === remote) return { content: local, conflict: false };
  if (local === base) return { content: remote, conflict: false };
  if (remote === base) return { content: local, conflict: false };
  const localChange = draftChangeFromBase(base, local);
  const remoteChange = draftChangeFromBase(base, remote);
  if (!localChange || !remoteChange)
    return { content: localChange ? local : remote, conflict: false };
  if (
    localChange.start === remoteChange.start &&
    localChange.end === remoteChange.end &&
    localChange.replacement === remoteChange.replacement
  ) {
    return { content: local, conflict: false };
  }
  if (draftRangesOverlap(localChange, remoteChange))
    return { content: local, conflict: true };
  const changes = [localChange, remoteChange].sort((a, b) => b.start - a.start);
  let content = base;
  for (const change of changes) {
    content =
      content.slice(0, change.start) +
      change.replacement +
      content.slice(change.end);
  }
  return { content, conflict: false };
}

/**
 * Merge attachment additions/removals against the last common base. A removal
 * made locally is preserved when the remote copy is unchanged; simultaneous
 * edits to the same attachment become an explicit conflict instead of silently
 * resurrecting a file that the user removed.
 */
export function mergeDraftAttachments(
  baseIds: string[],
  local: Attachment[],
  remote: Attachment[],
) {
  const base = new Set(baseIds);
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const allIds = new Set([...base, ...localMap.keys(), ...remoteMap.keys()]);
  const result: Attachment[] = [];
  let conflict = false;
  for (const id of allIds) {
    const localHas = localMap.has(id);
    const remoteHas = remoteMap.has(id);
    const localChanged = localHas !== base.has(id);
    const remoteChanged = remoteHas !== base.has(id);
    if (localChanged && remoteChanged && localHas !== remoteHas) {
      conflict = true;
      continue;
    }
    const keep = localChanged ? localHas : remoteHas;
    if (keep)
      result.push((localMap.get(id) || remoteMap.get(id)) as Attachment);
  }
  return { attachments: result.slice(0, MAX_ATTACHMENTS), conflict };
}

export function attachmentIds(items: Attachment[]) {
  return items.map((item) => item.id);
}

export function draftKeyFor(scope: DraftScope) {
  return `${scope.spaceId || 'standalone'}:${scope.roleId}`;
}
