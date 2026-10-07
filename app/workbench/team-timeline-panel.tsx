'use client';

import { useState, type ReactNode } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { useTeamTimeline } from './use-team-timeline';
import type { TeamTimelineItem, TimelineFilter } from './model';

const filters: Array<{ id: TimelineFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'messages', label: '消息' },
  { id: 'execution', label: '执行' },
  { id: 'evidence', label: '证据' },
  { id: 'risk', label: '风险' },
];

export function TeamTimelinePanel({
  teamId,
  revision,
  renderItem,
}: {
  teamId: string;
  revision: number;
  renderItem: (item: TeamTimelineItem) => ReactNode;
}) {
  const [kind, setKind] = useState<TimelineFilter>('all');
  const { page, loading, error, moreFailed, refresh, retry, loadMore } =
    useTeamTimeline(teamId, kind, revision);
  return (
    <section
      className="team-timeline"
      aria-label="团队统一时间线"
      aria-busy={loading}
    >
      <div className="team-timeline-toolbar">
        <div className="team-activity-title">
          <History size={14} /> 统一时间线
        </div>
        <div
          className="timeline-filters"
          role="tablist"
          aria-label="时间线筛选"
        >
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={kind === option.id}
              className={`timeline-filter-button ${kind === option.id ? 'active' : ''}`}
              onClick={() => setKind(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新团队时间线"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {error && (
        <div className="overview-load-error" role="alert">
          <div>
            <strong>{error}</strong>
            <p>
              {page
                ? moreFailed
                  ? '未能加载更早动态，已加载内容仍保留。'
                  : '刷新失败，当前显示上次读取的动态。'
                : '团队动态暂时不可用，请重试。'}
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={retry}
          >
            重试
          </button>
        </div>
      )}
      {!page && loading && (
        <output className="timeline-filter-empty">正在读取团队动态…</output>
      )}
      {page?.hasMore && (
        <button
          type="button"
          className="timeline-load-more"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? '加载中…' : '更早动态'}
        </button>
      )}
      {page?.items.map(renderItem)}
      {page && !page.items.length && (
        <div className="timeline-filter-empty">
          {kind === 'all'
            ? '还没有团队动态。完成一次任务后，进展会显示在这里。'
            : '当前筛选没有记录'}
        </div>
      )}
    </section>
  );
}
