'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';

type Item = {
  messageId: string;
  index: number;
  parentIndex: number | null;
  createdAt: string;
  content: string;
  reply: { content: string; createdAt: string } | null;
  task: { id: string; status: string; deliveryStatus: string };
  review: { status: string; action: string | null; note: string };
};
type Chain = {
  rootMessageId: string;
  selectedMessageId: string;
  selectedIndex: number;
  sourceTeamId: string;
  targetTeamId: string;
  sourceTeamName: string;
  targetTeamName: string;
  incomplete: boolean;
  revision: string;
  counts: {
    total: number;
    active: number;
    accepted: number;
    open: number;
    closed: number;
    stale: number;
  };
  items: Item[];
  nextCursor: string | null;
};
const labels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  completed: '执行完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  state_unknown: '状态待确认',
  blocked: '等待处理',
  paused: '已暂停',
  accepted: '已验收',
  rejected: '已退回',
  'awaiting-owner': '待你验收',
  'pending-review': '待复核',
  stale: '证据已变化',
};
const time = (value: string) => new Date(value).toLocaleString('zh-CN');

export function CollaborationChain({
  teamId,
  messageId,
  onClose,
  onOpenTask,
}: {
  teamId: string;
  messageId: string;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [chain, setChain] = useState<Chain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [moreFailed, setMoreFailed] = useState(false);
  const accepted = useRef<Chain | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  const errorRef = useRef(false);
  const load = useCallback(
    async (more = false, background = false) => {
      if (background && (active.current.controller || errorRef.current)) return;
      const previous = accepted.current;
      if (more && !previous?.nextCursor) return;
      active.current.controller?.abort();
      const controller = new AbortController();
      const sequence = ++active.current.sequence;
      active.current.controller = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      setLoading(true);
      setError('');
      setMoreFailed(false);
      const current = () => active.current.sequence === sequence;
      const read = async (after: string | null) => {
        const query = new URLSearchParams({ limit: '20' });
        if (after) query.set('after', after);
        const result = await api<Chain>(
          `teams/${encodeURIComponent(teamId)}/collaboration-chain/${encodeURIComponent(messageId)}?${query}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (
          !result ||
          !result.rootMessageId ||
          !result.revision ||
          !Array.isArray(result.items) ||
          !Number.isSafeInteger(result.counts?.total) ||
          !Number.isSafeInteger(result.selectedIndex) ||
          result.selectedIndex < 1 ||
          result.selectedIndex > result.counts.total ||
          (result.nextCursor !== null &&
            typeof result.nextCursor !== 'string') ||
          result.items.some(
            (item) =>
              !item?.messageId ||
              !item.task?.id ||
              !item.review ||
              typeof item.content !== 'string',
          )
        )
          throw new Error('协作链路返回不完整，请重试。');
        return result;
      };
      try {
        let page = await read(more ? previous!.nextCursor : null);
        if (!current()) return;
        if (more && page.revision !== previous?.revision)
          throw new Error('协作链路已变化，请刷新链路后继续。');
        const desired = Math.max(
          previous?.items.length || 20,
          page.selectedIndex,
        );
        let items = more
          ? [...previous!.items, ...page.items]
          : [...page.items];
        const revision = page.revision;
        const cursors = new Set<string>();
        // Refresh all expanded pages so edited/deleted old requests are not retained.
        while (!more && items.length < desired && page.nextCursor) {
          if (cursors.has(page.nextCursor))
            throw new Error('链路游标未前进，请重试。');
          cursors.add(page.nextCursor);
          page = await read(page.nextCursor);
          if (!current()) return;
          if (page.revision !== revision)
            throw new Error('协作链路已变化，请重新刷新。');
          items = [...items, ...page.items];
        }
        const next = { ...page, items };
        accepted.current = next;
        errorRef.current = false;
        setChain(next);
      } catch (reason) {
        if (!current()) return;
        errorRef.current = true;
        setMoreFailed(more);
        setError(
          controller.signal.aborted
            ? '协作链路读取超时，请重试。'
            : (reason as Error).message,
        );
      } finally {
        window.clearTimeout(timeout);
        if (current()) {
          active.current.controller = null;
          setLoading(false);
        }
      }
    },
    [teamId, messageId],
  );
  useEffect(() => {
    const request = active.current;
    const timer = window.setTimeout(() => {
      heading.current?.focus();
      void load();
    }, 0);
    const polling = window.setInterval(() => void load(false, true), 5000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(polling);
      request.sequence++;
      request.controller?.abort();
    };
  }, [load]);
  return (
    <section className="collaboration-chain" aria-label="协作链路">
      <header>
        <div>
          <span className="section-kicker">COLLABORATION THREAD</span>
          <h3 tabIndex={-1} ref={heading}>
            协作链路
          </h3>
        </div>
        <div className="collaboration-chain-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
          >
            刷新链路
          </button>
          {chain && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const selected = heading.current
                  ?.closest('section')
                  ?.querySelector<HTMLElement>('li[aria-current="step"]');
                selected?.focus();
                selected?.scrollIntoView({ block: 'center' });
              }}
            >
              定位当前请求
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onClose}>
            收起链路
          </button>
        </div>
      </header>
      <p>
        展示同一来源与目标团队的原请求和后续追问，分支标明引用来源。执行、验收和结束跟进分别记录。
      </p>
      {chain && (
        <>
          <p>
            {chain.sourceTeamName} → {chain.targetTeamName}
          </p>
          <div className="collaboration-chain-counts" aria-label="整条链路状态">
            <span>
              <b>{chain.counts.total}</b> 次请求
            </span>
            <span>
              <b>{chain.counts.active}</b> 待执行结束
            </span>
            <span>
              <b>{chain.counts.accepted}</b> 已验收
            </span>
            <span>
              <b>{chain.counts.open}</b> 跟进中
            </span>
            <span>
              <b>{chain.counts.closed}</b> 已收尾
            </span>
            <span>
              <b>{chain.counts.stale}</b> 需重新复核
            </span>
          </div>
          {chain.incomplete && (
            <output>
              原始引用缺失或不属于此协作范围，以下仅展示可确认的关联记录。
            </output>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="overview-load-error">
          <span>
            {error}
            {chain ? ' 已保留上次读取的记录。' : ''}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void load(moreFailed)}
          >
            重试读取链路
          </button>
        </div>
      )}
      {!chain && loading && <output>正在读取协作链路…</output>}
      {chain && (
        <ol className="collaboration-chain-list">
          {chain.items.map((item) => (
            <li
              key={item.messageId}
              data-message-id={item.messageId}
              tabIndex={-1}
              aria-current={
                item.messageId === chain.selectedMessageId ? 'step' : undefined
              }
            >
              <div className="collaboration-chain-item-head">
                <strong>
                  #{item.index}{' '}
                  {item.parentIndex
                    ? `接续 #${item.parentIndex}`
                    : chain.incomplete
                      ? '最早可确认请求'
                      : '原始请求'}
                </strong>
                {item.messageId === chain.selectedMessageId && (
                  <span>当前选中</span>
                )}
                <time dateTime={item.createdAt}>{time(item.createdAt)}</time>
              </div>
              <div className="collaboration-chain-status">
                <span>
                  执行：{labels[item.task.status] || item.task.status}
                </span>
                <span>
                  交付：
                  {labels[item.task.deliveryStatus] || item.task.deliveryStatus}
                </span>
                <span>
                  跟进：
                  {item.review.status === 'closed'
                    ? item.review.action === 'complete'
                      ? '已确认完成'
                      : '已结束（不代表验收通过）'
                    : item.review.status === 'stale'
                      ? '需重新复核'
                      : '跟进中'}
                </span>
              </div>
              <details>
                <summary>
                  查看请求 #{item.index}
                  <span>{item.content.split('\n')[0]}</span>
                </summary>
                <div>{item.content}</div>
              </details>
              {item.reply ? (
                <details>
                  <summary>查看回传 #{item.index}</summary>
                  <div>{item.reply.content}</div>
                </details>
              ) : (
                <small>尚无共享回传，可进入任务查看执行情况。</small>
              )}
              {item.review.note && (
                <details>
                  <summary>查看处理说明 #{item.index}</summary>
                  <div>{item.review.note}</div>
                </details>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => onOpenTask(item.task.id)}
              >
                查看第 {item.index} 次任务
              </button>
            </li>
          ))}
        </ol>
      )}
      {chain?.nextCursor && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading || moreFailed}
          onClick={() => void load(true)}
        >
          {loading ? '正在读取…' : '加载后续请求'}
        </button>
      )}
    </section>
  );
}
