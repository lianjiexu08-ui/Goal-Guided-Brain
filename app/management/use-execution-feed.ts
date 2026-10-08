'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
} from '../workbench-api';

type Connection =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'polling';
const readError = (failure: unknown) =>
  failure instanceof TypeError
    ? '无法连接工作台，请检查网络后重试。'
    : failure instanceof Error
      ? failure.message
      : '执行进展读取失败，请重试。';
const eventCursor = (event: Entity) =>
  `${txt(event, 'createdAt') || txt(event, 'at')}|${event.id}`;
const validEvents = (items: unknown): items is Entity[] =>
  Array.isArray(items) &&
  items.every((item) => item && typeof item.id === 'string');
function mergeEvents(current: Entity, incoming: Entity[]) {
  const events = new Map(
    entityList(current.events).map((item) => [item.id, item]),
  );
  for (const item of incoming) events.set(item.id, item);
  return {
    ...current,
    events: [...events.values()].sort((a, b) =>
      eventCursor(b).localeCompare(eventCursor(a)),
    ),
  };
}

export function useExecutionFeed(taskId: string) {
  const [execution, setExecution] = useState<Entity | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [connection, setConnection] = useState<Connection>('connecting');
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const refresh = useCallback((force = true) => refreshRef.current(force), []);

  useEffect(() => {
    let disposed = false;
    let loaded = false;
    let snapshotAt = 0;
    let needsSnapshot = false;
    let snapshotController: AbortController | null = null;
    let pending: Promise<void> | null = null;
    let dirty = false;
    let pollController: AbortController | null = null;
    let pollCursor: string | null = null;
    let streamCursor: string | null = null;
    let duringSnapshot: Entity[] = [];
    let source: EventSource | null = null;
    let streamReady = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const readSnapshot = (force = false): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (pending && !force) {
        dirty = true;
        return pending;
      }
      if (force) {
        pollController?.abort();
        pollController = null;
      }
      snapshotController?.abort();
      const controller = new AbortController();
      snapshotController = controller;
      duringSnapshot = [];
      dirty = false;
      setRefreshing(true);
      const timeout = setTimeout(() => controller.abort(), 10_000);
      pending = (async () => {
        try {
          const item = await api<Entity>(
            `tasks/${taskId}`,
            'GET',
            undefined,
            controller.signal,
          );
          if (disposed || snapshotController !== controller) return;
          if (
            !item ||
            item.id !== taskId ||
            typeof item.status !== 'string' ||
            !validEvents(item.events)
          )
            throw Error('执行详情返回了无效数据，请重试。');
          if (!loaded) {
            const latest = [...item.events].sort((a, b) =>
              eventCursor(b).localeCompare(eventCursor(a)),
            )[0];
            pollCursor = latest ? eventCursor(latest) : null;
          }
          loaded = true;
          needsSnapshot = false;
          snapshotAt = Date.now();
          setExecution(mergeEvents(item, duringSnapshot));
          setUpdatedAt(snapshotAt);
          setError('');
        } catch (failure) {
          if (!disposed && snapshotController === controller) {
            needsSnapshot = true;
            setError(
              controller.signal.aborted
                ? '执行详情读取超时，请重试。'
                : readError(failure),
            );
          }
        } finally {
          clearTimeout(timeout);
          if (snapshotController === controller) {
            snapshotController = null;
            pending = null;
            if (!disposed) {
              setRefreshing(false);
              if (dirty) void readSnapshot();
            }
          }
        }
      })();
      return pending;
    };
    refreshRef.current = readSnapshot;
    const receive = (items: Entity[]) => {
      if (disposed) return;
      if (pending) duringSnapshot.push(...items);
      setExecution((current) =>
        current ? mergeEvents(current, items) : current,
      );
    };
    const poll = async () => {
      if (disposed || pollController || !navigator.onLine) return;
      if (!loaded) {
        await readSnapshot();
        return;
      }
      const controller = new AbortController();
      pollController = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const after = pollCursor
          ? `&after=${encodeURIComponent(pollCursor)}`
          : '';
        const page = await api<{
          items: Entity[];
          cursor: string | null;
          hasMore: boolean;
        }>(
          `tasks/${taskId}/events?limit=100${after}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (disposed || pollController !== controller) return;
        if (
          !page ||
          !validEvents(page.items) ||
          (page.cursor !== null && typeof page.cursor !== 'string')
        )
          throw Error('执行事件返回了无效数据，请重试。');
        pollCursor = page.cursor || pollCursor;
        receive(page.items);
        if (
          page.items.length ||
          needsSnapshot ||
          Date.now() - snapshotAt >= 15_000
        )
          await readSnapshot();
      } catch (failure) {
        if (!disposed && pollController === controller) {
          needsSnapshot = true;
          setError(
            controller.signal.aborted
              ? '执行进展更新超时，请重试。'
              : readError(failure),
          );
        }
      } finally {
        clearTimeout(timeout);
        if (pollController === controller) pollController = null;
      }
    };
    const connect = () => {
      clearTimeout(reconnectTimer);
      source?.close();
      streamReady = false;
      if (!navigator.onLine) {
        setConnection('offline');
        return;
      }
      if (typeof EventSource !== 'function') {
        setConnection('polling');
        return;
      }
      const after = streamCursor
        ? `?after=${encodeURIComponent(streamCursor)}`
        : '';
      const current = new EventSource(
        `/api/tasks/${encodeURIComponent(taskId)}/events/stream${after}`,
      );
      source = current;
      const active = () => !disposed && source === current;
      current.addEventListener('task_event', (event: MessageEvent<string>) => {
        if (!active()) return;
        try {
          const item: unknown = JSON.parse(event.data);
          if (!validEvents([item])) return;
          const record = item as Entity;
          streamCursor = event.lastEventId || eventCursor(record);
          receive([record]);
          if (streamReady && !refreshTimer)
            refreshTimer = setTimeout(() => {
              refreshTimer = undefined;
              void readSnapshot();
            }, 120);
        } catch {
          /* Cursor polling recovers malformed or missing stream events. */
        }
      });
      current.addEventListener('ready', () => {
        if (!active()) return;
        streamReady = true;
        setConnection('live');
        void readSnapshot();
      });
      current.addEventListener('error', () => {
        if (!active()) return;
        streamReady = false;
        setConnection(navigator.onLine ? 'reconnecting' : 'offline');
        // CONNECTING reconnects natively with Last-Event-ID. CLOSED needs a new stream.
        if (current.readyState === EventSource.CLOSED)
          reconnectTimer = setTimeout(connect, 2500);
      });
    };
    const recover = () => {
      if (!navigator.onLine) return;
      if (!source || source.readyState === EventSource.CLOSED) connect();
      void readSnapshot(true);
      void poll();
    };
    const offline = () => {
      source?.close();
      setConnection('offline');
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    void readSnapshot();
    connect();
    const timer = setInterval(() => void poll(), 2500);
    window.addEventListener('online', recover);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer);
      snapshotController?.abort();
      pollController?.abort();
      source?.close();
      window.removeEventListener('online', recover);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [taskId]);
  return { execution, error, refreshing, updatedAt, connection, refresh };
}
