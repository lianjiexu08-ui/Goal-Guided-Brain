'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readWorkbenchState } from './state-client';
import type { State } from './model';

/** Polls share an in-flight read; explicit refreshes supersede older snapshots. */
export function useWorkbenchRefresh(onSnapshot: (snapshot: State) => void) {
  const [connectionError, setConnectionError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const mounted = useRef(false);
  const generation = useRef(0);
  const etag = useRef<string | null>(null);
  const lastSnapshot = useRef<State | null>(null);
  const pending = useRef<{
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);

  const read = useCallback(
    (replace = false): Promise<void> => {
      if (!mounted.current) return Promise.resolve();
      if (pending.current && !replace) return pending.current.promise;
      const id = ++generation.current;
      pending.current?.controller.abort();
      const controller = new AbortController();
      let timedOut = false;
      if (replace || !lastSnapshot.current) setRefreshing(true);
      const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      const current = () => mounted.current && generation.current === id;
      const promise = readWorkbenchState(
        controller.signal,
        replace ? null : etag.current,
        replace ? null : lastSnapshot.current,
      )
        .then(({ snapshot, etag: nextEtag }) => {
          if (!current()) return;
          if (snapshot) lastSnapshot.current = snapshot;
          // A 304 confirms this exact object. Reusing it avoids replacing
          // unchanged data, while reconciling interim recruitment updates.
          if (lastSnapshot.current) onSnapshot(lastSnapshot.current);
          etag.current = nextEtag;
          setConnectionError('');
        })
        .catch((reason: unknown) => {
          if (!current()) return;
          etag.current = null;
          setConnectionError(
            timedOut
              ? '连接超时，请重试。'
              : reason instanceof Error
                ? reason.message
                : '暂时无法读取工作台。',
          );
        })
        .finally(() => {
          window.clearTimeout(timer);
          if (!current()) return;
          pending.current = null;
          setRefreshing(false);
        });
      pending.current = { controller, promise };
      return promise;
    },
    [onSnapshot],
  );

  const refresh = useCallback(() => read(true), [read]);
  useEffect(() => {
    mounted.current = true;
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current?.controller.abort();
      pending.current = null;
      window.clearInterval(timer);
    };
  }, [read]);

  return { refresh, refreshing, connectionError };
}
