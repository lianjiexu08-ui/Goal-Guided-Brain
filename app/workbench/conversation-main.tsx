/* oxlint-disable */
// @ts-nocheck
'use client';
// Focused presentation modules receive a controller context assembled by Workbench.
/* oxlint-disable no-explicit-any, no-unused-vars */
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api, entityList, entityText } from '../workbench-api';
import {
  AssistantEditor,
  assistantIcons,
  blankAssistant,
  type Assistant,
} from '../assistant-editor';
import { TeamActivity } from './team-activity';
import { KnowledgeCollection } from './knowledge-collection';
import { RiskInbox } from './team-overview';
import { Choice } from './choice';
import {
  ExecutionInspector,
  Management,
  managementNavigation,
} from '../management';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  Copy,
  FileText,
  FolderOpen,
  History,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquare,
  Pencil,
  Paperclip,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { WorkbenchContext } from './view-context';
import { ConversationComposer } from './conversation-composer';
import {
  formatBytes,
  formatTime,
  isActive,
  modelDisplayName,
  statusLabels,
} from './model';

export function ConversationMain({ context }: { context: WorkbenchContext }) {
  const {
    endRef,
    composerRef,
    attachmentInputRef,
    roles,
    activeRoles,
    assistant,
    Icon,
    tasks,
    confirmedSpaces,
    recruitmentSpaces,
    recruitmentSpace,
    teamSpace,
    isRecruitmentView,
    isTeamConversation,
    assistantName,
    recruitment,
    recruitmentProposal,
    isRecruiting,
    recruitmentPhaseMeta,
    charterKey,
    recruitmentReviewsComplete,
    charterExpanded,
    modelOptions,
    draftKey,
    attachmentDraftKey,
    isTeamMember,
    sessions,
    sessionSelectionKey,
    currentSession,
    conversationWorkspace,
    currentTasks,
    selectedModelOption,
    action,
    uploadAttachments,
    clipboardFiles,
    submit,
    changeTeamModel,
    confirmTeamRecruitment,
    openSettings,
    openKnowledge,
    openHandoff,
    openTeamRename,
    openTeamSettings,
    startRecruitment,
    selectTeam,
    editRole,
    isMobile,
    drafts,
    setDrafts,
    draftAttachments,
    setDraftAttachments,
    draftSyncState,
    draftConflict,
    setDraftConflict,
    markDraftDirty,
    resolveDraftConflict,
    role,
    data,
    setSelected,
    draggingFiles,
    setDraggingFiles,
    busy,
    setNotice,
    setTaskDetail,
    setEditingAssistant,
    setExpandedCharters,
    recruitmentApprovals,
    setRecruitmentApprovals,
    recruitmentSyncState,
  } = context;
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const conversationRef = useRef<HTMLElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const shouldStickToLatestRef = useRef(true);
  const previousConversationKeyRef = useRef('');
  const conversationKey = `${teamSpace?.id || recruitmentSpace?.id || 'standalone'}:${role}`;
  const currentTaskVersion = currentTasks
    .map((task) => `${task.id}:${task.updatedAt || ''}:${task.status}`)
    .join('|');

  useEffect(() => {
    const messageArea = messageAreaRef.current;
    if (!messageArea) return undefined;
    const updateScrollState = () => {
      const distanceFromLatest =
        messageArea.scrollHeight -
        messageArea.scrollTop -
        messageArea.clientHeight;
      const nearLatest = distanceFromLatest <= 80;
      shouldStickToLatestRef.current = nearLatest;
      setShowJumpToLatest(!nearLatest);
    };
    updateScrollState();
    messageArea.addEventListener('scroll', updateScrollState, {
      passive: true,
    });
    return () => messageArea.removeEventListener('scroll', updateScrollState);
  }, []);

  useEffect(() => {
    const conversation = conversationRef.current;
    const composer = conversation?.querySelector('.composer-area');
    if (!conversation || !composer || typeof ResizeObserver === 'undefined')
      return undefined;
    const syncComposerHeight = () => {
      conversation.style.setProperty(
        '--ggb-composer-height',
        `${Math.ceil(composer.getBoundingClientRect().height)}px`,
      );
    };
    syncComposerHeight();
    const observer = new ResizeObserver(syncComposerHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const conversationChanged =
      previousConversationKeyRef.current !== conversationKey;
    previousConversationKeyRef.current = conversationKey;
    if (conversationChanged) {
      shouldStickToLatestRef.current = true;
      setShowJumpToLatest(false);
    }
    if (!currentTasks.length || !shouldStickToLatestRef.current) {
      if (!shouldStickToLatestRef.current && currentTasks.length > 0) {
        setShowJumpToLatest(true);
      }
      return;
    }
    requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }),
    );
  }, [conversationKey, currentTaskVersion, endRef]);

  const jumpToLatest = () => {
    shouldStickToLatestRef.current = true;
    setShowJumpToLatest(false);
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
  return (
    <section className="conversation" ref={conversationRef}>
      <div className="conversation-top">
        <div>
          <span className="section-kicker">
            {isRecruitmentView
              ? 'REQUIREMENT INTAKE · 需求发布'
              : isTeamConversation
                ? 'TEAM CONVERSATION · 协作推进'
                : 'AGENT CONVERSATION · 独立讨论'}
          </span>
          <h1>
            {isRecruitmentView
              ? '发布需求，招募团队'
              : isTeamConversation
                ? teamSpace?.name
                : assistantName}
            <span className="quiet-badge">
              {tasks.some((t) => t.role === role && isActive(t))
                ? '工作中'
                : '随时开始'}
            </span>
          </h1>
          <p className="conversation-subtitle">
            {isRecruitmentView
              ? '把要解决的问题、交付物和约束直接发给项目经理。团队名称会根据实际工作内容生成，确认后才会进入“我的团队”。'
              : isTeamConversation
                ? teamSpace?.goal
                : teamSpace?.memberSettings?.[role]?.responsibility ||
                  assistant.desc}
          </p>
          {isRecruitmentView && (
            <small
              className={`recruitment-sync-status ${recruitmentSyncState}`}
            >
              {recruitmentSyncState === 'syncing'
                ? '正在同步招募会话'
                : recruitmentSyncState === 'synced'
                  ? '招募会话已同步，可在其他设备继续'
                  : recruitmentSyncState === 'offline'
                    ? '暂时无法同步，会话内容会在恢复后继续同步'
                    : ''}
            </small>
          )}
          {isRecruitmentView && (
            <div
              className={`recruitment-status-card recruitment-status-${recruitment?.phase || 'discovery'}`}
              data-testid="recruitment-status-card"
            >
              <div>
                <span>当前对象</span>
                <strong>需求草稿</strong>
                <small>{teamSpace?.name || '未命名需求'}</small>
              </div>
              <div>
                <span>当前阶段</span>
                <strong>{recruitmentPhaseMeta.label}</strong>
                <small>{recruitmentPhaseMeta.description}</small>
              </div>
              <div>
                <span>下一步</span>
                <small>{recruitmentPhaseMeta.next}</small>
              </div>
            </div>
          )}
        </div>
        <div className="conversation-controls">
          {teamSpace &&
          (isRecruiting ? recruitmentSpace : confirmedSpaces[0]) ? (
            <Choice
              label={isRecruiting ? '选择需求草稿' : '选择团队'}
              value={teamSpace.id}
              onChange={selectTeam}
              options={
                isRecruiting
                  ? recruitmentSpaces.map((space) => ({
                      value: space.id,
                      label: `需求草稿 · ${space.name}`,
                    }))
                  : confirmedSpaces.map((space) => ({
                      value: space.id,
                      label: space.name,
                    }))
              }
            />
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !activeRoles.length}
            onClick={() => void startRecruitment(true)}
          >
            <Plus size={15} /> {isRecruitmentView ? '另起需求' : '发布新需求'}
          </button>
          {!isRecruitmentView && (
            <button
              className="text-button"
              type="button"
              disabled={busy || !teamSpace}
              onClick={openTeamRename}
            >
              <Pencil size={13} /> 重命名
            </button>
          )}
          {!isRecruitmentView && (
            <button
              className="text-button"
              type="button"
              onClick={openTeamSettings}
            >
              团队设置
            </button>
          )}
          <button
            className="icon-button"
            title="编辑助手"
            aria-label="编辑助手"
            disabled={!assistant.id}
            onClick={editRole}
          >
            <Settings2 size={18} />
          </button>
          {!isTeamConversation && (
            <button
              className="secondary-button"
              onClick={() =>
                setSelected((s) => ({
                  ...s,
                  [sessionSelectionKey]: undefined,
                }))
              }
            >
              <Plus size={16} />
              新会话
            </button>
          )}
        </div>
      </div>
      {!isTeamConversation && (
        <div className="session-picker">
          {sessions.length > 0 && (
            <Choice
              label="选择会话"
              value={currentSession || ''}
              onChange={(id) =>
                setSelected((s) => ({
                  ...s,
                  [sessionSelectionKey]: id,
                }))
              }
              options={[
                { value: '', label: '新会话' },
                ...sessions.map((s) => ({
                  value: s.id,
                  label: s.title,
                })),
              ]}
            />
          )}
          <span>
            <MessageSquare size={14} />
            独立上下文
          </span>
        </div>
      )}
      {isTeamConversation && recruitmentProposal && (
        <section
          className={`recruitment-proposal-card${recruitment?.phase === 'confirmed' ? ' is-confirmed' : ''}`}
          aria-label="团队招募方案"
        >
          <button
            className="recruitment-proposal-head"
            type="button"
            aria-expanded={charterExpanded}
            onClick={() =>
              setExpandedCharters((current) => ({
                ...current,
                [charterKey]: !charterExpanded,
              }))
            }
          >
            <div>
              <span className="section-kicker">TEAM CHARTER</span>
              <h2>
                {recruitmentProposal.teamName || teamSpace?.name || '团队方案'}
              </h2>
            </div>
            <span className="recruitment-head-actions">
              <span className="recruitment-phase">
                {recruitment?.phase === 'confirmed' ? '已确认' : '待你确认'}
              </span>
              <ChevronDown
                size={16}
                className={
                  charterExpanded
                    ? 'charter-chevron expanded'
                    : 'charter-chevron'
                }
              />
            </span>
          </button>
          {charterExpanded && (
            <div className="recruitment-proposal-body">
              <p className="recruitment-proposal-goal">
                {recruitmentProposal.goal}
              </p>
              <div className="recruitment-proposal-meta">
                <span>
                  <Users size={14} />
                  建议{' '}
                  {recruitmentProposal.size ||
                    recruitmentProposal.members.length}{' '}
                  位智能体
                </span>
                {recruitmentProposal.purpose && (
                  <span>{recruitmentProposal.purpose}</span>
                )}
              </div>
              <div className="recruitment-member-list">
                {recruitmentProposal.members.map((member) =>
                  (() => {
                    const skillNames = (member.skillIds || []).map(
                      (id) =>
                        data?.skillCatalog.find((skill) => skill.id === id)
                          ?.name || id,
                    );
                    const capabilityNames = (member.capabilityIds || []).map(
                      (id) =>
                        data?.capabilities.find(
                          (capability) => capability.id === id,
                        )?.name || id,
                    );
                    const reviewCapabilities = (member.capabilityIds || [])
                      .map((id) =>
                        data?.capabilities.find(
                          (capability) => capability.id === id,
                        ),
                      )
                      .filter(
                        (capability): capability is Capability =>
                          capability?.risk?.requiresReview === true,
                      );
                    const toolLabels = member.toolAccess
                      ? (
                          [
                            ['files', '文件'],
                            ['web', '网页'],
                            ['terminal', '终端'],
                          ] as const
                        )
                          .filter(
                            ([key]) => member.toolAccess?.[key] !== undefined,
                          )
                          .map(
                            ([key, label]) =>
                              `${label}${member.toolAccess?.[key] ? '已启用' : '未启用'}`,
                          )
                      : [];
                    return (
                      <div
                        className="recruitment-member"
                        key={
                          member.memberId || `${member.roleId}-${member.name}`
                        }
                      >
                        <div className="recruitment-member-index">
                          {(member.name || member.roleId || '成').slice(0, 1)}
                        </div>
                        <div className="recruitment-member-copy">
                          <strong>
                            {member.name || member.roleId || '未命名成员'}
                          </strong>
                          <p>{member.responsibility}</p>
                          {member.modelHint && (
                            <small>模型：{member.modelHint}</small>
                          )}
                          {!!member.deliverables?.length && (
                            <small>
                              交付：
                              {member.deliverables.slice(0, 2).join(' · ')}
                            </small>
                          )}
                          {!!member.skills?.length && (
                            <small>
                              技能说明：
                              {member.skills.slice(0, 3).join(' · ')}
                            </small>
                          )}
                          {!!skillNames.length && (
                            <small>
                              绑定 Skill：
                              {skillNames.slice(0, 3).join(' · ')}
                            </small>
                          )}
                          {!!member.tools?.length && (
                            <small>
                              工具说明：
                              {member.tools.slice(0, 3).join(' · ')}
                            </small>
                          )}
                          {!!capabilityNames.length && (
                            <small>
                              绑定能力：
                              {capabilityNames.slice(0, 3).join(' · ')}
                            </small>
                          )}
                          {!!reviewCapabilities.length && (
                            <div className="recruitment-capability-review">
                              <strong>中/高风险能力，需要你逐项确认</strong>
                              {reviewCapabilities.map((capability) => {
                                const key = `${member.memberId || member.roleId}:${capability.id}`;
                                const digest =
                                  capability.digest ||
                                  String(
                                    capability.revision ||
                                      `${capability.kind}:${capability.id}`,
                                  );
                                const approved =
                                  recruitmentApprovals[key]?.confirmed ===
                                    true &&
                                  recruitmentApprovals[key]?.digest === digest;
                                return (
                                  <label key={capability.id}>
                                    <input
                                      type="checkbox"
                                      checked={approved}
                                      onChange={(event) => {
                                        setRecruitmentApprovals((current) => {
                                          const next = { ...current };
                                          if (event.target.checked) {
                                            next[key] = {
                                              confirmed: true,
                                              digest,
                                              riskLevel:
                                                capability.risk?.level ||
                                                'unknown',
                                              confirmedAt:
                                                new Date().toISOString(),
                                            };
                                          } else {
                                            delete next[key];
                                          }
                                          return next;
                                        });
                                      }}
                                    />
                                    <span>
                                      确认「
                                      {capability.name || capability.id}
                                      」的 {capability.risk?.level || '中/高'}
                                      风险
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                          {member.toolAccess ? (
                            !!toolLabels.length && (
                              <small>工具权限：{toolLabels.join(' · ')}</small>
                            )
                          ) : (
                            <small>工具权限：沿用角色模板</small>
                          )}
                          {!!member.dependencies?.length && (
                            <small>
                              依赖：
                              {member.dependencies.slice(0, 2).join(' · ')}
                            </small>
                          )}
                        </div>
                      </div>
                    );
                  })(),
                )}
              </div>
              {!!recruitmentProposal.openQuestions?.length && (
                <div className="recruitment-open-questions">
                  <strong>还需要你确认</strong>
                  <ul>
                    {recruitmentProposal.openQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="recruitment-proposal-actions">
                {recruitment?.phase === 'confirmed' ? (
                  <span className="recruitment-confirmed">
                    <Check size={15} />
                    团队已创建，下一轮可以直接安排任务
                  </span>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      busy ||
                      (!recruitmentProposal.openQuestions?.length &&
                        !recruitmentReviewsComplete)
                    }
                    onClick={() => {
                      if (recruitmentProposal.openQuestions?.length) {
                        composerRef.current?.focus();
                        setNotice(
                          '请在下方输入框中补充或确认上述问题，或直接回复“按方案创建”',
                        );
                      } else {
                        void confirmTeamRecruitment();
                      }
                    }}
                  >
                    <Check size={16} />
                    {recruitmentProposal.openQuestions?.length
                      ? '先补充信息'
                      : '确认创建团队'}
                  </button>
                )}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => composerRef.current?.focus()}
                >
                  继续补充需求 <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      <div
        className="message-area"
        data-testid="message-area"
        ref={messageAreaRef}
      >
        {currentTasks.length === 0 ? (
          <div className="welcome">
            <div
              className="welcome-icon"
              style={
                {
                  '--role-color': assistant.color,
                } as React.CSSProperties
              }
            >
              <Icon size={31} />
            </div>
            <h2>
              {isRecruitmentView
                ? '发布你的需求'
                : assistant.greeting || assistantName}
            </h2>
            <p>
              {isRecruitmentView
                ? '描述要解决的问题、交付物和限制条件。项目经理会和你多轮澄清，再判断需要几个智能体以及每个智能体的职责。'
                : teamSpace?.memberSettings?.[role]?.responsibility ||
                  assistant.desc}
            </p>
            {!assistant.id && data && (
              <button
                className="primary-button"
                onClick={() => setEditingAssistant(blankAssistant)}
              >
                <Plus size={16} />
                新建助手
              </button>
            )}
            {assistant.archived && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(`roles/${role}/restore`, 'POST');
                  })
                }
              >
                <Undo2 size={16} />
                恢复助手
              </button>
            )}
            <div className="suggestions">
              {assistant.prompts.map((p, i) => (
                <button
                  key={p}
                  onClick={() =>
                    (() => {
                      markDraftDirty(draftKey);
                      setDrafts((d) => ({ ...d, [draftKey]: p }));
                    })()
                  }
                >
                  <span>0{i + 1}</span>
                  {p}
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          currentTasks.map((task) => (
            <article className="turn" key={task.id}>
              <div className="user-message">
                <span className="message-label">
                  你 <small>{formatTime(task.createdAt)}</small>
                </span>
                <p>{task.prompt}</p>
                {!!task.attachments?.length && (
                  <div className="attachment-list" aria-label="任务附件">
                    {task.attachments.map((attachment) => (
                      <span className="attachment-chip" key={attachment.id}>
                        <Paperclip size={13} />
                        {attachment.name}
                        <small>{formatBytes(attachment.size)}</small>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="assistant-message">
                <div className="message-label">
                  <span
                    className="mini-role"
                    style={{ background: assistant.color }}
                  >
                    <Icon size={13} />
                  </span>
                  {assistantName}
                  <span className={`status ${task.status}`}>
                    {statusLabels[task.status]}
                  </span>
                </div>
                {task.sourceTaskId && (
                  <span className="handoff-label">
                    <Workflow size={14} />
                    从其他助手交接的任务
                  </span>
                )}
                {task.result ? (
                  <div className="prose-result">
                    <Markdown>{task.result}</Markdown>
                  </div>
                ) : isActive(task) ? (
                  <div className="working-message">
                    <LoaderCircle size={16} className="spin" />
                    {task.status === 'queued'
                      ? '任务已排队，轮到后自动开始。'
                      : '正在处理，你可以切换到其他助手。'}
                  </div>
                ) : null}
                {task.error && <p className="task-error">{task.error}</p>}
                <div className="message-actions">
                  <button onClick={() => setTaskDetail(task)}>
                    <Terminal size={14} />
                    执行记录
                  </button>
                  {task.result && (
                    <>
                      <button onClick={() => openKnowledge(task)}>
                        <ArrowDownToLine size={14} />
                        存入知识库
                      </button>
                      <button
                        disabled={!activeRoles.some((r) => r.id !== task.role)}
                        onClick={() => openHandoff(task)}
                      >
                        <Workflow size={14} />
                        交给其他助手
                      </button>
                    </>
                  )}
                  {isActive(task) && (
                    <button
                      onClick={() =>
                        action(async () => {
                          await api(`tasks/${task.id}/cancel`, 'POST');
                        })
                      }
                    >
                      <Square size={12} />
                      停止
                    </button>
                  )}
                  {['failed', 'interrupted', 'cancelled'].includes(
                    task.status,
                  ) && (
                    <button
                      onClick={() =>
                        action(async () => {
                          await api(`tasks/${task.id}/retry`, 'POST');
                        })
                      }
                    >
                      重试
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))
        )}
        <div ref={endRef} />
      </div>
      {showJumpToLatest && (
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
      <ConversationComposer context={context} />
    </section>
  );
}
