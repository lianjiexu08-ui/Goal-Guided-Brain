'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Users, Workflow } from 'lucide-react';
import { api } from '../workbench-api';
import { useCollaborationDraft } from './use-collaboration-draft';
import { useTeamTimeline } from './use-team-timeline';
import { CollaborationChain } from './collaboration-chain';
import { CollaborationReviewControl } from './collaboration-review';
import type { CollaborationReview } from './model';

type TeamMessage = {
  collaborationReview?: CollaborationReview | null;
  id: string;
  messageId?: string;
  followupMessageId?: string | null;
  kind: string;
  relatedMessageId?: string | null;
  fromTeamId?: string | null;
  toTeamId?: string | null;
  taskId?: string | null;
  content: string;
  status: string;
  createdAt: string;
};

type Task = {
  id: string;
  status: string;
  deliveryStatus?: string | null;
  verificationStatus?: string | null;
};

type TeamCollaborator = {
  id: string;
  name: string;
  purpose?: string;
  memberCount?: number;
  budgetTokens?: number | null;
};

type TeamSpace = {
  id: string;
  name: string;
  recruitment?: { phase?: string } | null;
  collaboration?: { enabled?: boolean } | null;
};

const statusLabels: Record<string, string> = {
  sent: '已送达',
  answered: '已回传',
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

export function TeamCollaborationConsole({
  team,
  teams,
  tasks,
  onOpenTeam,
  onOpenTask,
  onChanged,
  revision = 0,
}: {
  team: TeamSpace;
  teams: TeamSpace[];
  tasks: Task[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
  onChanged?: () => Promise<void> | void;
  revision?: number;
}) {
  const [collaborators, setCollaborators] = useState<TeamCollaborator[]>([]);
  const draftStore = useCollaborationDraft(team.id);
  const { targetTeamId, content, acceptance, clientMessageId, followup } =
    draftStore.draft;
  const composer = useRef<HTMLFormElement>(null);
  const [chainMessageId, setChainMessageId] = useState<string | null>(null);
  const chainTrigger = useRef<HTMLButtonElement | null>(null);
  const [replacement, setReplacement] = useState<TeamMessage | null>(null);
  const inFlight = useRef(false);
  const [loadError, setLoadError] = useState('');
  const loadRequest = useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  const fingerprint = JSON.stringify([
    targetTeamId,
    content,
    acceptance,
    followup,
  ]);
  const [reviewed, setReviewed] = useState('');
  const reviewing = reviewed === fingerprint;
  const setReviewing = (value: boolean) =>
    setReviewed(value ? fingerprint : '');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const history = useTeamTimeline(team.id, 'collaboration', revision, 8);
  const [lastCreated, setLastCreated] = useState<
    | (TeamMessage & {
        sourceTeamId?: string;
        targetTeamId?: string;
        sessionId?: string;
      })
    | null
  >(null);
  const confirmed = team.recruitment?.phase === 'confirmed';
  const enabled = team.collaboration?.enabled !== false;
  const target = collaborators.find((item) => item.id === targetTeamId);
  const teamById = new Map(teams.map((item) => [item.id, item]));
  const taskById = new Map(tasks.map((item) => [item.id, item]));

  const loadCollaborators = useCallback(async () => {
    const request = loadRequest.current;
    const sequence = ++request.sequence;
    request.controller?.abort();
    if (!confirmed || !enabled) {
      setCollaborators([]);
      return;
    }
    const controller = new AbortController();
    request.controller = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setLoadError('');
    try {
      const result = await api<TeamCollaborator[]>(
        `teams/${team.id}/collaborators`,
        'GET',
        undefined,
        controller.signal,
      );
      if (request.sequence !== sequence) return;
      if (!Array.isArray(result))
        throw new Error('目标团队列表返回不完整，请重试。');
      setCollaborators(Array.isArray(result) ? result : []);
    } catch (rawError) {
      if (request.sequence !== sequence) return;
      setCollaborators([]);
      setLoadError(
        controller.signal.aborted
          ? '读取目标团队超时，请重试。'
          : (rawError as Error).message,
      );
    } finally {
      window.clearTimeout(timeout);
      if (request.sequence === sequence) setLoading(false);
    }
  }, [confirmed, enabled, team.id]);

  useEffect(() => {
    const request = loadRequest.current;
    const timer = window.setTimeout(() => void loadCollaborators(), 0);
    return () => {
      window.clearTimeout(timer);
      request.sequence++;
      request.controller?.abort();
    };
  }, [loadCollaborators]);

  const messages: TeamMessage[] = (history.page?.items || [])
    .map((item) => ({
      ...item,
      kind: item.kind || 'handoff',
      content: item.content || '',
      status: item.status || 'sent',
      createdAt: item.at,
    }))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );

  function continueCollaboration(message: TeamMessage, replace = false) {
    if (!draftStore.ready || clientMessageId || submitting) return;
    if (!replace && (content.trim() || acceptance.trim() || followup)) {
      setReplacement(message);
      return;
    }
    const outgoing = message.fromTeamId === team.id;
    const messageId = outgoing ? message.messageId : message.relatedMessageId;
    const targetId = outgoing ? message.toTeamId : message.fromTeamId;
    if (!messageId || !targetId) return;
    draftStore.update({
      targetTeamId: targetId,
      content: '',
      acceptance: '',
      followup: { messageId, title: message.content.slice(0, 160) },
    });
    setReplacement(null);
    setReviewing(false);
    setError('');
    setLastCreated(null);
    composer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    composer.current
      ?.querySelector<HTMLTextAreaElement>('textarea')
      ?.focus({ preventScroll: true });
  }

  const statusLabel = (message: TeamMessage, task?: Task) => {
    if (task) {
      const status =
        task.deliveryStatus || task.verificationStatus || task.status;
      return statusLabels[status] || verificationLabels[status] || status;
    }
    return statusLabels[message.status] || message.status;
  };

  async function submitCollaboration(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (inFlight.current || !draftStore.ready) return;
    const trimmed = content.trim();
    if (!targetTeamId) {
      setError('请先选择目标团队。');
      return;
    }
    if (!trimmed) {
      setError('请说明希望目标团队完成的协作目标。');
      return;
    }
    if (!reviewing && !clientMessageId) {
      setError('');
      setReviewing(true);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let pendingId: string | undefined;
    try {
      const pending = draftStore.confirm();
      pendingId = pending.clientMessageId;
      const created = await api<
        TeamMessage & {
          sourceTeamId?: string;
          targetTeamId?: string;
          sessionId?: string;
        }
      >(
        `teams/${team.id}/collaborate`,
        'POST',
        {
          targetTeamId: pending.targetTeamId,
          content: pending.content.trim(),
          ...(pending.acceptance.trim()
            ? { acceptance: pending.acceptance.trim() }
            : {}),
          clientMessageId: pending.clientMessageId,
          followupMessageId: pending.followup?.messageId,
        },
        controller.signal,
      );
      if (!created?.taskId)
        throw new Error('未收到完整的任务回执，请重试确认送达。');
      draftStore.complete(pending.clientMessageId!);
      setReviewing(false);
      setLastCreated(created);
      history.refresh();
      try {
        await onChanged?.();
      } catch {
        setError('协作已送达，但工作台刷新失败，请稍后刷新查看进展。');
      }
    } catch (rawError) {
      setError(
        controller.signal.aborted
          ? '确认送达超时，请重试确认。'
          : (rawError as Error).message,
      );
      const status = (rawError as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        if (pendingId) draftStore.release(pendingId);
        setReviewing(false);
      }
    } finally {
      window.clearTimeout(timeout);
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="team-collaboration-console" aria-label="团队协作控制台">
      <div className="team-collaboration-head">
        <div>
          <span className="section-kicker">TEAM HANDOFF</span>
          <h2>跨团队协作</h2>
          <p>
            把清晰的协作目标交给另一个团队，由目标团队自己的项目经理接收、拆解和回传结果。
          </p>
        </div>
        <span
          className={`team-collaboration-state ${enabled && confirmed ? 'ready' : ''}`}
        >
          <span className="live-dot" />
          {confirmed
            ? enabled
              ? `${collaborators.length} 个可协作团队`
              : '协作已关闭'
            : '招募确认后可用'}
        </span>
      </div>
      {!confirmed || !enabled ? (
        <div className="team-collaboration-disabled">
          <Users size={17} />
          <span>
            {!confirmed
              ? '当前团队还在招募阶段。确认 Team Charter 后，才能委派给其他团队。'
              : '团队设置已关闭跨团队协作。需要时可在团队设置中重新开启。'}
          </span>
        </div>
      ) : (
        <form
          ref={composer}
          className="team-collaboration-form"
          onSubmit={submitCollaboration}
        >
          <label>
            <span>目标团队</span>
            <select
              aria-label="选择协作目标团队"
              value={targetTeamId}
              onChange={(event) => {
                draftStore.update({ targetTeamId: event.target.value });
                setReviewing(false);
              }}
              disabled={
                !draftStore.ready ||
                loading ||
                submitting ||
                Boolean(clientMessageId) ||
                Boolean(followup) ||
                collaborators.length === 0
              }
            >
              <option value="">
                {loading ? '正在读取目标团队…' : '请选择目标团队'}
              </option>
              {targetTeamId && !target && (
                <option value={targetTeamId}>
                  {teamById.get(targetTeamId)?.name || '原目标团队'}
                  （当前不可选）
                </option>
              )}
              {collaborators.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <div className="team-collaboration-target">
              <strong>{target.name}</strong>
              <span>
                {target.purpose ||
                  '目标团队将由自己的项目经理判断是否接受并安排执行。'}
              </span>
              <small>
                {target.memberCount
                  ? `${target.memberCount} 位成员`
                  : '成员配置'}{' '}
                ·{' '}
                {target.budgetTokens
                  ? `任务预算上限 ${target.budgetTokens.toLocaleString()} tokens`
                  : '预算沿用目标团队设置'}{' '}
                · 目标团队使用自己的模型、能力和执行目录
              </small>
            </div>
          )}
          {followup && (
            <section
              className="team-collaboration-followup"
              aria-label="引用的原协作"
            >
              <strong>继续原协作</strong>
              <p>{followup.title}</p>
              <small>
                发送时自动引用原请求和回传结果。请在下方说明本次追问或新的交付要求；目标团队会创建独立后续任务。
              </small>
              <button
                type="button"
                className="secondary-button"
                disabled={submitting || Boolean(clientMessageId)}
                onClick={() => {
                  draftStore.update({ followup: undefined });
                  setReviewing(false);
                }}
              >
                取消引用，改为新协作
              </button>
            </section>
          )}
          <label className="team-collaboration-content">
            <span>协作目标</span>
            <textarea
              aria-label="协作目标"
              value={content}
              onChange={(event) => {
                draftStore.update({ content: event.target.value });
                setReviewing(false);
              }}
              placeholder="例如：请检查本次发布的监控、回滚和故障响应清单，并回传可执行建议。"
              rows={3}
              maxLength={32000}
              disabled={
                !draftStore.ready || submitting || Boolean(clientMessageId)
              }
            />
          </label>
          <label className="team-collaboration-acceptance">
            <span>验收标准（可选）</span>
            <textarea
              aria-label="协作验收标准"
              value={acceptance}
              onChange={(event) => {
                draftStore.update({ acceptance: event.target.value });
                setReviewing(false);
              }}
              placeholder="例如：回传检查清单、风险等级和可执行的回滚步骤。"
              rows={2}
              maxLength={20000}
              disabled={
                !draftStore.ready || submitting || Boolean(clientMessageId)
              }
            />
          </label>
          {reviewing && !clientMessageId && target && (
            <section
              className="team-collaboration-review"
              aria-label="协作发送前审阅"
            >
              <div>
                <strong>发送前审阅</strong>
                <span>
                  将以下内容交给 {target.name}{' '}
                  的项目经理，由对方团队按自己的权限执行。
                </span>
              </div>
              <dl>
                {followup && (
                  <>
                    <dt>关联协作</dt>
                    <dd>{followup.title}（自动附上原请求及回传）</dd>
                  </>
                )}
                <dt>协作目标</dt>
                <dd>{content.trim()}</dd>
                <dt>验收标准</dt>
                <dd>
                  {acceptance.trim() ||
                    '未填写，目标团队将根据协作目标判断交付标准。'}
                </dd>
                <dt>权限边界</dt>
                <dd>
                  目标团队的成员、模型、能力和执行目录保持独立，当前团队不会获得额外权限。
                </dd>
              </dl>
            </section>
          )}
          <div className="team-collaboration-form-footer">
            <small>
              目标团队会在自己的任务队列中看到这条请求；发送前可以审阅输入和验收标准。
            </small>
            <div className="team-collaboration-form-actions">
              {reviewing && !clientMessageId && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setReviewing(false)}
                  disabled={submitting}
                >
                  返回修改
                </button>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={
                  !draftStore.ready ||
                  submitting ||
                  (!clientMessageId && (loading || !target))
                }
              >
                {submitting
                  ? '发送中…'
                  : clientMessageId
                    ? '重试确认送达'
                    : reviewing
                      ? '确认并发起协作'
                      : '预览并发起协作'}{' '}
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </form>
      )}
      {loadError && (
        <div className="overview-load-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void loadCollaborators()}
          >
            重新读取目标团队
          </button>
        </div>
      )}
      {error && (
        <div className="team-collaboration-error" role="alert">
          {error}
        </div>
      )}
      {clientMessageId && !submitting && (
        <output className="team-collaboration-error">
          尚未确认请求是否送达。请重试确认，原目标和内容已锁定，使用同一请求不会重复派发。
        </output>
      )}
      <output className="team-collaboration-draft-status">
        {draftStore.storageError ||
          (!draftStore.ready
            ? '正在恢复协作草稿…'
            : '协作草稿保存在当前浏览器，按来源团队分别恢复。')}
      </output>
      {lastCreated && (
        <output className="team-collaboration-success">
          <Check size={15} />
          <span>
            协作请求已发送给{' '}
            {teamById.get(lastCreated.targetTeamId || targetTeamId)?.name ||
              target?.name ||
              '目标团队'}
            。
          </span>
          {lastCreated.taskId && (
            <button
              type="button"
              onClick={() => onOpenTask(lastCreated.taskId!)}
            >
              查看任务
            </button>
          )}
        </output>
      )}
      <div className="team-collaboration-history">
        {replacement && (
          <section
            className="team-collaboration-followup"
            aria-label="保留或替换协作草稿"
          >
            <strong>已有尚未发送的协作草稿</strong>
            <p>继续这条协作会替换当前目标、内容和验收标准。</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setReplacement(null)}
            >
              保留当前草稿
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={submitting || Boolean(clientMessageId)}
              onClick={() => continueCollaboration(replacement, true)}
            >
              替换草稿并继续
            </button>
          </section>
        )}
        <div className="team-collaboration-history-head">
          <strong>最近协作</strong>
          {messages.length > 0 && <span>{messages.length} 条记录</span>}
        </div>
        {chainMessageId && (
          <CollaborationChain
            key={`${team.id}:${chainMessageId}`}
            teamId={team.id}
            messageId={chainMessageId}
            onOpenTask={onOpenTask}
            onClose={() => {
              setChainMessageId(null);
              chainTrigger.current?.focus();
            }}
          />
        )}
        {history.error && (
          <div className="overview-load-error" role="alert">
            <div>
              <strong>{history.error}</strong>
              <p>
                {history.page
                  ? '协作记录刷新失败，保留上次读取的内容。'
                  : '协作记录暂时不可用。'}
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={history.loading}
              onClick={history.retry}
            >
              重试
            </button>
          </div>
        )}
        {!history.page && history.loading && <output>正在读取协作记录…</output>}
        {messages.length > 0 ? (
          messages.map((message) => {
            const outgoing = message.fromTeamId === team.id;
            const relatedTeamId = outgoing
              ? message.toTeamId
              : message.fromTeamId;
            const relatedTeam = relatedTeamId
              ? teamById.get(relatedTeamId)
              : undefined;
            const relatedTask = message.taskId
              ? taskById.get(message.taskId)
              : undefined;
            const relatedName =
              relatedTeam?.name || (outgoing ? '目标团队' : '协作团队');
            return (
              <article className="team-collaboration-item" key={message.id}>
                <div className="team-collaboration-item-main">
                  <span className="team-collaboration-item-icon">
                    <Workflow size={14} />
                  </span>
                  <div>
                    <strong>
                      {outgoing ? `发给 ${relatedName}` : `来自 ${relatedName}`}
                    </strong>
                    <small>
                      {message.kind === 'reply'
                        ? '目标团队回传'
                        : message.followupMessageId
                          ? '后续协作请求'
                          : '协作请求'}{' '}
                      · {formatTime(message.createdAt)}
                    </small>
                  </div>
                  <em className={message.status === 'blocked' ? 'blocked' : ''}>
                    {statusLabel(message, relatedTask)}
                  </em>
                </div>
                {message.collaborationReview && (
                  <div
                    className={`collaboration-review-status ${message.collaborationReview.status}`}
                  >
                    {message.collaborationReview.status === 'closed'
                      ? message.collaborationReview.action === 'complete'
                        ? '已确认完成'
                        : '已结束跟进（不代表验收通过）'
                      : message.collaborationReview.status === 'stale'
                        ? '结果或验收已变化，需重新复核'
                        : '协作跟进中'}
                  </div>
                )}
                <details className="team-collaboration-detail">
                  <summary>
                    <span>{message.content.split('\n')[0]}</span>
                    <b>查看完整内容</b>
                  </summary>
                  <div>{message.content}</div>
                </details>
                <div className="team-collaboration-item-actions">
                  {message.collaborationReview && (
                    <button
                      type="button"
                      onClick={(event) => {
                        chainTrigger.current = event.currentTarget;
                        setChainMessageId(
                          message.collaborationReview!.messageId,
                        );
                      }}
                    >
                      查看协作链路
                    </button>
                  )}
                  {relatedTeamId && (
                    <button
                      type="button"
                      onClick={() => onOpenTeam(relatedTeamId)}
                    >
                      打开团队
                    </button>
                  )}
                  {relatedTask && (
                    <button
                      type="button"
                      onClick={() => onOpenTask(relatedTask.id)}
                    >
                      查看任务
                    </button>
                  )}
                  {confirmed &&
                    enabled &&
                    (!message.collaborationReview ||
                      message.collaborationReview.status === 'open') &&
                    relatedTask &&
                    [
                      'completed',
                      'failed',
                      'cancelled',
                      'interrupted',
                    ].includes(relatedTask.status) &&
                    ((outgoing && message.kind === 'handoff') ||
                      (!outgoing &&
                        message.kind === 'reply' &&
                        message.relatedMessageId)) && (
                      <button
                        type="button"
                        disabled={
                          !draftStore.ready ||
                          submitting ||
                          Boolean(clientMessageId)
                        }
                        onClick={() => continueCollaboration(message)}
                      >
                        继续协作
                      </button>
                    )}
                </div>
                {message.collaborationReview?.sourceTeamId === team.id && (
                  <CollaborationReviewControl
                    review={message.collaborationReview}
                    onOpenTask={onOpenTask}
                    onChanged={history.refresh}
                  />
                )}
              </article>
            );
          })
        ) : history.page ? (
          <div className="team-collaboration-empty">
            <Workflow size={16} />{' '}
            发起一次协作后，这里会显示目标团队、任务状态和回传结果。
          </div>
        ) : null}
        {history.page?.hasMore && (
          <button
            type="button"
            className="secondary-button"
            disabled={history.loading || history.moreFailed}
            onClick={history.loadMore}
          >
            {history.loading ? '正在读取…' : '加载更早协作'}
          </button>
        )}
      </div>
    </section>
  );
}
