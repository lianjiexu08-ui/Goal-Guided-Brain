'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';

type Page<T> = { items: T[]; hasMore: boolean; total?: number };
type PageState<T> = {
  scope: string;
  page: Page<T> | null;
  cursor: string | null;
  loading: boolean;
  error: string;
  failedCursor: string | null;
};

/** Scope both successful data and failures to their originating filters. */
export function useOverviewPage<T extends { id: string }>(
  endpoint: string,
  query: string,
  cursorOf: (item: T) => string,
  refreshKey = '',
) {
  const scope = `${endpoint}?${query}`;
  const active = useRef({
    sequence: 0,
    controller: null as AbortController | null,
  });
  const [state, setState] = useState<PageState<T>>({
    scope: '',
    page: null,
    cursor: null,
    loading: true,
    error: '',
    failedCursor: null,
  });
  const request = useCallback(
    async (before: string | null = null) => {
      active.current.controller?.abort();
      const controller = new AbortController();
      const sequence = ++active.current.sequence;
      active.current.controller = controller;
      const current = () =>
        active.current.sequence === sequence && !controller.signal.aborted;
      setState((previous) => ({
        scope,
        page: previous.scope === scope ? previous.page : null,
        cursor: previous.scope === scope ? previous.cursor : null,
        loading: true,
        error: '',
        failedCursor: null,
      }));
      try {
        const parameters = new URLSearchParams(query);
        if (before) parameters.set('before', before);
        const page = await api<Page<T>>(
          `${endpoint}?${parameters}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (!current()) return;
        const last = page.items.at(-1);
        setState((previous) => ({
          scope,
          page:
            before && previous.scope === scope && previous.page
              ? {
                  ...previous.page,
                  hasMore: page.hasMore,
                  items: [
                    ...new Map(
                      [...previous.page.items, ...page.items].map((item) => [
                        item.id,
                        item,
                      ]),
                    ).values(),
                  ],
                }
              : page,
          cursor: last ? cursorOf(last) : null,
          loading: false,
          error: '',
          failedCursor: null,
        }));
      } catch (error) {
        if (!current()) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : '读取失败，请重试。',
          failedCursor: before,
        }));
      } finally {
        if (current()) active.current.controller = null;
      }
    },
    [cursorOf, endpoint, query, scope],
  );

  useEffect(() => {
    const pending = active.current;
    const timer = window.setTimeout(() => void request(), 0);
    return () => {
      window.clearTimeout(timer);
      ++pending.sequence;
      pending.controller?.abort();
      pending.controller = null;
    };
  }, [request, refreshKey]);

  // A newly selected filter must never display the previous filter's cards,
  // even during the render before its request starts.
  const sameScope = state.scope === scope;
  const page = sameScope ? state.page : null;
  const loading = !sameScope || state.loading;
  return {
    page,
    loading,
    error: sameScope ? state.error : '',
    moreFailed: sameScope && state.failedCursor !== null,
    refresh: () => void request(),
    retry: () => void request(sameScope ? state.failedCursor : null),
    loadMore: () => {
      if (
        !loading &&
        !active.current.controller &&
        page?.hasMore &&
        state.cursor
      )
        void request(state.cursor);
    },
  };
}
