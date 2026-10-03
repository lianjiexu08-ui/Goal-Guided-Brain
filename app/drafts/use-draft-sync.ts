'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../workbench-api';
import {
  attachmentIds,
  DRAFT_CACHE_KEY,
  draftKeyFor,
  mergeDraftAttachments,
  mergeDraftText,
  MAX_ATTACHMENTS,
  readDraftCache,
  type Attachment,
  type DraftBase,
  type DraftCache,
  type DraftConflict,
  type DraftScope,
  type DraftSyncState,
  type ServerDraft,
} from './model';

export type DraftSyncOptions = {
  key: string;
  scope: DraftScope;
  ready: boolean;
};

type PersistDraft = (
  draftKey: string,
  draftScope: DraftScope,
  content: string,
  attachments: Attachment[],
  version: number,
  generation: number,
) => Promise<void>;

type QueueDraft = (
  draftKey: string,
  draftScope: DraftScope,
  delay?: number,
) => void;

export type DraftSyncResult = {
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  draftAttachments: Record<string, Attachment[]>;
  setDraftAttachments: React.Dispatch<
    React.SetStateAction<Record<string, Attachment[]>>
  >;
  draftCacheReady: boolean;
  draftSyncState: DraftSyncState;
  draftConflict: DraftConflict | null;
  setDraftConflict: React.Dispatch<React.SetStateAction<DraftConflict | null>>;
  markDraftDirty: (key: string, scope?: DraftScope) => void;
  clearServerDraft: (
    key: string,
    scope: DraftScope,
    sentContent?: string,
    sentAttachmentIds?: string[],
  ) => Promise<void>;
  resolveDraftConflict: (choice: 'local' | 'remote') => void;
  draftVersionRef: React.RefObject<Record<string, number>>;
  draftsRef: React.RefObject<Record<string, string>>;
  draftAttachmentsRef: React.RefObject<Record<string, Attachment[]>>;
};

const RETRY_LIMIT = 5;
const RETRY_BASE_MS = 2_000;
const SYNC_DEBOUNCE_MS = 650;

function serverDraftPath(scope: DraftScope) {
  const query = new URLSearchParams({ role: scope.roleId });
  if (scope.spaceId) query.set('spaceId', scope.spaceId);
  return `drafts?${query.toString()}`;
}

function validAttachments(items: unknown): Attachment[] {
  return Array.isArray(items)
    ? items
        .filter(
          (item): item is Attachment =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Attachment).id === 'string' &&
            typeof (item as Attachment).name === 'string' &&
            typeof (item as Attachment).mime === 'string' &&
            Number.isFinite((item as Attachment).size),
        )
        .slice(0, MAX_ATTACHMENTS)
    : [];
}

function emptyBase(): DraftBase {
  return { content: '', attachmentIds: [] };
}

export function useDraftSync({
  key,
  scope,
  ready,
}: DraftSyncOptions): DraftSyncResult {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftAttachments, setDraftAttachments] = useState<
    Record<string, Attachment[]>
  >({});
  const [draftCacheReady, setDraftCacheReady] = useState(false);
  const [draftSyncState, setDraftSyncState] = useState<DraftSyncState>('idle');
  const [draftConflict, setDraftConflict] = useState<DraftConflict | null>(
    null,
  );
  const [cacheVersion, setCacheVersionState] = useState(0);
  const stableScope = useMemo(
    () => ({ spaceId: scope.spaceId, roleId: scope.roleId }),
    [scope.roleId, scope.spaceId],
  );
  const draftCacheHydrated = useRef(false);
  const draftDirtyRef = useRef<Set<string>>(new Set());
  const draftRevisionRef = useRef<Record<string, number>>({});
  const draftUpdatedAtRef = useRef<Record<string, string>>({});
  const draftBaseRef = useRef<Record<string, DraftBase>>({});
  const draftVersionRef = useRef<Record<string, number>>({});
  const draftGenerationRef = useRef<Record<string, number>>({});
  const draftTimersRef = useRef<Record<string, number>>({});
  const draftScopesRef = useRef<Record<string, DraftScope>>({});
  const draftSavesRef = useRef<Record<string, Promise<void> | undefined>>({});
  const draftRetryCountRef = useRef<Record<string, number>>({});
  const draftStatusesRef = useRef<Record<string, DraftSyncState>>({});
  const draftConflictsRef = useRef<Record<string, DraftConflict>>({});
  const draftQueuedRef = useRef<Set<string>>(new Set());
  const activeKeyRef = useRef(key);
  const activeScopeRef = useRef(stableScope);
  const draftsRef = useRef<Record<string, string>>({});
  const draftAttachmentsRef = useRef<Record<string, Attachment[]>>({});
  const cacheVersionRef = useRef(0);
  const persistDraftRef = useRef<PersistDraft>(async () => {});
  const queueDraftSyncRef = useRef<QueueDraft>(() => {});

  const setCacheVersion = useCallback(() => {
    cacheVersionRef.current += 1;
    setCacheVersionState((value) => value + 1);
  }, []);

  const setSyncStateFor = useCallback(
    (draftKey: string, state: DraftSyncState) => {
      draftStatusesRef.current[draftKey] = state;
      if (activeKeyRef.current === draftKey) setDraftSyncState(state);
    },
    [],
  );

  const clearDraftTimer = useCallback((draftKey: string) => {
    const timer = draftTimersRef.current[draftKey];
    if (timer !== undefined && typeof window !== 'undefined')
      window.clearTimeout(timer);
    delete draftTimersRef.current[draftKey];
  }, []);

  const markDraftDirty = useCallback(
    (draftKey: string, draftScope?: DraftScope) => {
      const resolvedScope =
        draftScope ||
        draftScopesRef.current[draftKey] ||
        (draftKey === activeKeyRef.current ? activeScopeRef.current : null);
      if (resolvedScope) draftScopesRef.current[draftKey] = resolvedScope;
      draftDirtyRef.current.add(draftKey);
      draftVersionRef.current[draftKey] =
        (draftVersionRef.current[draftKey] || 0) + 1;
      draftGenerationRef.current[draftKey] =
        (draftGenerationRef.current[draftKey] || 0) + 1;
      draftUpdatedAtRef.current[draftKey] = new Date().toISOString();
      setCacheVersion();
      setSyncStateFor(draftKey, 'saving');
    },
    [setCacheVersion, setSyncStateFor],
  );

  const loadServerDraft = useCallback(async (draftScope: DraftScope) => {
    return api<ServerDraft>(serverDraftPath(draftScope));
  }, []);

  const queueDraftSync = useCallback(
    (draftKey: string, draftScope: DraftScope, delay = SYNC_DEBOUNCE_MS) => {
      if (typeof window === 'undefined' || !draftDirtyRef.current.has(draftKey))
        return;
      if (draftConflictsRef.current[draftKey]) return;
      clearDraftTimer(draftKey);
      if (draftSavesRef.current[draftKey]) {
        draftQueuedRef.current.add(draftKey);
        return;
      }
      const version = draftVersionRef.current[draftKey] || 0;
      const generation = draftGenerationRef.current[draftKey] || 0;
      draftTimersRef.current[draftKey] = window.setTimeout(() => {
        delete draftTimersRef.current[draftKey];
        if (
          !draftDirtyRef.current.has(draftKey) ||
          draftConflictsRef.current[draftKey]
        )
          return;
        const content = draftsRef.current[draftKey] || '';
        const attachments = draftAttachmentsRef.current[draftKey] || [];
        const promise = persistDraftRef.current(
          draftKey,
          draftScope,
          content,
          attachments,
          version,
          generation,
        );
        draftSavesRef.current[draftKey] = promise;
        void promise
          .finally(() => {
            if (draftSavesRef.current[draftKey] === promise)
              delete draftSavesRef.current[draftKey];
            const currentVersion = draftVersionRef.current[draftKey] || 0;
            const shouldContinue =
              draftDirtyRef.current.has(draftKey) &&
              !draftConflictsRef.current[draftKey] &&
              (draftQueuedRef.current.delete(draftKey) ||
                currentVersion !== version);
            if (shouldContinue)
              queueDraftSyncRef.current(
                draftKey,
                draftScopesRef.current[draftKey] || draftScope,
                80,
              );
          })
          .catch(() => undefined);
      }, delay);
    },
    [clearDraftTimer],
  );

  useEffect(() => {
    queueDraftSyncRef.current = queueDraftSync;
  }, [queueDraftSync]);

  const scheduleRetry = useCallback(
    (draftKey: string, draftScope: DraftScope) => {
      if (
        !draftDirtyRef.current.has(draftKey) ||
        draftConflictsRef.current[draftKey]
      )
        return;
      const count = Math.min(
        (draftRetryCountRef.current[draftKey] || 0) + 1,
        RETRY_LIMIT,
      );
      draftRetryCountRef.current[draftKey] = count;
      queueDraftSync(
        draftKey,
        draftScope,
        Math.min(30_000, RETRY_BASE_MS * 2 ** (count - 1)),
      );
    },
    [queueDraftSync],
  );

  const persistDraft = useCallback(
    async (
      draftKey: string,
      draftScope: DraftScope,
      content: string,
      attachments: Attachment[],
      version: number,
      generation: number,
    ) => {
      if (
        !draftDirtyRef.current.has(draftKey) ||
        draftVersionRef.current[draftKey] !== version
      )
        return;
      setSyncStateFor(draftKey, 'saving');
      const revision = draftRevisionRef.current[draftKey];
      try {
        const saved = await api<ServerDraft | null>('drafts', 'PUT', {
          spaceId: draftScope.spaceId,
          roleId: draftScope.roleId,
          content,
          attachmentIds: attachmentIds(attachments),
          ...(revision !== undefined ? { revision } : {}),
        });
        // A send/clear can invalidate this request while it is in flight. Do not
        // let the old response put a revision or base back into the new draft.
        if (draftGenerationRef.current[draftKey] !== generation) return;
        if (saved?.revision !== undefined)
          draftRevisionRef.current[draftKey] = saved.revision;
        else delete draftRevisionRef.current[draftKey];
        draftBaseRef.current[draftKey] = {
          content: saved?.content || '',
          attachmentIds: saved?.attachmentIds || attachmentIds(attachments),
        };
        if (
          draftVersionRef.current[draftKey] !== version ||
          !draftDirtyRef.current.has(draftKey)
        )
          return;
        draftDirtyRef.current.delete(draftKey);
        delete draftScopesRef.current[draftKey];
        delete draftRetryCountRef.current[draftKey];
        delete draftConflictsRef.current[draftKey];
        draftUpdatedAtRef.current[draftKey] =
          saved?.updatedAt ||
          draftUpdatedAtRef.current[draftKey] ||
          new Date().toISOString();
        if (activeKeyRef.current === draftKey)
          setDraftConflict((current) =>
            current?.key === draftKey ? null : current,
          );
        setCacheVersion();
        setSyncStateFor(draftKey, 'saved');
      } catch (rawError) {
        const error = rawError as Error & { status?: number };
        if (error.status === 409) {
          try {
            const latest = await loadServerDraft(draftScope);
            const remoteAttachments = validAttachments(latest.attachments);
            const remoteContent =
              typeof latest.content === 'string' ? latest.content : '';
            const remoteBase: DraftBase = {
              content: remoteContent,
              attachmentIds:
                latest.attachmentIds || attachmentIds(remoteAttachments),
            };
            if (draftGenerationRef.current[draftKey] !== generation) return;
            if (latest.revision !== undefined)
              draftRevisionRef.current[draftKey] = latest.revision;
            const localContent = draftsRef.current[draftKey] ?? content;
            const localAttachments =
              draftAttachmentsRef.current[draftKey] || attachments;
            const base = draftBaseRef.current[draftKey] || emptyBase();
            const mergedText = mergeDraftText(
              base.content,
              localContent,
              remoteContent,
            );
            const mergedFiles = mergeDraftAttachments(
              base.attachmentIds,
              localAttachments,
              remoteAttachments,
            );
            if (mergedText.conflict || mergedFiles.conflict) {
              const conflict = {
                key: draftKey,
                spaceId: draftScope.spaceId,
                roleId: draftScope.roleId,
                localContent,
                remoteContent,
                localAttachments,
                remoteAttachments,
                remoteRevision: latest.revision,
                remoteUpdatedAt: latest.updatedAt,
              } satisfies DraftConflict;
              draftConflictsRef.current[draftKey] = conflict;
              if (activeKeyRef.current === draftKey) setDraftConflict(conflict);
              setSyncStateFor(draftKey, 'conflict');
              return;
            }
            draftBaseRef.current[draftKey] = remoteBase;
            draftsRef.current[draftKey] = mergedText.content;
            draftAttachmentsRef.current[draftKey] = mergedFiles.attachments;
            setDrafts((current) => ({
              ...current,
              [draftKey]: mergedText.content,
            }));
            setDraftAttachments((current) => ({
              ...current,
              [draftKey]: mergedFiles.attachments,
            }));
            if (
              mergedText.content === remoteContent &&
              JSON.stringify(attachmentIds(mergedFiles.attachments)) ===
                JSON.stringify(remoteBase.attachmentIds)
            ) {
              draftDirtyRef.current.delete(draftKey);
              delete draftScopesRef.current[draftKey];
              delete draftRetryCountRef.current[draftKey];
              setCacheVersion();
              setSyncStateFor(draftKey, 'saved');
            } else {
              markDraftDirty(draftKey, draftScope);
              queueDraftSync(draftKey, draftScope, 80);
            }
            return;
          } catch {
            // Keep pending local state and use the same retry path as transport failures.
          }
        }
        setSyncStateFor(draftKey, 'offline');
        scheduleRetry(draftKey, draftScope);
      }
    },
    [
      loadServerDraft,
      markDraftDirty,
      queueDraftSync,
      scheduleRetry,
      setCacheVersion,
      setSyncStateFor,
    ],
  );

  useEffect(() => {
    persistDraftRef.current = persistDraft;
  }, [persistDraft]);

  const clearLocalMetadata = useCallback(
    (draftKey: string) => {
      delete draftRevisionRef.current[draftKey];
      delete draftUpdatedAtRef.current[draftKey];
      delete draftBaseRef.current[draftKey];
      delete draftScopesRef.current[draftKey];
      delete draftRetryCountRef.current[draftKey];
      delete draftConflictsRef.current[draftKey];
      draftDirtyRef.current.delete(draftKey);
      setCacheVersion();
      if (activeKeyRef.current === draftKey)
        setDraftConflict((current) =>
          current?.key === draftKey ? null : current,
        );
    },
    [setCacheVersion],
  );

  const clearServerDraft = useCallback(
    async (
      draftKey: string,
      draftScope: DraftScope,
      sentContent = '',
      sentAttachmentIds: string[] = [],
    ) => {
      clearDraftTimer(draftKey);
      draftQueuedRef.current.delete(draftKey);
      const inFlight = draftSavesRef.current[draftKey];
      if (inFlight) await inFlight.catch(() => undefined);
      // An in-flight conflict/merge may have queued a follow-up timer while we
      // awaited it; cancel that timer before invalidating the draft generation.
      clearDraftTimer(draftKey);
      draftQueuedRef.current.delete(draftKey);
      draftGenerationRef.current[draftKey] =
        (draftGenerationRef.current[draftKey] || 0) + 1;
      draftVersionRef.current[draftKey] =
        (draftVersionRef.current[draftKey] || 0) + 1;
      try {
        const latest = await loadServerDraft(draftScope);
        if (!latest.revision) {
          clearLocalMetadata(draftKey);
          setSyncStateFor(draftKey, 'saved');
          return;
        }
        const sameContent =
          latest.content.trim() === sentContent.trim() &&
          JSON.stringify(latest.attachmentIds || []) ===
            JSON.stringify(sentAttachmentIds);
        if (!sameContent) {
          // Another device owns a different draft. Preserve it on the server and
          // clear only this device's sent composer state.
          clearLocalMetadata(draftKey);
          setSyncStateFor(draftKey, 'saved');
          return;
        }
        await api('drafts', 'DELETE', {
          spaceId: draftScope.spaceId,
          roleId: draftScope.roleId,
          revision: latest.revision,
        });
        clearLocalMetadata(draftKey);
        setSyncStateFor(draftKey, 'saved');
      } catch (rawError) {
        clearLocalMetadata(draftKey);
        const error = rawError as Error & { status?: number };
        setSyncStateFor(draftKey, error.status === 409 ? 'saved' : 'offline');
      }
    },
    [clearDraftTimer, clearLocalMetadata, loadServerDraft, setSyncStateFor],
  );

  const resolveDraftConflict = useCallback(
    (choice: 'local' | 'remote') => {
      const conflict = draftConflict;
      if (!conflict) return;
      const draftKey = conflict.key;
      clearDraftTimer(draftKey);
      if (choice === 'remote') {
        draftsRef.current[draftKey] = conflict.remoteContent;
        draftAttachmentsRef.current[draftKey] = conflict.remoteAttachments;
        setDrafts((current) => ({
          ...current,
          [draftKey]: conflict.remoteContent,
        }));
        setDraftAttachments((current) => ({
          ...current,
          [draftKey]: conflict.remoteAttachments,
        }));
        draftBaseRef.current[draftKey] = {
          content: conflict.remoteContent,
          attachmentIds: attachmentIds(conflict.remoteAttachments),
        };
        if (conflict.remoteRevision !== undefined)
          draftRevisionRef.current[draftKey] = conflict.remoteRevision;
        clearLocalMetadata(draftKey);
        setSyncStateFor(draftKey, 'saved');
        return;
      }
      const localContent = draftsRef.current[draftKey] ?? conflict.localContent;
      const localAttachments =
        draftAttachmentsRef.current[draftKey] ?? conflict.localAttachments;
      draftBaseRef.current[draftKey] = {
        content: conflict.remoteContent,
        attachmentIds: attachmentIds(conflict.remoteAttachments),
      };
      if (conflict.remoteRevision !== undefined)
        draftRevisionRef.current[draftKey] = conflict.remoteRevision;
      delete draftConflictsRef.current[draftKey];
      draftsRef.current[draftKey] = localContent;
      draftAttachmentsRef.current[draftKey] = localAttachments;
      setDraftConflict(null);
      markDraftDirty(draftKey, {
        spaceId: conflict.spaceId,
        roleId: conflict.roleId,
      });
      queueDraftSync(
        draftKey,
        { spaceId: conflict.spaceId, roleId: conflict.roleId },
        80,
      );
    },
    [
      clearDraftTimer,
      clearLocalMetadata,
      draftConflict,
      markDraftDirty,
      queueDraftSync,
      setSyncStateFor,
    ],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const cached = readDraftCache();
      setDrafts((current) => ({ ...cached.drafts, ...current }));
      setDraftAttachments((current) => ({ ...cached.attachments, ...current }));
      draftsRef.current = { ...cached.drafts, ...draftsRef.current };
      draftAttachmentsRef.current = {
        ...cached.attachments,
        ...draftAttachmentsRef.current,
      };
      draftUpdatedAtRef.current = cached.updatedAt || {};
      draftRevisionRef.current = cached.revisions || {};
      draftBaseRef.current = cached.bases || {};
      draftScopesRef.current = cached.pending || {};
      for (const pendingKey of Object.keys(draftScopesRef.current)) {
        draftDirtyRef.current.add(pendingKey);
        draftVersionRef.current[pendingKey] =
          (draftVersionRef.current[pendingKey] || 0) + 1;
        draftGenerationRef.current[pendingKey] =
          (draftGenerationRef.current[pendingKey] || 0) + 1;
      }
      draftCacheHydrated.current = true;
      setDraftCacheReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!draftCacheHydrated.current) return;
    try {
      const cache: DraftCache = {
        drafts,
        attachments: draftAttachments,
        updatedAt: draftUpdatedAtRef.current,
        revisions: draftRevisionRef.current,
        bases: draftBaseRef.current,
        pending: draftScopesRef.current,
      };
      window.localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Storage quotas and private browsing restrictions are recoverable.
    }
  }, [cacheVersion, draftAttachments, drafts, draftSyncState]);

  useEffect(() => {
    activeKeyRef.current = key;
    activeScopeRef.current = stableScope;
    setDraftSyncState(
      draftStatusesRef.current[key] ||
        (draftDirtyRef.current.has(key) ? 'saving' : 'idle'),
    );
    setDraftConflict(draftConflictsRef.current[key] || null);
  }, [key, stableScope]);

  useEffect(() => {
    draftsRef.current = drafts;
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments, drafts]);

  useEffect(() => {
    if (!draftCacheReady || !ready || !stableScope.roleId) return;
    const draftKey = key;
    const restoreScope: DraftScope = stableScope;
    let cancelled = false;
    const restore = async () => {
      try {
        const remote = await loadServerDraft(restoreScope);
        if (cancelled || activeKeyRef.current !== draftKey) return;
        const remoteAttachments = validAttachments(remote.attachments);
        const remoteContent =
          typeof remote.content === 'string' ? remote.content : '';
        const remoteBase: DraftBase = {
          content: remoteContent,
          attachmentIds:
            remote.attachmentIds || attachmentIds(remoteAttachments),
        };
        const localContent = draftsRef.current[draftKey] ?? '';
        const localAttachments = draftAttachmentsRef.current[draftKey] || [];
        const localIds = attachmentIds(localAttachments);
        const pending =
          draftDirtyRef.current.has(draftKey) ||
          Boolean(draftScopesRef.current[draftKey]);
        const base = draftBaseRef.current[draftKey];
        if (!pending) {
          draftsRef.current[draftKey] = remoteContent;
          draftAttachmentsRef.current[draftKey] = remoteAttachments;
          setDrafts((current) => ({ ...current, [draftKey]: remoteContent }));
          setDraftAttachments((current) => ({
            ...current,
            [draftKey]: remoteAttachments,
          }));
          draftBaseRef.current[draftKey] = remoteBase;
          if (remote.revision !== undefined)
            draftRevisionRef.current[draftKey] = remote.revision;
          else delete draftRevisionRef.current[draftKey];
          draftUpdatedAtRef.current[draftKey] =
            remote.updatedAt || new Date().toISOString();
          setSyncStateFor(draftKey, 'saved');
          return;
        }
        if (
          localContent === remoteContent &&
          JSON.stringify(localIds) === JSON.stringify(remoteBase.attachmentIds)
        ) {
          draftBaseRef.current[draftKey] = remoteBase;
          if (remote.revision !== undefined)
            draftRevisionRef.current[draftKey] = remote.revision;
          draftDirtyRef.current.delete(draftKey);
          delete draftScopesRef.current[draftKey];
          delete draftRetryCountRef.current[draftKey];
          setCacheVersion();
          setSyncStateFor(draftKey, 'saved');
          return;
        }
        const mergeBase = base || emptyBase();
        const mergedText = mergeDraftText(
          mergeBase.content,
          localContent,
          remoteContent,
        );
        const mergedFiles = mergeDraftAttachments(
          mergeBase.attachmentIds,
          localAttachments,
          remoteAttachments,
        );
        if (
          mergedText.conflict ||
          mergedFiles.conflict ||
          (!base && (remoteContent || remoteAttachments.length))
        ) {
          const conflict = {
            key: draftKey,
            spaceId: restoreScope.spaceId,
            roleId: restoreScope.roleId,
            localContent,
            remoteContent,
            localAttachments,
            remoteAttachments,
            remoteRevision: remote.revision,
            remoteUpdatedAt: remote.updatedAt,
          } satisfies DraftConflict;
          draftConflictsRef.current[draftKey] = conflict;
          setDraftConflict(conflict);
          setSyncStateFor(draftKey, 'conflict');
          return;
        }
        draftsRef.current[draftKey] = mergedText.content;
        draftAttachmentsRef.current[draftKey] = mergedFiles.attachments;
        setDrafts((current) => ({
          ...current,
          [draftKey]: mergedText.content,
        }));
        setDraftAttachments((current) => ({
          ...current,
          [draftKey]: mergedFiles.attachments,
        }));
        draftBaseRef.current[draftKey] = remoteBase;
        if (remote.revision !== undefined)
          draftRevisionRef.current[draftKey] = remote.revision;
        else delete draftRevisionRef.current[draftKey];
        if (
          mergedText.content === remoteContent &&
          JSON.stringify(attachmentIds(mergedFiles.attachments)) ===
            JSON.stringify(remoteBase.attachmentIds)
        ) {
          draftDirtyRef.current.delete(draftKey);
          delete draftScopesRef.current[draftKey];
          delete draftRetryCountRef.current[draftKey];
          setCacheVersion();
          setSyncStateFor(draftKey, 'saved');
          return;
        }
        markDraftDirty(draftKey, restoreScope);
        queueDraftSync(draftKey, restoreScope, 80);
      } catch {
        if (!cancelled) setSyncStateFor(draftKey, 'offline');
      }
    };
    void restore();
    return () => {
      cancelled = true;
      clearDraftTimer(draftKey);
    };
  }, [
    clearDraftTimer,
    draftCacheReady,
    key,
    loadServerDraft,
    markDraftDirty,
    queueDraftSync,
    ready,
    stableScope,
    setCacheVersion,
    setSyncStateFor,
  ]);

  useEffect(() => {
    if (!draftCacheReady || !draftDirtyRef.current.has(key)) return;
    queueDraftSync(key, stableScope);
  }, [
    draftAttachments,
    draftCacheReady,
    drafts,
    key,
    queueDraftSync,
    stableScope,
  ]);

  useEffect(() => {
    if (!draftCacheReady || typeof window === 'undefined') return;
    const retryPending = () => {
      for (const [pendingKey, pendingScope] of Object.entries(
        draftScopesRef.current,
      )) {
        if (
          draftDirtyRef.current.has(pendingKey) &&
          !draftConflictsRef.current[pendingKey]
        ) {
          queueDraftSync(pendingKey, pendingScope, 0);
        }
      }
    };
    window.addEventListener('online', retryPending);
    window.addEventListener('focus', retryPending);
    document.addEventListener('visibilitychange', retryPending);
    return () => {
      window.removeEventListener('online', retryPending);
      window.removeEventListener('focus', retryPending);
      document.removeEventListener('visibilitychange', retryPending);
    };
  }, [draftCacheReady, queueDraftSync]);

  useEffect(
    () => () => {
      for (const draftKey of Object.keys(draftTimersRef.current))
        clearDraftTimer(draftKey);
    },
    [clearDraftTimer],
  );

  return {
    drafts,
    setDrafts,
    draftAttachments,
    setDraftAttachments,
    draftCacheReady,
    draftSyncState,
    draftConflict,
    setDraftConflict,
    markDraftDirty,
    clearServerDraft,
    resolveDraftConflict,
    draftVersionRef,
    draftsRef,
    draftAttachmentsRef,
  };
}

export { draftKeyFor };
