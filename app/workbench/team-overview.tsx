'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, History, RefreshCw } from 'lucide-react';
import { api } from '../workbench-api';

type TeamOption = { id: string; name: string };
type TeamRisk = {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string;
  updatedAt: string;
  teamId: string;
  teamName: string;
  taskId?: string | null;
  knowledgeId?: string | null;
};
type TeamRiskResponse = { items: TeamRisk[]; hasMore: boolean; total: number };
type TimelineItem = {
  id: string;
  type:
    | 'message'
    | 'task'
    | 'task-event'
    | 'artifact'
    | 'verification'
    | 'acceptance'
    | 'attention';
  at: string;
  teamId?: string | null;
  teamName?: string | null;
  taskId?: string | null;
  content?: string;
  status?: string | null;
  error?: string | null;
  title?: string;
  result?: string;
  deliveryStatus?: string | null;
  acceptanceDecision?: string | null;
  acceptanceNote?: string | null;
  eventType?: string;
  data?: unknown;
  name?: string;
};
const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  state_unknown: '状态未知',
  blocked: '等待处理',
  paused: '已暂停',
  budget_exceeded: '预算超限',
  'budget-exceeded': '预算超限',
  accepted: '已交付',
  'awaiting-owner': '待你验收',
  rejected: '已退回复核',
  'pending-review': '待复核',
  verified: '已验收',
  expired: '已过期',
  'expires-soon': '即将过期',
  overdue: '已逾期',
};
const verificationLabels: Record<string, string> = {
  verified: '已验收',
  failed: '验证失败',
  'pending-review': '待验收',
  'needs-review': '需要复核',
  'awaiting-owner': '待你验收',
  accepted: '已交付',
  rejected: '已退回复核',
  stale: '验收已失效',
};
const formatTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function RiskInbox({
  teams,
  onOpenTeam,
  onOpenTask,
  onOpenKnowledge,
}: {
  teams: TeamOption[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenKnowledge?: (knowledgeId: string) => void;
}) {
  const [teamFilter, setTeamFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [items, setItems] = useState<TeamRisk[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const kindLabels: Record<string, string> = {
    execution: '执行风险',
    delivery: '交付风险',
    attention: '待确认事项',
    knowledge: '知识复核',
    plan: '计划逾期',
  };
  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<TeamRiskResponse>(`risks?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems(page.items || []);
      setTotal(page.total || 0);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.updatedAt}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
      setItems([]);
      setTotal(0);
      setHasMore(false);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [kindFilter, teamFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirstPage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage]);
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '50', before: nextCursor });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<TeamRiskResponse>(`risks?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems((current) => [...current, ...(page.items || [])]);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.updatedAt}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="risk-inbox" aria-label="跨团队风险">
      <div className="risk-inbox-head">
        <div>
          <span className="section-kicker">TEAM RISKS</span>
          <h2>跨团队风险</h2>
          <p>
            把失败执行、交付复核、计划逾期、知识复核和需要确认的事项放在一个入口。
          </p>
        </div>
        <div className="risk-inbox-summary">
          <span className="count-pill needs-review">{total} 项待处理</span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新跨团队风险"
            onClick={() => void loadFirstPage()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="risk-inbox-toolbar">
        <label>
          <span>团队</span>
          <select
            aria-label="风险团队"
            value={teamFilter}
            onChange={(event) => setTeamFilter(event.target.value)}
          >
            <option value="all">全部已创建团队</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select
            aria-label="风险类型"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="all">全部风险</option>
            <option value="execution">执行风险</option>
            <option value="delivery">交付风险</option>
            <option value="attention">待确认事项</option>
            <option value="knowledge">知识复核</option>
            <option value="plan">计划逾期</option>
          </select>
        </label>
      </div>
      {error && <div className="risk-inbox-error">{error}</div>}
      {items.length > 0 ? (
        <div className="risk-inbox-list">
          {items.map((item) => (
            <button
              type="button"
              className="risk-inbox-item"
              key={item.id}
              aria-label={`打开风险 ${item.title}`}
              onClick={() =>
                item.knowledgeId && onOpenKnowledge
                  ? onOpenKnowledge(item.knowledgeId)
                  : item.taskId
                    ? onOpenTask(item.taskId)
                    : onOpenTeam(item.teamId)
              }
            >
              <span className={`risk-inbox-icon ${item.kind}`}>
                <AlertTriangle size={15} />
              </span>
              <span className="risk-inbox-copy">
                <strong>{item.title}</strong>
                <small>
                  {item.teamName} · {kindLabels[item.kind] || item.kind} ·{' '}
                  {item.detail}
                </small>
              </span>
              <em>
                {statusLabels[item.status] ||
                  verificationLabels[item.status] ||
                  item.status}
              </em>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              className="risk-inbox-more"
              onClick={() => void loadMore()}
              disabled={loading}
            >
              {loading ? '加载中…' : '加载更早风险'}
            </button>
          )}
        </div>
      ) : (
        <div className="risk-inbox-empty">
          <Check size={20} />
          <span>
            {loading ? '正在检查团队风险…' : '当前没有需要处理的跨团队风险。'}
          </span>
        </div>
      )}
    </section>
  );
}

export function CrossTeamTimeline({
  teams,
  onOpenTeam,
  onOpenTask,
}: {
  teams: TeamOption[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [teamFilter, setTeamFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const kindLabels: Record<string, string> = {
    all: '全部动态',
    messages: '消息',
    execution: '执行',
    evidence: '证据',
    risk: '风险',
  };
  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '60' });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<{ items: TimelineItem[]; hasMore: boolean }>(
        `timeline?${query.toString()}`,
      );
      const last = page.items?.[page.items.length - 1];
      setItems(page.items || []);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.at}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
      setItems([]);
      setHasMore(false);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [kindFilter, teamFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirstPage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage]);
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '60', before: nextCursor });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<{ items: TimelineItem[]; hasMore: boolean }>(
        `timeline?${query.toString()}`,
      );
      const last = page.items?.[page.items.length - 1];
      setItems((current) => {
        const merged = new Map(
          [...page.items, ...current].map((item) => [item.id, item]),
        );
        return [...merged.values()].sort(
          (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id),
        );
      });
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.at}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const renderItem = (item: TimelineItem) => {
    const title =
      item.type === 'message'
        ? '团队消息'
        : item.type === 'task'
          ? item.title || '后台任务'
          : item.type === 'task-event'
            ? `执行事件 · ${item.eventType || 'event'}`
            : item.type === 'acceptance'
              ? item.acceptanceDecision === 'accepted'
                ? '所有者通过交付'
                : '所有者退回复核'
              : item.type === 'verification'
                ? `验收证据 · ${item.name || '未命名验证'}`
                : `产物 · ${item.name || '未命名产物'}`;
    const detail =
      item.type === 'message'
        ? item.content || '团队消息'
        : item.type === 'task'
          ? item.error ||
            item.result ||
            statusLabels[item.deliveryStatus || item.status || ''] ||
            item.status ||
            '任务状态已更新'
          : item.type === 'acceptance'
            ? item.acceptanceNote || '所有者已记录交付决定'
            : item.type === 'task-event'
              ? item.data &&
                typeof item.data === 'object' &&
                'reason' in item.data
                ? String(item.data.reason)
                : '执行事件已记录'
              : item.status
                ? `状态：${statusLabels[item.status] || item.status}`
                : '已记录到团队交付证据';
    const open = () =>
      item.taskId
        ? onOpenTask(item.taskId)
        : item.teamId
          ? onOpenTeam(item.teamId)
          : undefined;
    return (
      <button
        type="button"
        className="cross-team-timeline-item"
        key={item.id}
        aria-label={`打开团队动态 ${item.teamName || '团队'} ${title}`}
        onClick={open}
        disabled={!item.teamId}
      >
        <span className="cross-team-timeline-team">
          {item.teamName || '团队'} · {kindLabels[kindFilter] || '团队动态'}
        </span>
        <span className="cross-team-timeline-copy">
          <strong>{title}</strong>
          <small>
            {detail.replace(/\s+/g, ' ').slice(0, 220)} · {formatTime(item.at)}
          </small>
        </span>
      </button>
    );
  };
  return (
    <section className="cross-team-timeline" aria-label="跨团队统一时间线">
      <div className="cross-team-timeline-head">
        <div>
          <span className="section-kicker">ALL TEAMS</span>
          <h2>全部团队动态</h2>
          <p>在一个时间线上查看各团队的消息、执行和交付证据。</p>
        </div>
        <div className="cross-team-timeline-summary">
          <span className="count-pill">{teams.length} 个团队</span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新跨团队时间线"
            onClick={() => void loadFirstPage()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="cross-team-timeline-toolbar">
        <label>
          <span>团队</span>
          <select
            aria-label="统一时间线团队"
            value={teamFilter}
            onChange={(event) => setTeamFilter(event.target.value)}
          >
            <option value="all">全部已创建团队</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select
            aria-label="统一时间线类型"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="cross-team-timeline-error">{error}</div>}
      {items.length > 0 ? (
        <div className="cross-team-timeline-list">
          {items.map(renderItem)}
          {hasMore && (
            <button
              type="button"
              className="timeline-load-more cross-team-timeline-more"
              onClick={() => void loadMore()}
              disabled={loading}
            >
              {loading ? '加载中…' : '加载更早动态'}
            </button>
          )}
        </div>
      ) : (
        <div className="cross-team-timeline-empty">
          <History size={18} />
          <span>
            {loading ? '正在加载团队动态…' : '当前筛选没有团队动态。'}
          </span>
        </div>
      )}
    </section>
  );
}
