'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';
import type { CollaborationReview } from './model';

type Decision = 'complete' | 'end' | 'reopen';
type Request = {
  action: Decision;
  note: string;
  fingerprint: string;
  revision: number;
  requestId: string;
};
type Draft = { action: Decision; note: string; pending?: Request };
const labels: Record<string, string> = {
  complete: '确认完成',
  end: '结束跟进',
  reopen: '重新打开',
};

export function CollaborationReviewControl({
  review,
  onOpenTask,
  onChanged,
}: {
  review: CollaborationReview;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [current, setCurrent] = useState<CollaborationReview | null>(null);
  const [draft, setDraft] = useState<Draft>({ action: 'complete', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const active = useRef<{ sequence: number; controller?: AbortController }>({
    sequence: 0,
  });
  const key = `ggb.collaboration-review-draft.v1:${review.messageId}`;
  const endpoint = `teams/${encodeURIComponent(review.sourceTeamId)}/collaboration-review/${encodeURIComponent(review.messageId)}`;
  useEffect(() => {
    const request = active.current;
    return () => {
      request.sequence++;
      request.controller?.abort();
    };
  }, []);
  function saveDraft(next: Draft) {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError('');
    } catch {
      setStorageError('处理草稿未能保存到本机，请保持当前页面。');
    }
  }
  async function request(method: string, body?: Request) {
    const sequence = ++active.current.sequence;
    active.current.controller?.abort();
    const controller = new AbortController();
    active.current.controller = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setError('');
    try {
      const value = await api<CollaborationReview>(
        endpoint,
        method,
        body,
        controller.signal,
      );
      if (sequence !== active.current.sequence) return null;
      if (
        value?.messageId !== review.messageId ||
        !Number.isInteger(value.revision) ||
        !['open', 'closed', 'stale'].includes(value.status) ||
        typeof value.canComplete !== 'boolean' ||
        typeof value.canEnd !== 'boolean' ||
        !value.fingerprint
      )
        throw new Error('协作处理回执不完整，请重试确认。');
      return value;
    } catch (reason) {
      if (sequence !== active.current.sequence) return null;
      setError(
        controller.signal.aborted
          ? '请求超时，请重试确认。'
          : (reason as Error).message,
      );
      const status = (reason as Error & { status?: number }).status;
      if (body && status && status >= 400 && status < 500)
        saveDraft({ action: body.action, note: body.note });
      return null;
    } finally {
      window.clearTimeout(timeout);
      if (sequence === active.current.sequence) {
        setBusy(false);
        active.current.controller = undefined;
      }
    }
  }
  async function load() {
    setOpened(true);
    const value = await request('GET');
    if (!value) return;
    setCurrent(value);
    try {
      const saved = JSON.parse(
        localStorage.getItem(key) || 'null',
      ) as Draft | null;
      if (saved && labels[saved.action] && typeof saved.note === 'string')
        setDraft({
          ...saved,
          action:
            value.status === 'open' &&
            saved.action === 'reopen' &&
            !saved.pending
              ? 'complete'
              : saved.action,
        });
      else
        setDraft({
          action: value.status === 'open' ? 'complete' : 'reopen',
          note: '',
        });
    } catch {
      setStorageError('本机处理草稿无法读取，请保持当前页面。');
    }
  }
  async function submit() {
    if (active.current.controller || !current) return;
    const body = draft.pending || {
      action: current.status === 'open' ? draft.action : 'reopen',
      note: draft.note.trim(),
      fingerprint: current.fingerprint,
      revision: current.revision,
      requestId: crypto.randomUUID(),
    };
    saveDraft({ ...draft, pending: body });
    const value = await request('POST', body);
    if (!value) return;
    setCurrent(value);
    setDraft({
      action: value.status === 'open' ? 'complete' : 'reopen',
      note: '',
    });
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved?.pending?.requestId === body.requestId)
        localStorage.removeItem(key);
    } catch {
      /* The persisted request can safely be confirmed again. */
    }
    setOpened(false);
    onChanged();
  }
  const selectedAction = current?.status === 'open' ? draft.action : 'reopen';
  const canSubmit =
    draft.pending ||
    (current &&
      (selectedAction === 'complete'
        ? current.canComplete
        : draft.note.trim() &&
          (selectedAction === 'reopen' || current.canEnd)));
  return (
    <div className="collaboration-review-control">
      <button
        type="button"
        onClick={() => void load()}
        disabled={busy || Boolean(draft.pending)}
      >
        {review.status === 'closed'
          ? '查看收尾记录'
          : review.status === 'stale'
            ? '重新复核协作'
            : '处理协作'}
      </button>
      {opened && (
        <section
          className="collaboration-review-panel"
          aria-label="协作收尾处理"
          aria-busy={busy}
        >
          <strong>
            {current?.status === 'open' ? '处理这次协作' : '协作收尾记录'}
          </strong>
          <p>
            只处理本次请求，关联的后续任务保持独立。结束跟进不会把交付标记为验收通过。
          </p>
          {current?.status === 'stale' && (
            <output>结果或验收证据已有变化，原收尾结论需要重新复核。</output>
          )}
          {current && (
            <>
              {current.status !== 'open' && (
                <p>
                  {labels[current.action || 'end']}：
                  {current.note || '当前交付已验收。'}
                </p>
              )}
              {current.status === 'open' ? (
                <label>
                  处理方式
                  <select
                    aria-label="协作处理方式"
                    value={draft.action}
                    disabled={busy || Boolean(draft.pending)}
                    onChange={(event) =>
                      saveDraft({
                        action: event.target.value as Decision,
                        note: draft.note,
                      })
                    }
                  >
                    {draft.pending?.action === 'reopen' && (
                      <option value="reopen">重新打开（待确认）</option>
                    )}
                    <option value="complete">确认完成（需交付验收通过）</option>
                    <option value="end">结束跟进并记录原因</option>
                  </select>
                </label>
              ) : (
                <p>重新打开后可以继续追问；不会自动执行任务。</p>
              )}
              <label>
                处理说明
                {selectedAction !== 'complete' ? '（必填）' : '（可选）'}
                <textarea
                  aria-label="协作处理说明"
                  rows={3}
                  maxLength={2000}
                  value={draft.note}
                  disabled={busy || Boolean(draft.pending)}
                  onChange={(event) =>
                    saveDraft({
                      action: draft.action,
                      note: event.target.value,
                    })
                  }
                />
              </label>
              {current.status === 'open' && !current.canComplete && (
                <button
                  type="button"
                  onClick={() => onOpenTask(current.taskId)}
                >
                  查看任务并复核交付
                </button>
              )}
              {current.status === 'open' && !current.canEnd && (
                <p>原任务仍在执行或状态未确认，请先处理原任务。</p>
              )}
              {draft.pending && (
                <output>
                  尚未确认处理结果。重试使用同一请求，不会重复记录决定。
                </output>
              )}
              <div className="collaboration-review-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || Boolean(draft.pending)}
                  onClick={() => void load()}
                >
                  刷新处理状态
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !canSubmit}
                  onClick={() => void submit()}
                >
                  {busy
                    ? '处理中…'
                    : draft.pending
                      ? '重试确认处理结果'
                      : labels[selectedAction]}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || Boolean(draft.pending)}
                  onClick={() => setOpened(false)}
                >
                  收起
                </button>
              </div>
              {!!current.history?.length && (
                <details>
                  <summary>最近处理记录（{current.history.length}）</summary>
                  <ol>
                    {current.history.map((item) => (
                      <li key={item.requestId}>
                        <strong>{labels[item.action]}</strong> ·{' '}
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                        <p>{item.note || '交付已验收。'}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
          {error && (
            <div role="alert">
              <p>{error}</p>
              {!draft.pending && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  重新读取状态
                </button>
              )}
            </div>
          )}
          {storageError && <output>{storageError}</output>}
        </section>
      )}
    </div>
  );
}
