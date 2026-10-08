'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';
import { useStructuredDraft } from '../drafts/use-structured-draft';
import { StructuredDraftStatus } from '../drafts/structured-draft-status';
import type { CollaborationReview } from './model';

type Decision = 'complete' | 'end' | 'reopen';
type Request = {
  draftRevision?: number;
  action: Decision;
  note: string;
  fingerprint: string;
  revision: number;
  requestId: string;
};
type Draft = { action: Decision; note: string; pending?: Request };
const empty: Draft = { action: 'complete', note: '' };
function validDraft(raw: unknown) {
  const value = raw as Draft | null;
  return (
    !!value &&
    ['complete', 'end', 'reopen'].includes(value.action) &&
    typeof value.note === 'string' &&
    value.note.length <= 2000 &&
    (!value.pending ||
      (typeof value.pending.requestId === 'string' &&
        typeof value.pending.note === 'string' &&
        typeof value.pending.fingerprint === 'string' &&
        Number.isSafeInteger(value.pending.revision)))
  );
}
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
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<{
    sequence: number;
    submitting: boolean;
    controller?: AbortController;
  }>({
    sequence: 0,
    submitting: false,
  });
  const key = `ggb.collaboration-review-draft.v1:${review.messageId}`;
  const endpoint = `teams/${encodeURIComponent(review.sourceTeamId)}/collaboration-review/${encodeURIComponent(review.messageId)}`;
  const draftStore = useStructuredDraft({
    endpoint: `teams/${encodeURIComponent(review.sourceTeamId)}/collaboration-draft?messageId=${encodeURIComponent(review.messageId)}`,
    legacyKey: key,
    empty,
    valid: validDraft,
    enabled: opened,
  });
  const { draft } = draftStore;
  const saveDraft = draftStore.update;
  useEffect(() => {
    const request = active.current;
    return () => {
      request.sequence++;
      request.controller?.abort();
    };
  }, []);
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
        if (draftStore.getCurrent().pending?.requestId === body.requestId)
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
    if (active.current.submitting) return;
    setOpened(true);
    const value = await request('GET');
    if (!value) return;
    setCurrent(value);
  }

  async function submit() {
    if (
      active.current.submitting ||
      active.current.controller ||
      !current ||
      draftStore.conflict
    )
      return;
    active.current.submitting = true;
    setSubmitting(true);
    try {
      const body = draft.pending || {
        action: current.status === 'open' ? draft.action : 'reopen',
        note: draft.note.trim(),
        fingerprint: current.fingerprint,
        revision: current.revision,
        requestId: crypto.randomUUID(),
      };
      setBusy(true);
      setError('');
      let saved;
      try {
        saved = await draftStore.commit({
          action: body.action,
          note: draft.note,
          pending: body,
        });
      } catch (reason) {
        setError((reason as Error).message);
        setBusy(false);
        return;
      }
      const value = await request('POST', {
        ...body,
        draftRevision: saved.revision,
      });
      if (!value) return;
      setCurrent(value);
      await draftStore.completed(body.requestId);
      setOpened(false);
      onChanged();
    } finally {
      active.current.submitting = false;
      setSubmitting(false);
    }
  }
  const working = busy || submitting;
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
      <button type="button" onClick={() => void load()} disabled={working}>
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
          aria-busy={working}
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
                    disabled={working || Boolean(draft.pending)}
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
                  disabled={working || Boolean(draft.pending)}
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
                  disabled={working || Boolean(draft.pending)}
                  onClick={() => void load()}
                >
                  刷新处理状态
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    working ||
                    !canSubmit ||
                    Boolean(draftStore.conflict) ||
                    !draftStore.ready
                  }
                  onClick={() => void submit()}
                >
                  {working
                    ? '处理中…'
                    : draft.pending
                      ? '重试确认处理结果'
                      : labels[selectedAction]}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={working || Boolean(draft.pending)}
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
                  disabled={working}
                  onClick={() => void load()}
                >
                  重新读取状态
                </button>
              )}
            </div>
          )}
          <StructuredDraftStatus
            store={draftStore}
            label="处理草稿"
            describe={(raw) => {
              const value = raw as Draft;
              return `处理方式：${labels[value.action]}\n处理说明：${value.note}`;
            }}
          />
        </section>
      )}
    </div>
  );
}
