'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ArrowUpRight } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Task } from './model';

const PAGE_SIZE = 20;

// Search plain text and render it as React text: model output is never HTML.
function excerpt(text: string, query: string) {
  const compact = text.replace(/\s+/g, ' ');
  const index = compact.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, index - 36);
  const end = Math.min(
    compact.length,
    Math.max(140, index + query.length + 70),
  );
  return `${start ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Task[];
  onSelect: (taskId: string) => void;
  getTargetElement: () => HTMLElement | null;
};

export function ConversationSearch({
  open,
  onOpenChange,
  tasks,
  onSelect,
  getTargetElement,
}: Props) {
  // A scope/view change also releases the workbench's mobile back entry.
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = useRef(false);
  const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!open || !needle) return [];
    return tasks
      .flatMap((task) => {
        const fields = [
          { label: '你的需求', text: task.prompt },
          { label: '助手回复', text: task.result },
          { label: '对话标题', text: task.title },
        ];
        const match = fields.find((field) =>
          field.text.replace(/\s+/g, ' ').toLocaleLowerCase().includes(needle),
        );
        return match
          ? [{ task, label: match.label, snippet: excerpt(match.text, needle) }]
          : [];
      })
      .reverse();
  }, [tasks, needle, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button conversation-search-trigger"
        aria-label="搜索当前对话"
        title="搜索当前对话"
        disabled={!tasks.length}
        onClick={() => {
          selected.current = false;
          onOpenChange(true);
        }}
      >
        <Search size={18} />
      </button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="conversation-search-dialog"
          showCloseButton={false}
          initialFocus={inputRef}
          finalFocus={() => {
            if (!selected.current) return triggerRef.current;
            const target = getTargetElement();
            if (!target) return triggerRef.current;
            // Base UI otherwise focuses the first tabbable action inside the
            // article. Restore the original message itself for screen readers.
            queueMicrotask(() => target.focus({ preventScroll: true }));
            return false;
          }}
        >
          <div className="conversation-search-heading">
            <DialogTitle>搜索当前对话</DialogTitle>
            <DialogClose className="icon-button" aria-label="关闭对话搜索">
              <X size={18} />
            </DialogClose>
          </div>
          <DialogDescription>
            查找当前对话的需求与回复，包含尚未展开的历史。点击结果回到原文。
          </DialogDescription>
          <div className="conversation-search-input">
            <Search size={18} aria-hidden="true" />
            <input
              ref={inputRef}
              aria-label="对话搜索关键词"
              placeholder="输入关键词…"
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="清空对话搜索"
                onClick={() => {
                  setQuery('');
                  setLimit(PAGE_SIZE);
                  inputRef.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <output className="conversation-search-count">
            {needle
              ? `找到 ${matches.length} 轮对话 · 最近的在前`
              : `当前共 ${tasks.length} 轮对话`}
          </output>
          <div className="conversation-search-results">
            {!needle ? (
              <p className="conversation-search-empty">
                从一个需求、决定或交付关键词开始查找。
              </p>
            ) : !matches.length ? (
              <p className="conversation-search-empty">
                没有找到匹配的对话，试试其他关键词。
              </p>
            ) : (
              <ul>
                {matches.slice(0, limit).map(({ task, label, snippet }) => (
                  <li key={task.id}>
                    <button
                      className="conversation-search-result"
                      onClick={() => {
                        selected.current = true;
                        onSelect(task.id);
                        onOpenChange(false);
                      }}
                    >
                      <span className="conversation-search-meta">
                        <span>{label}</span>
                        <time dateTime={task.createdAt}>
                          {new Date(task.createdAt).toLocaleString('zh-CN', {
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                        <ArrowUpRight size={15} />
                      </span>
                      <strong>{task.title || '未命名对话'}</strong>
                      <span className="conversation-search-snippet">
                        <Highlight text={snippet} query={needle} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {matches.length > limit && (
              <button
                className="secondary-button conversation-search-more"
                onClick={() => setLimit((value) => value + PAGE_SIZE)}
              >
                显示更多结果（还有 {matches.length - limit} 轮）
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
