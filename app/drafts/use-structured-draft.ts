'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';

type Snapshot<T> = { value: T; revision: number };
type Cache<T> = Snapshot<T> & {
  base: T | null;
  dirty: boolean;
  awaitingReceipt?: boolean;
};
export type SyncStatus =
  | 'loading'
  | 'saving'
  | 'saved'
  | 'offline'
  | 'conflict';
export const pendingDraftId = (value: object) => {
  const draft = value as {
    clientMessageId?: string;
    pending?: { requestId?: string };
  };
  return draft.clientMessageId || draft.pending?.requestId;
};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const eventName = 'ggb-structured-draft-change';

export function useStructuredDraft<T extends object>({
  endpoint,
  legacyKey,
  empty,
  valid,
  enabled = true,
}: {
  endpoint: string;
  legacyKey: string;
  empty: T;
  valid: (value: unknown) => boolean;
  enabled?: boolean;
}) {
  const cacheKey = `${legacyKey}:sync.v1`;
  const initial = (): Cache<T> => ({
    value: empty,
    base: null,
    revision: 0,
    dirty: false,
  });
  const current = useRef<Cache<T>>(initial());
  const [draft, setDraft] = useState(empty);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SyncStatus>('loading');
  const [storageError, setStorageError] = useState('');
  const [conflict, setConflict] = useState<Snapshot<T> | null>(null);
  const conflictRef = useRef<Snapshot<T> | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const options = useRef({ endpoint, valid, enabled, empty });
  useEffect(() => {
    options.current = { endpoint, valid, enabled, empty };
  }, [endpoint, valid, enabled, empty]);

  function persist(next: Cache<T>) {
    if (!mounted.current) return;
    current.current = next;
    if (mounted.current) setDraft(next.value);
    try {
      // Keep this tab's unsent edits/receipt when another tab updates the shared
      // fallback cache. The fallback still restores work after opening a new tab.
      sessionStorage.setItem(cacheKey, JSON.stringify(next));
      localStorage.setItem(cacheKey, JSON.stringify(next));
      localStorage.removeItem(legacyKey);
      if (mounted.current) setStorageError('');
      window.dispatchEvent(new CustomEvent(eventName, { detail: cacheKey }));
    } catch {
      if (mounted.current)
        setStorageError('本机副本未能保存，请保持页面并复制重要内容。');
    }
  }
  function showConflict(remote: Snapshot<T> | null) {
    conflictRef.current = remote;
    if (mounted.current) setConflict(remote);
  }
  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void syncRef.current(), 650);
  }
  function update(value: T) {
    if (!mounted.current) return value;
    persist({
      ...current.current,
      value,
      dirty: true,
      awaitingReceipt:
        current.current.awaitingReceipt &&
        pendingDraftId(value) === pendingDraftId(current.current.value),
    });
    if (!conflictRef.current) setStatus('saving');
    schedule();
    return value;
  }
  async function exchange(method = 'GET', body?: object) {
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await api<Snapshot<T>>(
        options.current.endpoint,
        method,
        body,
        abort.signal,
      );
      if (
        !Number.isSafeInteger(result?.revision) ||
        result.revision < 0 ||
        !options.current.valid(result.value)
      )
        throw new Error('草稿回执不完整。');
      return result;
    } finally {
      clearTimeout(timeout);
      if (controller.current === abort) controller.current = null;
    }
  }
  async function reconcile(remote: Snapshot<T>) {
    if (!mounted.current) return;
    const local = current.current;
    // A consumed remote draft is not a business receipt. Retain this device's
    // immutable request until its POST is acknowledged, including after reload.
    if (
      local.awaitingReceipt &&
      pendingDraftId(local.value) &&
      !same(local.value, remote.value)
    ) {
      setStatus('saved');
      return;
    }
    if (!local.dirty || same(local.value, remote.value)) {
      persist({
        ...remote,
        base: remote.value,
        dirty: false,
        awaitingReceipt: local.awaitingReceipt,
      });
      showConflict(null);
      setStatus('saved');
      return;
    }
    if (
      (local.base === null && remote.revision !== 0) ||
      (remote.revision !== local.revision && !same(remote.value, local.base))
    ) {
      showConflict(remote);
      setStatus('conflict');
      return;
    }
    showConflict(null);
    setStatus('saving');
    const sent = local.value;
    const saved = await exchange('PUT', {
      value: sent,
      revision: remote.revision,
    });
    if (!mounted.current) return;
    const latest = current.current.value;
    const unchanged = same(latest, sent);
    persist({
      value: unchanged ? saved.value : latest,
      revision: saved.revision,
      base: saved.value,
      dirty: !unchanged,
    });
    setStatus(unchanged ? 'saved' : 'saving');
    if (!unchanged) schedule();
  }
  async function sync() {
    if (!mounted.current || !options.current.enabled) return;
    if (inFlight.current) return inFlight.current;
    const promise = (async () => {
      try {
        await reconcile(await exchange());
      } catch (error) {
        if (!mounted.current) return;
        if ((error as Error & { status?: number }).status === 409) {
          try {
            await reconcile(await exchange());
            return;
          } catch {
            /* Retry later. */
          }
        }
        setStatus('offline');
      }
    })();
    inFlight.current = promise;
    try {
      await promise;
    } finally {
      if (inFlight.current === promise) inFlight.current = null;
    }
  }
  useEffect(() => {
    syncRef.current = sync;
  });

  useEffect(() => {
    mounted.current = true;
    let cache: Cache<T> = {
      value: options.current.empty,
      base: null,
      revision: 0,
      dirty: false,
    };
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(cacheKey) ||
          localStorage.getItem(cacheKey) ||
          'null',
      );
      const legacy = saved
        ? null
        : JSON.parse(localStorage.getItem(legacyKey) || 'null');
      if (saved) {
        if (
          !options.current.valid(saved.value) ||
          (saved.base !== null && !options.current.valid(saved.base)) ||
          !Number.isSafeInteger(saved.revision) ||
          saved.revision < 0 ||
          typeof saved.dirty !== 'boolean'
        )
          throw new Error();
        cache = saved;
      } else if (legacy) {
        if (!options.current.valid(legacy)) throw new Error();
        cache = { ...cache, value: legacy, dirty: true };
      }
      current.current = cache;
      setDraft(cache.value);
    } catch {
      setStorageError('本机草稿无法读取，请保留原数据并复制重要内容。');
    }
    setReady(true);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
    // Each consumer is keyed by its team/message identity.
  }, [cacheKey, legacyKey]);

  useEffect(() => {
    if (!ready || !enabled) return;
    void syncRef.current();
    const refresh = () => void syncRef.current();
    const interval = setInterval(refresh, 3000);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    // Other tabs/mounts trigger a server read; never blindly overwrite edits
    // from a storage event. Revision conflicts remain visible in both views.
    const storage = (event: StorageEvent) => {
      if (event.key === cacheKey) refresh();
    };
    const local = (event: Event) => {
      if ((event as CustomEvent).detail === cacheKey && !inFlight.current)
        schedule();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(eventName, local);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('storage', storage);
      window.removeEventListener(eventName, local);
    };
    // Scheduling uses the current controller and scope refs.
  }, [ready, enabled, cacheKey]);

  async function commit(value: T) {
    if (!mounted.current) throw new Error('当前草稿已关闭，请重新打开后提交。');
    if (conflictRef.current) throw new Error('请先处理草稿冲突，再重新审阅。');
    if (!current.current.dirty && same(current.current.value, value)) {
      persist({ ...current.current, awaitingReceipt: true });
      return { value, revision: current.current.revision };
    }
    update(value);
    if (inFlight.current) await inFlight.current;
    await syncRef.current();
    if (
      current.current.dirty ||
      !same(current.current.value, value) ||
      conflictRef.current
    )
      throw new Error('待确认请求尚未同步，请检查草稿状态后重试。');
    persist({ ...current.current, awaitingReceipt: true });
    return { value: current.current.value, revision: current.current.revision };
  }
  function resolve(choice: 'local' | 'remote') {
    const remote = conflictRef.current;
    if (!remote) return;
    if (choice === 'local' && pendingDraftId(remote.value)) return;
    const value = choice === 'remote' ? remote.value : current.current.value;
    persist({
      value,
      base: remote.value,
      revision: remote.revision,
      dirty: !same(value, remote.value),
    });
    showConflict(null);
    setStatus(choice === 'remote' ? 'saved' : 'saving');
    schedule();
  }
  // The server clears only the matching pending request in the same transaction
  // as its business action. Refresh instead of issuing a destructive late PUT.
  async function completed(requestId: string) {
    if (inFlight.current) await inFlight.current;
    if (pendingDraftId(current.current.value) !== requestId) return;
    persist({ ...current.current, dirty: false, awaitingReceipt: false });
    await syncRef.current();
  }
  return {
    draft,
    ready,
    status,
    storageError,
    conflict,
    update,
    commit,
    resolve,
    completed,
    retry: sync,
    getCurrent: () => current.current.value,
  };
}
