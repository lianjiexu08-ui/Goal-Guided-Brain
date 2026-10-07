'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ArrowDownToLine, History } from 'lucide-react';
import type { Task } from './model';

const PAGE_SIZE = 30;

type Props = {
  tasks: Task[];
  endRef: RefObject<HTMLDivElement | null>;
  renderTask: (task: Task) => ReactNode;
  empty: ReactNode;
};

export function ConversationHistory({
  tasks,
  endRef,
  renderTask,
  empty,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const appliedScrollTop = useRef<number | null>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [expandedStart, setExpandedStart] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const start = expandedStart
    ? Math.max(
        0,
        tasks.findIndex((task) => task.id === expandedStart),
      )
    : Math.max(0, tasks.length - PAGE_SIZE);
  const visible = tasks.slice(start);
  const version = visible
    .map(
      (task) =>
        `${task.id}:${task.updatedAt || ''}:${task.status}:${task.result.length}`,
    )
    .join('|');

  const rememberAnchor = () => {
    const area = areaRef.current;
    if (!area) return;
    const top = area.getBoundingClientRect().top;
    const turn = [...area.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (node) => node.getBoundingClientRect().bottom > top,
    );
    anchor.current = turn
      ? {
          id: turn.dataset.turnId!,
          offset: turn.getBoundingClientRect().top - top,
        }
      : null;
  };

  const reconcile = () => {
    const area = areaRef.current;
    if (!area) return;
    if (followLatest.current) area.scrollTop = area.scrollHeight;
    else if (anchor.current) {
      const turn = [
        ...area.querySelectorAll<HTMLElement>('[data-turn-id]'),
      ].find((node) => node.dataset.turnId === anchor.current?.id);
      if (turn)
        area.scrollTop +=
          turn.getBoundingClientRect().top -
          area.getBoundingClientRect().top -
          anchor.current.offset;
    }
    appliedScrollTop.current = area.scrollTop;
    if (!anchor.current) rememberAnchor();
  };

  useLayoutEffect(reconcile, [version, expandedStart]);
  useEffect(() => {
    const area = areaRef.current;
    const content = contentRef.current;
    if (!area || !content) return;
    // Markdown images, composer growth and the mobile keyboard can resize the
    // viewport after React commits. Preserve the same turn and offset then too.
    const observer = new ResizeObserver(reconcile);
    observer.observe(area);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const area = areaRef.current;
    if (!area) return;
    if (
      appliedScrollTop.current !== null &&
      Math.abs(area.scrollTop - appliedScrollTop.current) < 1
    )
      return;
    appliedScrollTop.current = null;
    const nearLatest =
      area.scrollHeight - area.scrollTop - area.clientHeight <= 80;
    followLatest.current = nearLatest;
    setShowJump(!nearLatest);
    rememberAnchor();
    // Pin the oldest visible turn while reading so incoming tasks cannot slide
    // the recent-history window past the reader.
    if (!nearLatest && expandedStart === null && visible[0])
      setExpandedStart(visible[0].id);
  };

  const loadEarlier = () => {
    followLatest.current = false;
    rememberAnchor();
    setExpandedStart(tasks[Math.max(0, start - PAGE_SIZE)].id);
    setShowJump(true);
  };
  const jumpToLatest = () => {
    followLatest.current = true;
    setShowJump(false);
    setExpandedStart(null);
    reconcile();
  };

  return (
    <>
      <div
        className="message-area conversation-history"
        data-testid="message-area"
        ref={areaRef}
        onScroll={onScroll}
      >
        <div ref={contentRef}>
          {tasks.length > PAGE_SIZE && (
            <div className="conversation-history-controls">
              <span>
                已显示 {visible.length} / {tasks.length} 轮对话
              </span>
              {start > 0 ? (
                <button type="button" onClick={loadEarlier}>
                  <History size={15} />
                  加载更早对话
                  <span className="history-remaining">还有 {start} 轮</span>
                </button>
              ) : (
                <span>已到最早的对话</span>
              )}
            </div>
          )}
          {tasks.length ? visible.map(renderTask) : empty}
          <div ref={endRef} />
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest-button"
          aria-label="回到最新消息"
          onClick={jumpToLatest}
        >
          <ArrowDownToLine size={15} />
          回到最新
        </button>
      )}
    </>
  );
}
