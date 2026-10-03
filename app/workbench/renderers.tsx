import {
  ArrowRight,
  Check,
  Circle,
  FileText,
  LoaderCircle,
  Paperclip,
  Undo2,
  Workflow,
} from 'lucide-react';
import type {
  State,
  Task,
  TeamMessage,
  TeamSpace,
  TeamTimelineItem,
} from './model';
import {
  formatBytes,
  formatTime,
  statusLabels,
  taskVerification,
  verificationLabels,
} from './model';

type WorkbenchRendererDeps = {
  roles: Array<{ id: string; name: string }>;
  tasks: Task[];
  teamSpace?: TeamSpace;
  data: State | null;
  busy: boolean;
  showTask: (task: Task) => void;
  retryTeamMessage: (message: TeamMessage) => Promise<void>;
  selectedReviewTaskIds: string[];
  toggleReviewTask: (taskId: string) => void;
};

export function createWorkbenchRenderers(deps: WorkbenchRendererDeps) {
  const {
    roles,
    tasks,
    teamSpace,
    data,
    busy,
    showTask,
    retryTeamMessage,
    selectedReviewTaskIds,
    toggleReviewTask,
  } = deps;
  const renderTeamTimelineItem = (item: TeamTimelineItem) => {
    const relatedTask = item.taskId
      ? tasks.find((task) => task.id === item.taskId)
      : null;
    if (item.type === 'message') {
      const outgoingCollaboration =
        item.kind === 'handoff' && item.fromTeamId === teamSpace?.id;
      const targetTeamName = data?.spaces?.find(
        (space) => space.id === item.toTeamId,
      )?.name;
      const author =
        item.senderType === 'owner'
          ? '你'
          : item.senderType === 'team'
            ? outgoingCollaboration
              ? `本团队 → ${targetTeamName || '协作团队'}`
              : data?.spaces?.find((space) => space.id === item.fromTeamId)
                  ?.name || '协作团队'
            : roles.find((roleItem) => roleItem.id === item.senderId)?.name ||
              '项目经理';
      return (
        <div
          className={`team-message ${item.senderType === 'owner' ? 'from-user' : 'from-pm'} ${item.status === 'blocked' ? 'blocked' : ''}`}
          key={item.id}
        >
          <span className="message-label">
            {author} <small>{formatTime(item.at)}</small>
            {item.status === 'blocked' && (
              <em className="team-message-state">未发送</em>
            )}
          </span>
          <p>{item.content}</p>
          {!!item.attachments?.length && (
            <div className="attachment-list" aria-label="消息附件">
              {item.attachments.map((attachment) => (
                <span className="attachment-chip" key={attachment.id}>
                  <Paperclip size={13} />
                  {attachment.name}
                  <small>{formatBytes(attachment.size)}</small>
                </span>
              ))}
            </div>
          )}
          {item.kind === 'handoff' && relatedTask && (
            <small className="team-message-collab-status">
              跨团队任务 ·{' '}
              {statusLabels[relatedTask.status] || relatedTask.status}
            </small>
          )}
          {item.status === 'blocked' && (
            <div className="team-message-blocked">
              <span>{item.error || '项目经理正在处理上一条消息。'}</span>
              {item.senderType === 'owner' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void retryTeamMessage({
                      id: item.messageId || item.id,
                      spaceId: teamSpace?.id || '',
                      clientMessageId: item.clientMessageId || null,
                      kind: item.kind || 'request',
                      senderType: 'owner',
                      senderId: item.senderId || 'owner',
                      content: item.content || '',
                      status: item.status || 'blocked',
                      error: item.error || null,
                      createdAt: item.at,
                      taskId: item.taskId || null,
                      attachmentIds: item.attachmentIds || [],
                      attachments: item.attachments || [],
                    })
                  }
                >
                  重新发送
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    if (item.type === 'task') {
      const task = relatedTask;
      return (
        <button
          className="team-task-row"
          key={item.id}
          onClick={() => task && showTask(task)}
          disabled={!task}
        >
          <span className={`status-icon ${item.status || 'queued'}`}>
            {item.status === 'running' ? (
              <LoaderCircle size={13} className="spin" />
            ) : item.status === 'completed' ? (
              <Check size={13} />
            ) : (
              <Circle size={13} />
            )}
          </span>
          <span>
            <strong>
              {roles.find((roleItem) => roleItem.id === item.role)?.name ||
                item.role}
            </strong>
            <small>
              {item.title} · {formatTime(item.at)}
            </small>
            {item.workspaceMode && (
              <small className="team-task-mode">
                工作目录 ·{' '}
                {item.workspaceMode === 'shared'
                  ? '共享'
                  : item.workspaceMode === 'worktree'
                    ? 'Git worktree'
                    : item.workspaceMode === 'snapshot'
                      ? '快照'
                      : '隔离'}
              </small>
            )}
            {(item.result || item.error) && (
              <small className="team-task-result">
                {(item.result || item.error || '')
                  .replace(/\s+/g, ' ')
                  .slice(0, 180)}
              </small>
            )}
            {(item.deliveryStatus || item.verificationStatus) && (
              <small
                className={`team-task-proof ${item.deliveryStatus || item.verificationStatus}`}
              >
                交付 ·{' '}
                {task
                  ? taskVerification(task)
                  : statusLabels[item.deliveryStatus || ''] ||
                    verificationLabels[item.deliveryStatus || ''] ||
                    item.deliveryStatus ||
                    item.verificationStatus}
                {item.artifactCount ? ` · ${item.artifactCount} 项证据` : ''}
              </small>
            )}
          </span>
          <em className={`status ${item.status || 'queued'}`}>
            {statusLabels[item.status || 'queued'] || item.status}
          </em>
        </button>
      );
    }
    if (item.type === 'acceptance') {
      const accepted = item.acceptanceDecision === 'accepted';
      const rejected = item.acceptanceDecision === 'rejected';
      const decisionLabel = accepted
        ? '所有者通过交付'
        : rejected
          ? '所有者退回复核'
          : '验收决定已更新';
      return (
        <button
          className={`team-timeline-record acceptance ${rejected ? 'rejected' : accepted ? 'accepted' : ''}`}
          key={item.id}
          onClick={() => relatedTask && showTask(relatedTask)}
          disabled={!relatedTask}
        >
          <span className="team-timeline-record-icon">
            {accepted ? <Check size={14} /> : <Undo2 size={14} />}
          </span>
          <span>
            <strong>{decisionLabel}</strong>
            <small>
              {item.acceptanceNote || '已记录所有者交付决定'} · v
              {item.currentRequirementVersion || 1} · {formatTime(item.at)}
            </small>
          </span>
        </button>
      );
    }
    const title =
      item.type === 'task-event'
        ? `执行事件 · ${item.eventType || 'event'}`
        : item.type === 'verification'
          ? `验收证据 · ${item.name || '未命名验证'}`
          : `产物 · ${item.name || '未命名产物'}`;
    const detail =
      item.type === 'task-event'
        ? relatedTask?.title || '后台任务状态已更新'
        : item.status
          ? `状态：${statusLabels[item.status] || item.status}`
          : '已记录到交付证据';
    return (
      <button
        className={`team-timeline-record ${item.type}`}
        key={item.id}
        onClick={() => relatedTask && showTask(relatedTask)}
        disabled={!relatedTask}
      >
        <span className="team-timeline-record-icon">
          {item.type === 'task-event' ? (
            <Workflow size={14} />
          ) : item.type === 'verification' ? (
            <Check size={14} />
          ) : (
            <FileText size={14} />
          )}
        </span>
        <span>
          <strong>{title}</strong>
          <small>
            {detail} · {formatTime(item.at)}
          </small>
        </span>
      </button>
    );
  };
  const taskCard = (task: Task) => (
    <button className="task-card" key={task.id} onClick={() => showTask(task)}>
      <div className={`status-icon ${task.status}`}>
        {task.status === 'running' ? (
          <LoaderCircle className="spin" />
        ) : task.status === 'completed' ? (
          <Check />
        ) : (
          <Circle />
        )}
      </div>
      <div>
        <strong>{task.title}</strong>
        <span>
          {roles.find((r) => r.id === task.role)?.name} ·{' '}
          {formatTime(task.createdAt)}
        </span>
        {taskVerification(task) && (
          <small
            className={`task-card-proof ${task.deliveryStatus || task.verificationStatus || ''}`}
          >
            交付 · {taskVerification(task)}
            {task.artifactCount ? ` · ${task.artifactCount} 项证据` : ''}
          </small>
        )}
      </div>
      <span className={`status ${task.status}`}>
        {statusLabels[task.status]}
      </span>
      <ArrowRight size={16} />
    </button>
  );
  const reviewTaskCard = (task: Task) => {
    const selected = selectedReviewTaskIds.includes(task.id);
    return (
      <div
        className={`task-card review-task-card ${selected ? 'selected' : ''}`}
        key={task.id}
      >
        <input
          type="checkbox"
          className="review-task-checkbox"
          aria-label={`选择交付验收任务 ${task.title}`}
          checked={selected}
          onChange={() => toggleReviewTask(task.id)}
        />
        <div className={`status-icon ${task.status}`}>
          {task.status === 'completed' ? <Check /> : <Circle />}
        </div>
        <button
          type="button"
          className="task-card-open"
          onClick={() => showTask(task)}
        >
          <strong>{task.title}</strong>
          <span>
            {roles.find((r) => r.id === task.role)?.name} ·{' '}
            {formatTime(task.createdAt)}
          </span>
          {taskVerification(task) && (
            <small
              className={`task-card-proof ${task.deliveryStatus || task.verificationStatus || ''}`}
            >
              交付 · {taskVerification(task)}
              {task.artifactCount ? ` · ${task.artifactCount} 项证据` : ''}
            </small>
          )}
        </button>
        <span className={`status ${task.status}`}>
          {statusLabels[task.status]}
        </span>
        <ArrowRight size={16} />
      </div>
    );
  };
  return { renderTeamTimelineItem, taskCard, reviewTaskCard };
}
