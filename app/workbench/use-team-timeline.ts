'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';
import type { TeamTimelineItem, TimelineFilter } from './model';

type Page = { items: TeamTimelineItem[]; hasMore: boolean; expanded?: boolean };
type Feed = {
  scope: string;
  page: Page | null;
  loading: boolean;
  error: string;
  failedMore: boolean;
};
const cursorOf = (item: TeamTimelineItem) => `${item.at}|${item.id}`;
const olderOrEqual = (a: TeamTimelineItem, b: TeamTimelineItem) =>
  a.at < b.at || (a.at === b.at && a.id <= b.id);
const merge = (items: TeamTimelineItem[]) =>
  [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  );

export function useTeamTimeline(
  teamId: string,
  kind: TimelineFilter | 'collaboration',
  revision: number,
  initialLimit = 120,
) {
  const scope = `${teamId}:${kind}`;
  const [state, setState] = useState<Feed>({
    scope: '',
    page: null,
    loading: true,
    error: '',
    failedMore: false,
  });
  const accepted = useRef(state);
  const lastRevision = useRef(revision);
  const active = useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  const request = useCallback(
    async (more = false, background = false) => {
      if (background && (active.current.controller || accepted.current.error))
        return;
      const previous =
        accepted.current.scope === scope ? accepted.current.page : null;
      if (more && (!previous?.hasMore || !previous.items.length)) return;
      active.current.controller?.abort();
      const controller = new AbortController();
      const sequence = ++active.current.sequence;
      active.current.controller = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      const current = () => active.current.sequence === sequence;
      const save = (feed: Feed) => {
        accepted.current = feed;
        setState(feed);
      };
      save({
        scope,
        page: previous,
        loading: true,
        error: '',
        failedMore: false,
      });
      const read = async (before: string | null, limit: number) => {
        const query = new URLSearchParams({ kind, limit: String(limit) });
        if (before) query.set('before', before);
        const result = await api<Page>(
          `spaces/${encodeURIComponent(teamId)}/timeline?${query}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (
          !result ||
          !Array.isArray(result.items) ||
          typeof result.hasMore !== 'boolean' ||
          result.items.some(
            (item) =>
              !item ||
              typeof item.id !== 'string' ||
              typeof item.at !== 'string',
          )
        )
          throw new Error('团队动态返回不完整，请重试。');
        return result;
      };
      try {
        const oldest = previous?.items[0];
        let page = await read(
          more && oldest ? cursorOf(oldest) : null,
          more ? 60 : initialLimit,
        );
        if (!current()) return;
        let items = [...page.items];
        // Re-read the expanded window, including older pages, so updates and
        // deletions remain visible instead of keeping stale merged history.
        while (
          !more &&
          previous?.expanded &&
          oldest &&
          page.hasMore &&
          page.items[0] &&
          !olderOrEqual(page.items[0], oldest)
        ) {
          const cursor = cursorOf(page.items[0]);
          page = await read(cursor, 60);
          if (!current()) return;
          if (page.items[0] && cursorOf(page.items[0]) >= cursor)
            throw new Error('团队动态游标未前进，请重试。');
          items = [...page.items, ...items];
        }
        if (more) items = [...items, ...(previous?.items || [])];
        save({
          scope,
          page: {
            items: merge(items),
            hasMore: page.hasMore,
            expanded: more || previous?.expanded,
          },
          loading: false,
          error: '',
          failedMore: false,
        });
      } catch (error) {
        if (!current()) return;
        save({
          scope,
          page: previous,
          loading: false,
          error: timedOut
            ? '团队动态读取超时，请重试。'
            : error instanceof Error
              ? error.message
              : '暂时无法读取团队动态。',
          failedMore: more,
        });
      } finally {
        window.clearTimeout(timeout);
        if (current()) active.current.controller = null;
      }
    },
    [scope, teamId, kind, initialLimit],
  );

  useEffect(() => {
    const pending = active.current;
    const initial = window.setTimeout(() => void request(), 0);
    const polling = window.setInterval(() => void request(false, true), 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(polling);
      pending.sequence += 1;
      pending.controller?.abort();
      pending.controller = null;
    };
  }, [request]);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    void request(false, true);
  }, [revision, request]);

  const sameScope = state.scope === scope;
  return {
    page: sameScope ? state.page : null,
    loading: !sameScope || state.loading,
    error: sameScope ? state.error : '',
    moreFailed: sameScope && state.failedMore,
    refresh: () => void request(),
    retry: () => void request(sameScope && state.failedMore),
    loadMore: () => {
      if (!active.current.controller) void request(true);
    },
  };
}
