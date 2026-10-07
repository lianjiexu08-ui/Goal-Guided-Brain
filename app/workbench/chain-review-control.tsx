'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../workbench-api';
import { useStructuredDraft } from '../drafts/use-structured-draft';
import { StructuredDraftStatus } from '../drafts/structured-draft-status';

type Action = 'complete' | 'end' | 'reopen';
type Decision = {
  action: Action;
  note: string;
  fingerprint: string;
  requestId: string;
};
type Draft = { action: Action; note: string; pending?: Decision };
type Preview = {
  messageId: string;
  fingerprint: string;
  rootCount: number;
  teamCount: number;
  items: {
    messageId: string;
    taskId: string;
    index: number;
    content: string;
    sourceTeamName: string;
    targetTeamName: string;
    decisions: Record<Action, { affected: boolean; reason: string }>;
  }[];
  options: Record<
    Action,
    { allowed: boolean; affected: number; reason: string }
  >;
};
const labels = {
  complete: '确认整条链路完成',
  end: '结束整条链路跟进',
  reopen: '重新打开整条链路',
};
const empty: Draft = { action: 'complete', note: '' };
const valid = (raw: unknown) => {
  const value = raw as Draft | null;
  return (
    !!value &&
    Object.hasOwn(labels, value.action) &&
    typeof value.note === 'string' &&
    value.note.length <= 2000 &&
    (!value.pending ||
      (value.pending.action === value.action &&
        value.pending.note === value.note.trim() &&
        typeof value.pending.requestId === 'string' &&
        typeof value.pending.fingerprint === 'string'))
  );
};
export function ChainReviewControl({
  teamId,
  messageId,
  onChanged,
  onOpenTask,
}: {
  teamId: string;
  messageId: string;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewed, setReviewed] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = useRef<{
    mounted: boolean;
    busy: boolean;
    controller?: AbortController;
  }>({ mounted: false, busy: false });
  const endpoint = `teams/${encodeURIComponent(teamId)}/collaboration-chain-review/${encodeURIComponent(messageId)}`;
  const store = useStructuredDraft({
    endpoint: `${endpoint}/draft`,
    legacyKey: `ggb.chain-review.v1:${teamId}:${messageId}`,
    empty,
    valid,
    enabled: opened,
  });
  const { draft } = store;
  const reviewKey = JSON.stringify([
    preview?.fingerprint,
    draft.action,
    draft.note,
  ]);
  useEffect(() => {
    const state = active.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.controller?.abort();
    };
  }, []);
  async function fetchWithTimeout<T>(method: string, body?: unknown) {
    const controller = new AbortController();
    active.current.controller = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      return await api<T>(endpoint, method, body, controller.signal);
    } finally {
      window.clearTimeout(timer);
      active.current.controller = undefined;
    }
  }
  async function load() {
    if (active.current.busy) return;
    active.current.busy = true;
    setBusy(true);
    setOpened(true);
    setError('');
    setReviewed('');
    try {
      const result = await fetchWithTimeout<Preview>('GET');
      if (!active.current.mounted) return;
      if (
        !result ||
        !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
        !Number.isSafeInteger(result.rootCount) ||
        result.rootCount < 1 ||
        !Number.isSafeInteger(result.teamCount) ||
        result.teamCount < 1 ||
        !Array.isArray(result.items) ||
        !result.items.length ||
        !result.options ||
        Object.keys(labels).some((action) => {
          const option = result.options[action as Action];
          return (
            !option ||
            typeof option.allowed !== 'boolean' ||
            !Number.isSafeInteger(option.affected) ||
            option.affected < 0 ||
            typeof option.reason !== 'string'
          );
        }) ||
        result.items.some(
          (item) =>
            !item?.messageId ||
            !item.taskId ||
            typeof item.content !== 'string' ||
            typeof item.sourceTeamName !== 'string' ||
            typeof item.targetTeamName !== 'string' ||
            !item.decisions ||
            Object.keys(labels).some((action) => {
              const decision = item.decisions[action as Action];
              return (
                !decision ||
                typeof decision.affected !== 'boolean' ||
                typeof decision.reason !== 'string'
              );
            }),
        )
      )
        throw new Error('链路预览不完整，请重新读取。');
      setPreview(result);
      window.setTimeout(() => heading.current?.focus(), 0);
    } catch (reason) {
      if (active.current.mounted) {
        setPreview(null);
        setError(
          (reason as Error).name === 'AbortError'
            ? '预览读取超时，请重试。'
            : (reason as Error).message,
        );
      }
    } finally {
      active.current.busy = false;
      if (active.current.mounted) setBusy(false);
    }
  }
  async function submit() {
    if (
      active.current.busy ||
      store.conflict ||
      !store.ready ||
      (!draft.pending && (!preview || reviewed !== reviewKey))
    )
      return;
    const decision = draft.pending || {
      action: draft.action,
      note: draft.note.trim(),
      fingerprint: preview!.fingerprint,
      requestId: crypto.randomUUID(),
    };
    active.current.busy = true;
    setBusy(true);
    setError('');
    setNotice('');
    let submitted = false;
    try {
      const saved = await store.commit({
        action: decision.action,
        note: draft.note,
        pending: decision,
      });
      if (!active.current.mounted) return;
      submitted = true;
      const receipt = await fetchWithTimeout<
        Decision & { messageIds: string[] }
      >('POST', { ...decision, draftRevision: saved.revision });
      if (!active.current.mounted) return;
      if (
        ['action', 'note', 'fingerprint', 'requestId'].some(
          (key) =>
            receipt?.[key as keyof Decision] !==
            decision[key as keyof Decision],
        ) ||
        !Array.isArray(receipt.messageIds) ||
        !receipt.messageIds.length ||
        receipt.messageIds.some((id) => typeof id !== 'string')
      )
        throw new Error('处理回执不完整，请重试确认结果。');
      await store.completed(decision.requestId);
      if (!active.current.mounted) return;
      setNotice(
        `已记录本次决定，处理 ${receipt.messageIds.length} 次请求。当前状态以刷新后的链路为准。`,
      );
      setOpened(false);
      setPreview(null);
      setReviewed('');
      trigger.current?.focus();
      onChanged();
    } catch (reason) {
      if (!active.current.mounted) return;
      const status = (reason as Error & { status?: number }).status;
      if (
        submitted &&
        status &&
        status >= 400 &&
        status < 500 &&
        store.getCurrent().pending?.requestId === decision.requestId
      ) {
        store.update({ action: decision.action, note: draft.note });
        setPreview(null);
        setReviewed('');
      }
      setError(
        (reason as Error).name === 'AbortError'
          ? '处理超时，请重试确认结果。'
          : (reason as Error).message,
      );
    } finally {
      active.current.busy = false;
      if (active.current.mounted) setBusy(false);
    }
  }
  const option = preview?.options[draft.action];
  return (
    <div className="chain-review-control">
      <button
        ref={trigger}
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void load()}
      >
        整条链路收尾
      </button>
      {notice && <output>{notice}</output>}
      {opened && (
        <section
          className="collaboration-review-panel chain-review-panel"
          aria-label="整条链路收尾预览"
          aria-busy={busy}
        >
          <h4 ref={heading} tabIndex={-1}>
            核对整条链路的处理范围
          </h4>
          <p>
            确认完成要求当前交付全部验收通过；结束跟进保留原验收结果。重新打开只恢复跟进，不会启动或停止任务。
          </p>
          {preview && (
            <p>
              包含 {preview.rootCount} 个起始请求、{preview.teamCount} 个团队、
              {preview.items.length} 次请求（含尚未展开的历史）。
            </p>
          )}
          <label>
            链路处理方式
            <select
              aria-label="链路处理方式"
              value={draft.action}
              disabled={busy || !!draft.pending}
              onChange={(event) => {
                store.update({
                  action: event.target.value as Action,
                  note: draft.note,
                });
                setReviewed('');
              }}
            >
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            链路处理说明{draft.action === 'complete' ? '（可选）' : '（必填）'}
            <textarea
              aria-label="链路处理说明"
              rows={3}
              maxLength={2000}
              value={draft.note}
              disabled={busy || !!draft.pending}
              onChange={(event) => {
                store.update({
                  action: draft.action,
                  note: event.target.value,
                });
                setReviewed('');
              }}
            />
          </label>
          {draft.pending ? (
            <output>
              尚未确认上次已审阅范围的处理结果。重试使用同一请求，不会把后续新增协作纳入。下方列表为最近读取的状态。
            </output>
          ) : (
            option && (
              <p>
                {option.affected} 次请求将更新，其余保留当前决定。
                {option.reason}
              </p>
            )
          )}
          {preview && (
            <ul className="chain-review-items" aria-label="全部处理范围">
              {preview.items.map((item) => (
                <li key={item.messageId}>
                  <strong>
                    #{item.index} {item.sourceTeamName} → {item.targetTeamName}
                  </strong>
                  <details>
                    <summary>查看范围内请求 #{item.index}</summary>
                    <p>{item.content}</p>
                  </details>
                  <span>
                    {item.decisions[draft.action].affected
                      ? item.decisions[draft.action].reason || '将更新处理决定'
                      : '保留当前决定'}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onOpenTask(item.taskId)}
                  >
                    查看范围内任务 #{item.index}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!draft.pending && (
            <label className="chain-review-confirm">
              <input
                type="checkbox"
                checked={reviewed === reviewKey}
                disabled={!preview || busy}
                onChange={(event) =>
                  setReviewed(event.target.checked ? reviewKey : '')
                }
              />
              我已核对以上全部范围及处理方式
            </label>
          )}
          {error && <div role="alert">{error}</div>}
          <div className="collaboration-review-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void load()}
            >
              重新预览链路
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !store.ready ||
                !!store.conflict ||
                (!draft.pending &&
                  (reviewed !== reviewKey ||
                    !option?.allowed ||
                    (draft.action !== 'complete' && !draft.note.trim())))
              }
              onClick={() => void submit()}
            >
              {busy
                ? '处理中…'
                : draft.pending
                  ? '重试确认链路结果'
                  : labels[draft.action]}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setOpened(false);
                trigger.current?.focus();
              }}
            >
              收起预览
            </button>
          </div>
          <StructuredDraftStatus
            store={store}
            label="链路处理草稿"
            describe={(raw) => {
              const value = raw as Draft;
              return `处理方式：${labels[value.action]}\n说明：${value.note}`;
            }}
          />
        </section>
      )}
    </div>
  );
}
