/* oxlint-disable */
// @ts-nocheck
'use client';
// Focused presentation modules receive a controller context assembled by Workbench.
/* oxlint-disable no-explicit-any, no-unused-vars */
import Markdown from 'react-markdown';
import { ExecutionCheck } from './execution-check';
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

export function WorkbenchDialogGeneral({
  context,
}: {
  context: WorkbenchContext;
}) {
  const {
    endRef,
    composerRef,
    attachmentInputRef,
    roles,
    activeRoles,
    teamTemplates,
    assistant,
    Icon,
    tasks,
    reviewTasks,
    actionableNotificationCount,
    allReviewTasksSelected,
    spaces,
    confirmedSpaces,
    mobileTeamMatches,
    recruitmentSpaces,
    recruitmentSpace,
    teamSpace,
    isRecruitmentView,
    isConversationView,
    isTeamConversation,
    assistantName,
    running,
    rosterReady,
    teamMembers,
    teamTasks,
    teamOpenTasks,
    teamReviewTasks,
    teamRiskTasks,
    teamEvidenceCount,
    projectManager,
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
    mobileContextTitle,
    mobileContextDetail,
    isMoreView,
    sessions,
    sessionSelectionKey,
    currentSession,
    conversationWorkspace,
    currentTasks,
    selectedModelOption,
    boundCapabilities,
    knowledge,
    refresh,
    action,
    toggleAllReviewTasks,
    batchReview,
    uploadAttachments,
    clipboardFiles,
    submit,
    changeTeamModel,
    confirmTeamRecruitment,
    openSettings,
    dismissMobileInput,
    openMobileSwitcher,
    openKnowledge,
    openHandoff,
    openTeamRename,
    openTeamSettings,
    toggleTeamAutonomy,
    openSaveTeamTemplate,
    openCreateTeam,
    startRecruitment,
    openTeamConversation,
    openTeamOverview,
    selectTeam,
    showTask,
    openRiskTeam,
    openRiskTask,
    handoffRoles,
    editRole,
    renderTeamTimelineItem,
    taskCard,
    reviewTaskCard,
    isMobile,
    setOpenMobile,
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
    setRole,
    view,
    setView,
    data,
    connectionError,
    setSelected,
    selectedSpaceId,
    setSelectedSpaceId,
    draggingFiles,
    setDraggingFiles,
    busy,
    notice,
    setNotice,
    modal,
    setModal,
    teamRenameForm,
    setTeamRenameForm,
    teamTemplateForm,
    setTeamTemplateForm,
    mobileTeamQuery,
    setMobileTeamQuery,
    editingTeamId,
    teamTemplateId,
    teamForm,
    setTeamForm,
    taskDetail,
    setTaskDetail,
    handoffTask,
    handoffRole,
    setHandoffRole,
    handoffNote,
    setHandoffNote,
    knowledgeForm,
    setKnowledgeForm,
    knowledgeSearch,
    setKnowledgeSearch,
    knowledgeFilterScope,
    setKnowledgeFilterScope,
    quickRenameKnowledge,
    setQuickRenameKnowledge,
    quickRenameTitle,
    setQuickRenameTitle,
    knowledgeToDelete,
    setKnowledgeToDelete,
    knowledgeHistory,
    setKnowledgeHistory,
    deletingKnowledge,
    setDeletingKnowledge,
    settingsForm,
    setSettingsForm,
    profileForm,
    setProfileForm,
    editingAssistant,
    setEditingAssistant,
    showArchived,
    setShowArchived,
    taskFilter,
    setTaskFilter,
    selectedReviewTaskIds,
    batchReviewNote,
    setBatchReviewNote,
    batchReviewBusy,
    setExpandedCharters,
    recruitmentApprovals,
    setRecruitmentApprovals,
    recruitmentSyncState,
  } = context;
  return (
    <>
      {modal === 'settings' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api('settings', 'PUT', settingsForm);
              await api('profile', 'PUT', profileForm);
              setModal(null);
              setNotice('工作空间和个人偏好已保存');
            });
          }}
        >
          <label>
            工作目录
            <input
              required
              value={settingsForm.workspace}
              onChange={(e) =>
                setSettingsForm((f) => ({
                  ...f,
                  workspace: e.target.value,
                }))
              }
              placeholder="/Users/你的用户名/Projects/项目"
            />
          </label>
          <ExecutionCheck workspace={settingsForm.workspace} />
          <label>
            模型
            <input
              required
              value={settingsForm.model}
              onChange={(e) =>
                setSettingsForm((f) => ({ ...f, model: e.target.value }))
              }
            />
          </label>
          <div className="form-grid two">
            <label>
              称呼
              <input
                value={profileForm.name}
                onChange={(e) =>
                  setProfileForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="例如：老板"
              />
            </label>
            <label>
              时区
              <input
                value={profileForm.timezone}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    timezone: e.target.value,
                  }))
                }
                placeholder="Asia/Shanghai"
              />
            </label>
          </div>
          <div className="form-grid two">
            <label>
              语气
              <select
                value={profileForm.tone}
                onChange={(e) =>
                  setProfileForm((f) => ({ ...f, tone: e.target.value }))
                }
              >
                <option value="direct">直接</option>
                <option value="friendly">友好</option>
                <option value="formal">正式</option>
              </select>
            </label>
            <label>
              详细程度
              <select
                value={profileForm.verbosity}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    verbosity: e.target.value,
                  }))
                }
              >
                <option value="concise">简洁</option>
                <option value="balanced">平衡</option>
                <option value="detailed">详细</option>
              </select>
            </label>
          </div>
          <label>
            工作习惯
            <textarea
              value={profileForm.habits.join('\n')}
              onChange={(e) =>
                setProfileForm((f) => ({
                  ...f,
                  habits: e.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="每行一条，例如：先给结论，再给证据。"
              rows={3}
            />
          </label>
          <label>
            长期规则
            <textarea
              value={profileForm.rules.join('\n')}
              onChange={(e) =>
                setProfileForm((f) => ({
                  ...f,
                  rules: e.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="每行一条，例如：没有执行过的操作不能声称已完成。"
              rows={3}
            />
          </label>
          <label>
            补充说明
            <textarea
              value={profileForm.instructions}
              onChange={(e) =>
                setProfileForm((f) => ({
                  ...f,
                  instructions: e.target.value,
                }))
              }
              placeholder="描述你希望智能体长期遵循的协作方式"
              rows={4}
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            保存设置和个人偏好
          </button>
        </form>
      )}
      {modal === 'mobile-switcher' && (
        <div className="mobile-switcher-panel" aria-label="手机端快速切换工作">
          <div className="mobile-switcher-section">
            <span className="mobile-switcher-label">需求发布</span>
            <button
              type="button"
              className={`mobile-switcher-option${isRecruitmentView ? ' active' : ''}`}
              onClick={() => {
                if (recruitmentSpace) selectTeam(recruitmentSpace.id);
                else void startRecruitment();
                setView('recruitment');
                setModal(null);
              }}
            >
              <MessageSquare size={17} />
              <span>
                <strong>团队招募</strong>
                <small>发布需求、澄清目标并生成团队方案</small>
              </span>
              {isRecruitmentView && <Check size={17} />}
            </button>
            <button
              type="button"
              className="mobile-switcher-option"
              onClick={() => {
                setModal(null);
                void startRecruitment(true);
              }}
            >
              <Plus size={17} />
              <span>
                <strong>另起一个需求</strong>
                <small>创建独立的需求草稿，不影响已有团队</small>
              </span>
            </button>
          </div>
          <div className="mobile-switcher-section">
            <span className="mobile-switcher-label">我的团队</span>
            {confirmedSpaces.length > 0 && (
              <label className="mobile-switcher-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="搜索我的团队"
                  placeholder="搜索团队名称或职责"
                  value={mobileTeamQuery}
                  onChange={(event) => setMobileTeamQuery(event.target.value)}
                  enterKeyHint="search"
                />
                {mobileTeamQuery && (
                  <button
                    type="button"
                    className="mobile-switcher-search-clear"
                    aria-label="清除团队搜索"
                    onClick={() => setMobileTeamQuery('')}
                  >
                    <X size={15} />
                  </button>
                )}
              </label>
            )}
            {mobileTeamMatches.length > 0 ? (
              mobileTeamMatches.map((space) => (
                <button
                  type="button"
                  className={`mobile-switcher-option${selectedSpaceId === space.id && isConversationView ? ' active' : ''}`}
                  key={space.id}
                  onClick={() => {
                    selectTeam(space.id);
                    setView('workspace');
                    setModal(null);
                  }}
                >
                  <Users size={17} />
                  <span>
                    <strong>{space.name}</strong>
                    <small>{space.goal || '打开团队工作空间'}</small>
                  </span>
                  {Number(data?.teamRiskCounts?.[space.id] || 0) > 0 && (
                    <b
                      className="mobile-switcher-badge"
                      aria-label={`${data?.teamRiskCounts?.[space.id]} 项待处理`}
                    >
                      {Number(data?.teamRiskCounts?.[space.id] || 0) > 9
                        ? '9+'
                        : data?.teamRiskCounts?.[space.id]}
                    </b>
                  )}
                  {selectedSpaceId === space.id && isConversationView && (
                    <Check size={17} />
                  )}
                </button>
              ))
            ) : confirmedSpaces.length > 0 ? (
              <p className="mobile-switcher-empty">
                没有匹配的团队，试试团队名称或职责关键词。
              </p>
            ) : (
              <p className="mobile-switcher-empty">
                确认团队招募方案后，团队会显示在这里。
              </p>
            )}
          </div>
          <button
            type="button"
            className="mobile-switcher-all"
            onClick={() => {
              setModal(null);
              setOpenMobile(true);
            }}
          >
            打开完整工作空间导航 <ArrowRight size={15} />
          </button>
        </div>
      )}
      {modal === 'knowledge' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api(
                knowledgeForm.id
                  ? `knowledge/${knowledgeForm.id}`
                  : 'knowledge',
                knowledgeForm.id ? 'PUT' : 'POST',
                knowledgeForm,
              );
              setModal(null);
              setNotice('知识已保存');
            });
          }}
        >
          <label>
            标题
            <input
              required
              value={knowledgeForm.title || ''}
              onChange={(e) =>
                setKnowledgeForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </label>
          <div className="form-columns">
            <div className="field-label">
              可用范围
              <Choice
                label="知识可用范围"
                value={knowledgeForm.scope || 'project'}
                onChange={(scope) =>
                  setKnowledgeForm((f) => ({
                    ...f,
                    scope,
                    teamId:
                      scope === 'team'
                        ? f.teamId || teamSpace?.id || null
                        : null,
                  }))
                }
                options={[
                  { value: 'personal', label: '个人 · 所有项目' },
                  { value: 'project', label: '项目 · 所有助手共享' },
                  ...(teamSpace
                    ? [
                        {
                          value: 'team',
                          label: `${teamSpace.name} · 团队成员共享`,
                        },
                      ]
                    : []),
                  ...roles.map((r) => ({
                    value: r.id,
                    label: `${r.name}专属`,
                  })),
                ]}
              />
            </div>
            <div className="field-label">
              可信状态
              <Choice
                label="知识可信状态"
                value={knowledgeForm.state || 'draft'}
                onChange={(state) => setKnowledgeForm((f) => ({ ...f, state }))}
                options={[
                  { value: 'draft', label: '草稿 · 待确认' },
                  { value: 'confirmed', label: '已确认' },
                ]}
              />
            </div>
          </div>
          <label>
            内容
            <textarea
              rows={9}
              required
              value={knowledgeForm.content || ''}
              onChange={(e) =>
                setKnowledgeForm((f) => ({ ...f, content: e.target.value }))
              }
            />
          </label>
          <label>
            来源
            <input
              value={knowledgeForm.source || ''}
              onChange={(e) =>
                setKnowledgeForm((f) => ({ ...f, source: e.target.value }))
              }
            />
          </label>
          <label>
            复核截止日期
            <input
              type="date"
              value={
                knowledgeForm.expiresAt
                  ? knowledgeForm.expiresAt.slice(0, 10)
                  : ''
              }
              onChange={(e) =>
                setKnowledgeForm((f) => ({
                  ...f,
                  expiresAt: e.target.value
                    ? `${e.target.value}T23:59:59.999Z`
                    : null,
                }))
              }
            />
            <small className="field-help">
              到期后保留在知识库和版本历史中，但不会再自动注入新任务；留空表示长期有效。
            </small>
          </label>
          <div className="manage-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              <Check size={16} />
              保存知识
            </button>
            {knowledgeForm.id && (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const id = knowledgeForm.id!;
                      const result = await api<Entity[] | { items: Entity[] }>(
                        `knowledge/${id}/history`,
                      );
                      setKnowledgeHistory({
                        id,
                        items: entityList(
                          Array.isArray(result) ? result : result.items,
                        ),
                      });
                    })
                  }
                >
                  <History size={16} />
                  版本历史
                </button>
                <button
                  className="icon-button"
                  type="button"
                  title="删除知识"
                  aria-label="删除知识"
                  disabled={busy}
                  onClick={() => setDeletingKnowledge(true)}
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </div>
          {deletingKnowledge && (
            <div className="manage-error" role="alert">
              <span>删除“{knowledgeForm.title}”？</span>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setDeletingKnowledge(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(`knowledge/${knowledgeForm.id}`, 'DELETE');
                    setModal(null);
                    setNotice('知识已删除');
                  })
                }
              >
                <Trash2 size={15} />
                确认删除
              </button>
            </div>
          )}
          {knowledgeHistory && knowledgeHistory.id === knowledgeForm.id && (
            <div className="manage-detail">
              <h3>版本历史</h3>
              {knowledgeHistory.items.length ? (
                knowledgeHistory.items.map((entry, index) => {
                  const snapshot =
                    typeof entry.snapshot === 'object' &&
                    entry.snapshot !== null
                      ? (entry.snapshot as Entity)
                      : entry;
                  return (
                    <details key={entry.id || index}>
                      <summary>
                        {entityText(
                          entry,
                          'version',
                          String(knowledgeHistory.items.length - index),
                        )}{' '}
                        ·{' '}
                        {formatTime(
                          entityText(entry, 'createdAt') ||
                            entityText(entry, 'updatedAt') ||
                            entityText(snapshot, 'updatedAt'),
                        )}
                      </summary>
                      <div className="history-item-header">
                        <div>
                          <h3>{entityText(snapshot, 'title')}</h3>
                          <p>{entityText(snapshot, 'source')}</p>
                        </div>
                        <button
                          type="button"
                          className="secondary-button compact-btn"
                          title="将此版本内容恢复至上方表单"
                          onClick={() => {
                            const restoredTitle = entityText(snapshot, 'title');
                            const restoredContent = entityText(
                              snapshot,
                              'content',
                            );
                            const restoredSource = entityText(
                              snapshot,
                              'source',
                            );
                            const restoredScope = entityText(snapshot, 'scope');
                            const restoredState = entityText(snapshot, 'state');
                            setKnowledgeForm((f) => ({
                              ...f,
                              title: restoredTitle || f.title,
                              content: restoredContent || f.content,
                              source: restoredSource || f.source,
                              scope: restoredScope || f.scope,
                              state: restoredState || f.state,
                            }));
                            setNotice(
                              '已恢复历史版本到表单，点击“保存知识”生效',
                            );
                          }}
                        >
                          <Undo2 size={13} />
                          恢复此版本
                        </button>
                      </div>
                      <pre>{entityText(snapshot, 'content')}</pre>
                    </details>
                  );
                })
              ) : (
                <p>暂无历史版本</p>
              )}
            </div>
          )}
        </form>
      )}
      {modal === 'handoff' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const t = await api<Task>(
                `tasks/${handoffTask!.id}/handoff`,
                'POST',
                { role: handoffRole, note: handoffNote },
              );
              setModal(null);
              showTask(t);
              setNotice('任务已交接');
            });
          }}
        >
          <div className="handoff-source">
            <FileText size={18} />
            <span>{handoffTask?.title}</span>
          </div>
          <div className="field-label">
            交给
            <Choice
              label="接收助手"
              value={handoffRole}
              onChange={setHandoffRole}
              options={handoffRoles(handoffTask).map((r) => ({
                value: r.id,
                label: r.name,
              }))}
            />
          </div>
          <label>
            接下来要做什么
            <textarea
              rows={5}
              value={handoffNote}
              onChange={(e) => setHandoffNote(e.target.value)}
              placeholder="例如：根据这份需求完成第一版，并运行测试。"
              required
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !handoffRole}
          >
            创建交接任务 <ArrowRight size={16} />
          </button>
        </form>
      )}
      {modal === 'team-template' && (
        <form
          id="team-template-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!teamSpace) return;
            void action(async () => {
              await api<TeamTemplate>('team-templates', 'POST', {
                sourceTeamId: teamSpace.id,
                name: teamTemplateForm.name.trim(),
                description: teamTemplateForm.description.trim(),
              });
              await refresh();
              setModal(null);
              setNotice(`团队“${teamSpace.name}”已保存为模板`);
            });
          }}
        >
          <label>
            模板名称
            <input
              required
              maxLength={80}
              value={teamTemplateForm.name}
              onChange={(e) =>
                setTeamTemplateForm((form) => ({
                  ...form,
                  name: e.target.value,
                }))
              }
              placeholder="例如：标准研发交付团队"
            />
          </label>
          <label>
            模板说明
            <textarea
              rows={3}
              maxLength={2000}
              value={teamTemplateForm.description}
              onChange={(e) =>
                setTeamTemplateForm((form) => ({
                  ...form,
                  description: e.target.value,
                }))
              }
              placeholder="说明适用的工作类型、成员组合和交付边界。"
            />
          </label>
          <p className="team-template-boundary">
            会保存成员职责、成员模型/能力、团队模型、自治模式和执行目录模式；不会复制历史消息、任务、招募会话、草稿、附件或原团队协作白名单。
          </p>
        </form>
      )}
      {modal === 'team-template' && (
        <div className="team-template-actions">
          <button
            className="primary-button"
            type="submit"
            form="team-template-form"
            disabled={busy || !teamSpace}
          >
            <Copy size={15} /> 保存模板
          </button>
        </div>
      )}
      {modal === 'rename-team' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const saved = await api<TeamSpace>(
                `spaces/${teamSpace!.id}`,
                'PUT',
                { name: teamRenameForm.name.trim() },
              );
              setModal(null);
              setNotice(`团队已重命名为“${saved.name}”`);
            });
          }}
        >
          <label>
            团队名称
            <input
              required
              maxLength={80}
              value={teamRenameForm.name}
              onChange={(e) => setTeamRenameForm({ name: e.target.value })}
              placeholder="例如：产品开发组、线上运维组"
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !teamSpace}
          >
            保存名称
          </button>
        </form>
      )}
    </>
  );
}
