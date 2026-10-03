'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Users, Workflow } from 'lucide-react';
import { api } from '../workbench-api';

type TeamMessage = {
  id: string;
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
  messages?: TeamMessage[] | null;
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
}: {
  team: TeamSpace;
  teams: TeamSpace[];
  tasks: Task[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [collaborators, setCollaborators] = useState<TeamCollaborator[]>([]);
  const [targetTeamId, setTargetTeamId] = useState('');
  const [content, setContent] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
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
    if (!confirmed || !enabled) {
      setCollaborators([]);
      setTargetTeamId('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api<TeamCollaborator[]>(
        `teams/${team.id}/collaborators`,
      );
      setCollaborators(Array.isArray(result) ? result : []);
    } catch (rawError) {
      setCollaborators([]);
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [confirmed, enabled, team.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCollaborators(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCollaborators]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTargetTeamId((current) => {
        if (current && collaborators.some((item) => item.id === current))
          return current;
        return collaborators[0]?.id || '';
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [collaborators]);

  const messages = [...(team.messages || [])]
    .filter(
      (message) =>
        message.kind === 'handoff' ||
        (message.kind === 'reply' &&
          Boolean(message.relatedMessageId || message.fromTeamId)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

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
    const trimmed = content.trim();
    if (!targetTeamId) {
      setError('请先选择目标团队。');
      return;
    }
    if (!trimmed) {
      setError('请说明希望目标团队完成的协作目标。');
      return;
    }
    if (!reviewing) {
      setError('');
      setReviewing(true);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const clientMessageId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const created = await api<
        TeamMessage & {
          sourceTeamId?: string;
          targetTeamId?: string;
          sessionId?: string;
        }
      >(`teams/${team.id}/collaborate`, 'POST', {
        targetTeamId,
        content: trimmed,
        ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
        clientMessageId,
      });
      setContent('');
      setAcceptance('');
      setReviewing(false);
      setLastCreated(created);
      await onChanged?.();
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
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
          className="team-collaboration-form"
          onSubmit={submitCollaboration}
        >
          <label>
            <span>目标团队</span>
            <select
              aria-label="选择协作目标团队"
              value={targetTeamId}
              onChange={(event) => {
                setTargetTeamId(event.target.value);
                setReviewing(false);
              }}
              disabled={loading || submitting || collaborators.length === 0}
            >
              {!collaborators.length && (
                <option value="">暂无可协作团队</option>
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
          <label className="team-collaboration-content">
            <span>协作目标</span>
            <textarea
              aria-label="协作目标"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：请检查本次发布的监控、回滚和故障响应清单，并回传可执行建议。"
              rows={3}
              maxLength={32000}
              disabled={submitting || collaborators.length === 0}
            />
          </label>
          <label className="team-collaboration-acceptance">
            <span>验收标准（可选）</span>
            <textarea
              aria-label="协作验收标准"
              value={acceptance}
              onChange={(event) => {
                setAcceptance(event.target.value);
                setReviewing(false);
              }}
              placeholder="例如：回传检查清单、风险等级和可执行的回滚步骤。"
              rows={2}
              maxLength={20000}
              disabled={submitting || collaborators.length === 0}
            />
          </label>
          {reviewing && target && (
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
              {reviewing && (
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
                disabled={submitting || loading || collaborators.length === 0}
              >
                {submitting
                  ? '发送中…'
                  : reviewing
                    ? '确认并发起协作'
                    : '预览并发起协作'}{' '}
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </form>
      )}
      {error && <div className="team-collaboration-error">{error}</div>}
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
        <div className="team-collaboration-history-head">
          <strong>最近协作</strong>
          {messages.length > 0 && <span>{messages.length} 条记录</span>}
        </div>
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
                      {message.kind === 'reply' ? '目标团队回传' : '协作请求'} ·{' '}
                      {formatTime(message.createdAt)}
                    </small>
                  </div>
                  <em className={message.status === 'blocked' ? 'blocked' : ''}>
                    {statusLabel(message, relatedTask)}
                  </em>
                </div>
                <p>{message.content}</p>
                <div className="team-collaboration-item-actions">
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
                </div>
              </article>
            );
          })
        ) : (
          <div className="team-collaboration-empty">
            <Workflow size={16} />{' '}
            发起一次协作后，这里会显示目标团队、任务状态和回传结果。
          </div>
        )}
      </div>
    </section>
  );
}
