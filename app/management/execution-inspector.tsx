'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  FileText,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Play,
  Save,
  Terminal,
  Undo2,
} from 'lucide-react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
} from '../workbench-api';
import { Badge, Empty, ErrorMessage, status, time, title } from './shared';

export function ExecutionInspector({ taskId }: { taskId: string }) {
  const [execution, setExecution] = useState<Entity | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'diff' | 'commit' | 'verify' | null>(null);
  const [result, setResult] = useState<Entity | null>(null);
  const [message, setMessage] = useState('');
  const [acceptanceNote, setAcceptanceNote] = useState('');
  const [command, setCommand] = useState('npm');
  const [args, setArgs] = useState('test');
  const eventCursorRef = useRef<string | null>(null);
  const eventPollBusyRef = useRef(false);
  const mergeEvents = useCallback(
    (current: Entity | null, incoming: Entity[]) => {
      if (!current || !incoming.length) return current;
      const byId = new Map(
        entityList(current.events).map((event) => [String(event.id), event]),
      );
      for (const event of incoming) byId.set(String(event.id), event);
      const events = [...byId.values()].sort((a, b) => {
        const at = txt(a, 'createdAt') || txt(a, 'at');
        const bt = txt(b, 'createdAt') || txt(b, 'at');
        return bt.localeCompare(at) || String(b.id).localeCompare(String(a.id));
      });
      return { ...current, events };
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    eventCursorRef.current = null;
    void api<Entity>(`tasks/${taskId}`)
      .then((item) => {
        if (!cancelled) {
          const events = entityList(item.events).sort((a, b) => {
            const at = txt(a, 'createdAt') || txt(a, 'at');
            const bt = txt(b, 'createdAt') || txt(b, 'at');
            return (
              bt.localeCompare(at) || String(b.id).localeCompare(String(a.id))
            );
          });
          const latest = events[0];
          eventCursorRef.current = latest
            ? `${txt(latest, 'createdAt') || txt(latest, 'at')}|${String(latest.id)}`
            : null;
          setExecution(item);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  useEffect(() => {
    let cancelled = false;
    let streamReady = false;
    const source =
      typeof window !== 'undefined' && 'EventSource' in window
        ? new EventSource(
            `/api/tasks/${encodeURIComponent(taskId)}/events/stream`,
          )
        : null;
    const onTaskEvent = (event: MessageEvent<string>) => {
      try {
        const item = JSON.parse(event.data) as Entity;
        if (!item || typeof item !== 'object' || !item.id) return;
        eventCursorRef.current =
          event.lastEventId ||
          `${txt(item, 'createdAt') || txt(item, 'at')}|${String(item.id)}`;
        setExecution((current) =>
          current ? mergeEvents(current, [item]) : current,
        );
        if (streamReady) {
          void api<Entity>(`tasks/${taskId}`)
            .then((item) => {
              if (!cancelled) setExecution(item);
            })
            .catch(() => {});
        }
      } catch {
        // Ignore malformed events; the cursor API below remains the recovery path.
      }
    };
    source?.addEventListener('task_event', onTaskEvent as EventListener);
    source?.addEventListener('ready', () => {
      streamReady = true;
    });
    source?.addEventListener('error', () => source.close());
    const poll = async () => {
      if (cancelled || eventPollBusyRef.current) return;
      eventPollBusyRef.current = true;
      try {
        const after = eventCursorRef.current;
        const suffix = after
          ? `?after=${encodeURIComponent(after)}&limit=100`
          : '?limit=100';
        const page = await api<{ items?: Entity[]; cursor?: string | null }>(
          `tasks/${taskId}/events${suffix}`,
        );
        const items = Array.isArray(page.items) ? page.items : [];
        if (!cancelled && items.length) {
          eventCursorRef.current = page.cursor || eventCursorRef.current;
          setExecution((current) => mergeEvents(current, items));
          // Status, delivery and verification live beside the event log. Refresh
          // the aggregate only when new events arrive, keeping idle polling cheap.
          void api<Entity>(`tasks/${taskId}`)
            .then((item) => {
              if (!cancelled) setExecution(item);
            })
            .catch(() => {});
        } else if (!cancelled && page.cursor) {
          eventCursorRef.current = page.cursor;
        }
      } catch {
        // The initial task request surfaces errors. A transient poll failure
        // should not replace a usable execution detail with an error state.
      } finally {
        eventPollBusyRef.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      source?.close();
    };
  }, [mergeEvents, taskId]);
  const workspace =
    execution?.executionWorkspace &&
    typeof execution.executionWorkspace === 'object'
      ? (execution.executionWorkspace as Entity)
      : null;
  const snapshot =
    execution?.snapshot && typeof execution.snapshot === 'object'
      ? (execution.snapshot as Entity)
      : null;
  const route =
    snapshot?.route && typeof snapshot.route === 'object'
      ? (snapshot.route as Entity)
      : null;
  const routingCandidates = entityList(route?.routingCandidates);
  const routingEvents = entityList(execution?.events).filter((event) =>
    txt(event, 'type').startsWith('routing/'),
  );
  const eventData = (event: Entity) =>
    event.data && typeof event.data === 'object'
      ? (event.data as Entity)
      : ({} as Entity);
  const latestVerification =
    execution?.latestVerification || execution?.verification;
  const recordedVerifications = entityList(execution?.artifacts)
    .filter((item) => item.kind === 'verification')
    .sort((a, b) => {
      const at =
        txt(a, 'finishedAt') || txt(a, 'updatedAt') || txt(a, 'createdAt');
      const bt =
        txt(b, 'finishedAt') || txt(b, 'updatedAt') || txt(b, 'createdAt');
      return bt.localeCompare(at) || String(b.id).localeCompare(String(a.id));
    });
  const verification =
    latestVerification && typeof latestVerification === 'object'
      ? (latestVerification as Entity)
      : recordedVerifications[0];
  const artifacts = entityList(execution?.artifacts);
  const delivery =
    execution?.delivery && typeof execution.delivery === 'object'
      ? (execution.delivery as Entity)
      : null;
  const taskStatus = execution ? status(execution) : '';
  const verificationState =
    (verification ? status(verification) : '') ||
    (workspace && txt(workspace, 'verificationStatus')) ||
    (workspace?.verified === true ? 'verified' : '');
  const deliveryState =
    (delivery ? txt(delivery, 'deliveryStatus') : '') ||
    (taskStatus === 'failed' || verificationState === 'failed'
      ? 'failed'
      : ['queued', 'running', 'state_unknown'].includes(taskStatus)
        ? taskStatus
        : verificationState === 'verified'
          ? 'awaiting-owner'
          : taskStatus === 'completed'
            ? 'pending-review'
            : taskStatus || 'pending-review');
  let deliveryDetail = '任务仍在执行，完成后会在这里显示交付证据。';
  if (deliveryState === 'accepted') {
    const note = delivery ? txt(delivery, 'acceptanceNote') : '';
    deliveryDetail = `所有者已确认交付。${note ? ` ${note}` : ''}`;
  } else if (deliveryState === 'awaiting-owner') {
    deliveryDetail = verification
      ? `验证命令：${title(verification)} · ${time(
          verification.finishedAt || verification.createdAt,
        )}。当前需求版本的验收证据已通过，请由所有者确认是否交付。`
      : '当前需求版本的验收证据已通过，请由所有者确认是否交付。';
  } else if (deliveryState === 'rejected') {
    deliveryDetail = `已退回复核：${(delivery ? txt(delivery, 'acceptanceNote') : '') || '请根据验收意见补充修改后重新提交。'}`;
  } else if (deliveryState === 'failed') {
    deliveryDetail =
      txt(execution || {}, 'error') ||
      txt(verification || {}, 'output') ||
      '执行或验证未通过，请查看错误信息。';
  } else if (deliveryState === 'pending-review') {
    deliveryDetail = artifacts.length
      ? `已记录 ${artifacts.length} 个产物，但还没有验证通过的证据。`
      : '任务已经返回结果，但还没有记录产物或验证证据。';
  } else if (['queued', 'running'].includes(deliveryState)) {
    deliveryDetail = '任务正在执行，完成后会在这里显示交付证据。';
  } else if (deliveryState === 'state_unknown') {
    deliveryDetail = '暂时无法确认执行状态，请先检查已有修改和事件记录。';
  } else if (deliveryState === 'completed') {
    deliveryDetail = '任务已完成，等待交付判断。';
  } else if (deliveryState === 'cancelled') {
    deliveryDetail = '任务已停止，已有结果和修改需要复核。';
  } else if (deliveryState === 'interrupted') {
    deliveryDetail = '任务在执行中断开，恢复前请先检查已有修改。';
  } else if (deliveryState === 'blocked') {
    deliveryDetail = '任务正在等待处理事项，完成后再进行交付判断。';
  }
  const mutating =
    execution &&
    ['running', 'queued', 'state_unknown'].includes(status(execution));
  const perform = async (action: 'diff' | 'commit' | 'verify') => {
    setBusy(true);
    setError('');
    setResult(null);
    setMode(action);
    try {
      const output = await api<Entity>(
        `workspaces/${taskId}${action === 'diff' ? '' : `/${action}`}`,
        action === 'diff' ? 'GET' : 'POST',
        action === 'commit'
          ? { message }
          : action === 'verify'
            ? {
                command,
                args: args
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : undefined,
      );
      setResult(output);
      setExecution(await api<Entity>(`tasks/${taskId}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decideAcceptance = async (decision: 'accept' | 'reject') => {
    const note = acceptanceNote.trim();
    if (decision === 'reject' && !note) {
      setError('退回复核时需要写明需要补充或修改的内容。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api<Entity>(`tasks/${taskId}/${decision}`, 'POST', { note });
      setExecution(await api<Entity>(`tasks/${taskId}`));
      setAcceptanceNote('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const acceptanceCriteria = delivery?.acceptanceCriteria;
  const acceptanceCriteriaText =
    typeof acceptanceCriteria === 'string'
      ? acceptanceCriteria
      : acceptanceCriteria && typeof acceptanceCriteria === 'object'
        ? JSON.stringify(acceptanceCriteria, null, 2)
        : '任务中未单独记录验收标准。';
  const canDecideAcceptance =
    taskStatus === 'completed' && deliveryState !== 'accepted';
  const evidenceKind = (artifact: Entity) =>
    txt(artifact, 'kind') === 'verification'
      ? '验收证据'
      : txt(artifact, 'kind') === 'commit'
        ? '代码提交'
        : '交付产物';
  const evidenceDetail = (artifact: Entity) =>
    txt(artifact, 'output') ||
    txt(artifact, 'evidence') ||
    txt(artifact, 'content');
  return (
    <section className="manage-detail">
      <h3>
        <FolderGit2 size={16} /> 执行目录与验收
      </h3>
      <ErrorMessage error={error} />
      {!execution ? (
        <Empty busy={!error} />
      ) : (
        <>
          <div
            className="delivery-summary"
            data-tone={
              deliveryState === 'failed'
                ? 'error'
                : deliveryState === 'accepted'
                  ? 'success'
                  : ['queued', 'running', 'state_unknown'].includes(
                        deliveryState,
                      )
                    ? 'active'
                    : 'warning'
            }
          >
            <div className="delivery-summary-heading">
              <strong>交付判断</strong>
              <Badge value={deliveryState} />
            </div>
            <p>{deliveryDetail}</p>
          </div>
          <section className="acceptance-decision" aria-label="所有者验收决定">
            <div className="acceptance-decision-heading">
              <div>
                <h3>所有者验收</h3>
                <p>验收标准 · {acceptanceCriteriaText}</p>
              </div>
              {delivery && (
                <Badge
                  value={txt(delivery, 'acceptanceDecision') || deliveryState}
                />
              )}
            </div>
            <div className="acceptance-decision-meta">
              <span>
                需求版本 v
                {delivery
                  ? txt(delivery, 'currentRequirementVersion', '1')
                  : '1'}
              </span>
              {delivery && txt(delivery, 'verificationRequirementVersion') && (
                <span>
                  验证证据 v{txt(delivery, 'verificationRequirementVersion')}
                </span>
              )}
              {delivery && txt(delivery, 'acceptanceAt') && (
                <span>决定于 {time(txt(delivery, 'acceptanceAt'))}</span>
              )}
            </div>
            {deliveryState === 'accepted' &&
              delivery &&
              txt(delivery, 'acceptanceNote') && (
                <p className="acceptance-decision-note">
                  验收备注：{txt(delivery, 'acceptanceNote')}
                </p>
              )}
            {canDecideAcceptance && (
              <>
                <label className="acceptance-note-field">
                  验收备注
                  <textarea
                    aria-label="验收备注"
                    rows={3}
                    value={acceptanceNote}
                    onChange={(event) => setAcceptanceNote(event.target.value)}
                    placeholder={
                      deliveryState === 'awaiting-owner'
                        ? '可以补充本次交付的确认说明。'
                        : '请写明需要补充或修改的内容。'
                    }
                  />
                </label>
                <div className="acceptance-decision-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy || deliveryState !== 'awaiting-owner'}
                    onClick={() => void decideAcceptance('accept')}
                  >
                    <Check size={15} /> 通过交付
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void decideAcceptance('reject')}
                  >
                    <Undo2 size={15} /> 退回复核
                  </button>
                </div>
                {deliveryState !== 'awaiting-owner' && (
                  <p className="acceptance-decision-hint">
                    先运行验证并获得当前需求版本的通过证据，才能确认交付。
                  </p>
                )}
              </>
            )}
          </section>
          <section className="evidence-center" aria-label="模型路由">
            <div className="evidence-center-heading">
              <div>
                <h3>模型路由</h3>
                <p>
                  记录这次执行实际使用的供应商、模型和候选变化，方便解释切换和失败原因。
                </p>
              </div>
              <Badge value={route ? 'selected' : 'pending-review'} />
            </div>
            {!route ? (
              <div className="evidence-empty">
                <strong>尚未记录实际模型</strong>
                <span>任务开始后，实际路由和候选模型会显示在这里。</span>
              </div>
            ) : (
              <>
                <dl>
                  <dt>供应商</dt>
                  <dd>
                    {txt(route, 'providerName') || txt(route, 'providerId')}
                  </dd>
                  <dt>模型</dt>
                  <dd>{txt(route, 'model')}</dd>
                  <dt>协议</dt>
                  <dd>{txt(route, 'protocol')}</dd>
                </dl>
                {!!routingCandidates.length && (
                  <div className="evidence-list">
                    {routingCandidates.map((candidate, index) =>
                      (() => {
                        const health =
                          candidate.health &&
                          typeof candidate.health === 'object'
                            ? (candidate.health as Entity)
                            : null;
                        return (
                          <article
                            className="evidence-item"
                            key={candidate.id || index}
                          >
                            <div className="evidence-item-heading">
                              <div>
                                <strong>
                                  {txt(candidate, 'providerName') ||
                                    txt(candidate, 'providerId')}
                                </strong>
                                <span>
                                  {txt(candidate, 'model') || '未选定模型'}
                                </span>
                              </div>
                              <Badge value={txt(candidate, 'status')} />
                            </div>
                            {(txt(candidate, 'reason') ||
                              candidate.priority !== undefined ||
                              health) && (
                              <div className="evidence-item-meta">
                                {candidate.priority !== undefined && (
                                  <span>
                                    优先级 {txt(candidate, 'priority')}
                                  </span>
                                )}
                                {health && (
                                  <span>
                                    最近探测 ·{' '}
                                    {health.ok === true ? '通过' : '失败'}
                                    {txt(health, 'status')
                                      ? ` · HTTP ${txt(health, 'status')}`
                                      : ''}
                                    {txt(health, 'latencyMs')
                                      ? ` · ${txt(health, 'latencyMs')} ms`
                                      : ''}
                                  </span>
                                )}
                                {txt(candidate, 'reason') && (
                                  <span>{txt(candidate, 'reason')}</span>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })(),
                    )}
                  </div>
                )}
                {!!routingEvents.length && (
                  <div className="evidence-list">
                    {routingEvents.map((event, index) => {
                      const data = eventData(event);
                      const from =
                        data.from && typeof data.from === 'object'
                          ? (data.from as Entity)
                          : ({} as Entity);
                      const to =
                        data.to && typeof data.to === 'object'
                          ? (data.to as Entity)
                          : ({} as Entity);
                      return (
                        <article
                          className="evidence-item"
                          key={event.id || index}
                        >
                          <div className="evidence-item-heading">
                            <div>
                              <strong>
                                {txt(event, 'type') === 'routing/fallback'
                                  ? '已自动切换模型'
                                  : '没有可用的降级模型'}
                              </strong>
                              <span>
                                {txt(from, 'providerName') ||
                                  txt(from, 'providerId')}{' '}
                                · {txt(from, 'model')}
                              </span>
                            </div>
                            <Badge
                              value={
                                txt(event, 'type') === 'routing/fallback'
                                  ? 'selected'
                                  : 'unavailable'
                              }
                            />
                          </div>
                          <div className="evidence-item-meta">
                            {txt(to, 'providerName') && (
                              <span>
                                → {txt(to, 'providerName')} · {txt(to, 'model')}
                              </span>
                            )}
                            {txt(data, 'reason') && (
                              <span>原因：{txt(data, 'reason')}</span>
                            )}
                            <time>{time(event.at || event.createdAt)}</time>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
          <section className="evidence-center" aria-label="交付证据">
            <div className="evidence-center-heading">
              <div>
                <h3>
                  <FileText size={16} /> 交付证据
                </h3>
                <p>
                  执行完成代表任务结束；验收证据才代表结果可以交付。
                  {delivery &&
                    ` 当前记录 ${txt(delivery, 'evidenceCount', String(artifacts.length))} 项证据。`}
                </p>
              </div>
              <Badge
                value={
                  verification
                    ? verificationState
                    : taskStatus === 'completed'
                      ? 'pending-review'
                      : '暂无验收'
                }
              />
            </div>
            {!artifacts.length ? (
              <div className="evidence-empty">
                <strong>还没有交付证据</strong>
                <span>
                  {taskStatus === 'completed'
                    ? '任务已经结束，请运行验证或提交产物后再判断是否交付。'
                    : '完成任务后，代码提交、测试结果和验证输出会显示在这里。'}
                </span>
              </div>
            ) : (
              <div className="evidence-list">
                {artifacts.map((artifact, index) => {
                  const detail = evidenceDetail(artifact);
                  const location =
                    txt(artifact, 'path') ||
                    txt(artifact, 'location') ||
                    txt(artifact, 'commit');
                  return (
                    <article
                      className="evidence-item"
                      key={artifact.id || index}
                    >
                      <div className="evidence-item-heading">
                        <div>
                          <strong>{evidenceKind(artifact)}</strong>
                          <span>{title(artifact)}</span>
                        </div>
                        <Badge value={status(artifact) || 'submitted'} />
                      </div>
                      <div className="evidence-item-meta">
                        {location && <span>{location}</span>}
                        <time>
                          {time(
                            artifact.finishedAt ||
                              artifact.updatedAt ||
                              artifact.createdAt,
                          )}
                        </time>
                      </div>
                      {detail && <pre>{detail}</pre>}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          {!workspace ? (
            <p>尚未分配执行目录；当前判断以任务结果和验证记录为准。</p>
          ) : (
            <>
              <dl>
                <dt>目录类型</dt>
                <dd>
                  {(
                    {
                      shared: '共享目录',
                      worktree: 'Git worktree',
                      snapshot: '文件快照',
                    } as Record<string, string>
                  )[txt(workspace, 'kind')] || txt(workspace, 'kind')}
                </dd>
                <dt>目录</dt>
                <dd>{txt(workspace, 'path')}</dd>
                {Boolean(workspace.branch) && (
                  <>
                    <dt>分支</dt>
                    <dd>{txt(workspace, 'branch')}</dd>
                  </>
                )}
                <dt>目录状态</dt>
                <dd>{txt(workspace, 'state')}</dd>
                <dt>最近验证</dt>
                <dd>
                  <Badge
                    value={
                      (verification ? status(verification) : '') ||
                      txt(workspace, 'verificationStatus') ||
                      (workspace.verified === true
                        ? 'verified'
                        : 'pending-review')
                    }
                  />
                </dd>
              </dl>
              <div className="manage-toolbar">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void perform('diff')}
                >
                  <GitBranch size={15} />
                  查看变更
                </button>
                <button
                  className="secondary-button"
                  disabled={
                    busy ||
                    Boolean(mutating) ||
                    workspace.kind !== 'worktree' ||
                    workspace.state === 'quarantined'
                  }
                  onClick={() => {
                    setMode('commit');
                    setResult(null);
                  }}
                >
                  <Save size={15} />
                  保存内部提交
                </button>
                <button
                  className="secondary-button"
                  disabled={
                    busy ||
                    Boolean(mutating) ||
                    workspace.state === 'quarantined'
                  }
                  onClick={() => {
                    setMode('verify');
                    setResult(null);
                  }}
                >
                  <Terminal size={15} />
                  运行验证
                </button>
              </div>
              {mode === 'commit' && (
                <form
                  className="manage-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform('commit');
                  }}
                >
                  <label>
                    提交说明
                    <input
                      required
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={busy || Boolean(mutating)}
                  >
                    <Save size={15} />
                    保存提交
                  </button>
                </form>
              )}
              {mode === 'verify' && (
                <form
                  className="manage-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform('verify');
                  }}
                >
                  <label>
                    验证程序
                    <input
                      required
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                    />
                  </label>
                  <label>
                    参数（每行一项）
                    <textarea
                      rows={3}
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={busy || Boolean(mutating)}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Play size={15} />
                    )}
                    执行验证
                  </button>
                </form>
              )}
              {result && (
                <div className="manage-detail">
                  {mode === 'diff' ? (
                    <pre>
                      {[
                        txt(result, 'status'),
                        txt(result, 'diff'),
                        txt(result, 'message'),
                      ]
                        .filter(Boolean)
                        .join('\n') || '没有未提交变更'}
                    </pre>
                  ) : mode === 'commit' ? (
                    <>
                      <Badge value="pending-review" />
                      <pre>
                        {txt(result, 'commit')}\n{txt(result, 'branch')}
                      </pre>
                    </>
                  ) : (
                    <>
                      <Badge
                        value={
                          result.ok === true ||
                          result.verified === true ||
                          result.exitCode === 0
                            ? 'verified'
                            : 'failed'
                        }
                      />
                      <pre>
                        {txt(result, 'output') ||
                          txt(result, 'stdout') ||
                          txt(result, 'error') ||
                          txt(result, 'stderr') ||
                          JSON.stringify(result, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              )}
              {!!entityList(execution.usage).length && (
                <>
                  <h3>模型用量</h3>
                  {entityList(execution.usage).map((usage, index) => (
                    <div className="manage-row" key={usage.id || index}>
                      <div className="manage-main">
                        <strong>{txt(usage, 'model')}</strong>
                        <small>
                          输入 {txt(usage, 'inputTokens', '-')} · 输出{' '}
                          {txt(usage, 'outputTokens', '-')}
                        </small>
                      </div>
                      <span className="manage-muted">
                        {usage.cost === undefined || usage.cost === null
                          ? '费用未知'
                          : `${txt(usage, 'cost')} ${txt(usage, 'currency', 'USD')}`}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
