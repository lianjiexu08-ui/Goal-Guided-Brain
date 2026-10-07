/* oxlint-disable */
// @ts-nocheck
'use client';
// Focused presentation modules receive a controller context assembled by Workbench.
/* oxlint-disable no-explicit-any, no-unused-vars */
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
import { formatTime, isActive, taskNeedsOwnerAction } from './model';

import { ConversationPane } from './conversation-pane';

export function RouteContent({ context }: { context: WorkbenchContext }) {
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
    archiveTeam,
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
    teamActivityRevision,
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
  const openKnowledgeById = (knowledgeId: string) => {
    const item = knowledge.find((entry) => entry.id === knowledgeId);
    if (item) {
      openKnowledge(undefined, item);
      return;
    }
    void api(`knowledge/${encodeURIComponent(knowledgeId)}`)
      .then((remote) => openKnowledge(undefined, remote))
      .catch(() => undefined);
  };
  return (
    <>
      {managementNavigation.some((item) => item.id === view) ? (
        <Management
          key={view}
          view={view}
          onChanged={refresh}
          onOpenTeam={openRiskTeam}
          onOpenTask={openRiskTask}
          onOpenKnowledge={openKnowledgeById}
        />
      ) : view === 'team' ? (
        <TeamActivity
          teamSpace={teamSpace}
          confirmedSpaces={confirmedSpaces}
          busy={busy}
          activeRoles={activeRoles}
          selectTeam={selectTeam}
          openCreateTeam={openCreateTeam}
          startRecruitment={startRecruitment}
          openSaveTeamTemplate={openSaveTeamTemplate}
          openTeamRename={openTeamRename}
          openTeamSettings={openTeamSettings}
          toggleTeamAutonomy={toggleTeamAutonomy}
          archiveTeam={archiveTeam}
          rosterReady={rosterReady}
          teamMembers={teamMembers}
          recruitment={recruitment}
          openRiskTeam={openRiskTeam}
          openRiskTask={openRiskTask}
          openPlanTask={(id) => {
            const task = tasks.find((item) => item.id === id);
            if (task) setTaskDetail(task);
          }}
          tasks={tasks}
          refresh={refresh}
          projectManager={projectManager}
          teamTasks={teamTasks}
          isActive={isActive}
          renderTeamTimelineItem={renderTeamTimelineItem}
          teamActivityRevision={teamActivityRevision}
          openTeamConversation={openTeamConversation}
          setRole={setRole}
          setView={setView}
          teamOpenTasks={teamOpenTasks}
          teamReviewTasks={teamReviewTasks}
          teamRiskTasks={teamRiskTasks}
          teamEvidenceCount={teamEvidenceCount}
          setTaskFilter={setTaskFilter}
        />
      ) : isRecruitmentView && !teamSpace ? (
        <section className="empty-state" aria-label="开始团队招募">
          <h1>发布需求，招募团队</h1>
          <p>先和项目经理澄清目标、交付物与约束，确认方案后再组建团队。</p>
          <button
            className="primary-button"
            disabled={busy || !activeRoles.length}
            onClick={() => void startRecruitment(true)}
          >
            {busy ? '正在创建需求草稿…' : '开始发布需求'}
          </button>
        </section>
      ) : isConversationView ? (
        <ConversationPane context={context} />
      ) : view === 'assistants' ? (
        <main className="collection-page assistant-management">
          <div className="page-heading">
            <div>
              <span className="section-kicker">ASSISTANTS</span>
              <h1>我的助手</h1>
              <p>
                {activeRoles.length} 个可用 ·{' '}
                {roles.filter((r) => r.archived).length} 个已归档
              </p>
            </div>
            <button
              className="primary-button"
              disabled={!data}
              onClick={() => setEditingAssistant(blankAssistant)}
            >
              <Plus size={16} />
              新建助手
            </button>
          </div>
          <fieldset className="editor-tabs" aria-label="助手状态">
            <button
              aria-pressed={!showArchived}
              onClick={() => setShowArchived(false)}
            >
              可用助手
            </button>
            <button
              aria-pressed={showArchived}
              onClick={() => setShowArchived(true)}
            >
              已归档
            </button>
          </fieldset>
          <div className="assistant-list">
            {roles
              .filter((r) => r.archived === showArchived)
              .map((r) => {
                const RIcon =
                  assistantIcons[r.icon as keyof typeof assistantIcons] ||
                  Sparkles;
                const active = tasks.some(
                  (t) => t.role === r.id && isActive(t),
                );
                return (
                  <div className="assistant-row" key={r.id}>
                    <button
                      className="assistant-row-main"
                      onClick={() => {
                        setRole(r.id);
                        setView('workspace');
                      }}
                    >
                      <span
                        className="assistant-avatar"
                        style={{ color: r.color, background: `${r.color}14` }}
                      >
                        <RIcon size={22} />
                      </span>
                      <div>
                        <strong>{r.name}</strong>
                        <p>{r.desc || '暂无简介'}</p>
                        <small>
                          {r.model || '跟随工作空间模型'} ·{' '}
                          {r.tools.terminal ? '终端已启用' : '终端未启用'}
                        </small>
                      </div>
                    </button>
                    <div className="assistant-row-actions">
                      <button
                        className="icon-button"
                        title="编辑助手"
                        aria-label={`编辑${r.name}`}
                        onClick={() => setEditingAssistant(r)}
                      >
                        <Pencil size={17} />
                      </button>
                      <button
                        className="icon-button"
                        title="复制助手"
                        aria-label={`复制${r.name}`}
                        onClick={() =>
                          setEditingAssistant({
                            ...r,
                            id: '',
                            name: `${r.name.slice(0, 38)}副本`,
                            archived: false,
                          })
                        }
                      >
                        <Copy size={17} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy || active}
                        title={
                          active
                            ? '请先完成或停止任务'
                            : r.archived
                              ? '恢复助手'
                              : '归档助手'
                        }
                        aria-label={`${r.archived ? '恢复' : '归档'}${r.name}`}
                        onClick={() =>
                          action(async () => {
                            await api(
                              `roles/${r.id}/${r.archived ? 'restore' : 'archive'}`,
                              'POST',
                            );
                            setNotice(
                              r.archived
                                ? '助手已恢复'
                                : '助手已归档，历史记录已保留',
                            );
                          })
                        }
                      >
                        {r.archived ? (
                          <Undo2 size={17} />
                        ) : (
                          <Archive size={17} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            {!roles.some((r) => r.archived === showArchived) && (
              <div className="collection-empty">
                <Sparkles size={28} />
                <h2>{showArchived ? '暂无归档助手' : '暂无助手'}</h2>
                {!showArchived && (
                  <button
                    className="primary-button"
                    onClick={() => setEditingAssistant(blankAssistant)}
                  >
                    <Plus size={16} />
                    新建助手
                  </button>
                )}
              </div>
            )}
          </div>
        </main>
      ) : view === 'tasks' ? (
        <main className="collection-page">
          <div className="page-heading">
            <div>
              <span className="section-kicker">BACKGROUND TASKS</span>
              <h1>让工作持续推进。</h1>
              <p>{tasks.length} 个任务</p>
            </div>
            <div className="page-heading-pills">
              <span className="count-pill">{running.length} 个进行中</span>
              {reviewTasks.length > 0 && (
                <span className="count-pill needs-review">
                  {reviewTasks.length} 项待处理
                </span>
              )}
            </div>
          </div>
          <RiskInbox
            teams={confirmedSpaces}
            onOpenTeam={openRiskTeam}
            onOpenTask={openRiskTask}
            onOpenKnowledge={openKnowledgeById}
          />
          <Tabs
            value={taskFilter}
            onValueChange={(v) => setTaskFilter(String(v))}
          >
            <TabsList variant="line">
              <TabsTrigger value="all">
                全部任务 <span>{tasks.length}</span>
              </TabsTrigger>
              <TabsTrigger value="active">
                进行中 <span>{running.length}</span>
              </TabsTrigger>
              <TabsTrigger value="review">
                待处理 <span>{reviewTasks.length}</span>
              </TabsTrigger>
              <TabsTrigger value="done">已完成</TabsTrigger>
            </TabsList>
            {['all', 'active', 'review', 'done'].map((filter) => (
              <TabsContent key={filter} value={filter}>
                {filter === 'review' && reviewTasks.length > 0 && (
                  <div
                    className="batch-review-toolbar"
                    aria-label="批量交付复核"
                  >
                    <div className="batch-review-toolbar-head">
                      <button
                        type="button"
                        className="batch-review-select"
                        onClick={toggleAllReviewTasks}
                        disabled={batchReviewBusy}
                      >
                        {allReviewTasksSelected ? '取消全选' : '全选待处理'}
                      </button>
                      <span>
                        已选 {selectedReviewTaskIds.length} /{' '}
                        {reviewTasks.length} 项
                      </span>
                    </div>
                    <div className="batch-review-actions">
                      <textarea
                        aria-label="批量复核说明"
                        value={batchReviewNote}
                        onChange={(event) =>
                          setBatchReviewNote(event.target.value)
                        }
                        placeholder="退回复核时填写统一的修改说明；通过交付可选填备注。"
                        rows={2}
                        disabled={batchReviewBusy}
                      />
                      <div className="batch-review-buttons">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            batchReviewBusy ||
                            selectedReviewTaskIds.length === 0
                          }
                          onClick={() => void batchReview('reject')}
                        >
                          {batchReviewBusy ? '处理中…' : '批量退回复核'}
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={
                            batchReviewBusy ||
                            selectedReviewTaskIds.length === 0
                          }
                          onClick={() => void batchReview('accept')}
                        >
                          {batchReviewBusy ? '处理中…' : '批量通过交付'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="task-list">
                  {tasks
                    .filter(
                      (t) =>
                        filter === 'all' ||
                        (filter === 'active'
                          ? isActive(t)
                          : filter === 'review'
                            ? taskNeedsOwnerAction(t)
                            : t.status === 'completed'),
                    )
                    .map(filter === 'review' ? reviewTaskCard : taskCard)}
                </div>
                {!tasks.some(
                  (t) =>
                    filter === 'all' ||
                    (filter === 'active'
                      ? isActive(t)
                      : filter === 'review'
                        ? taskNeedsOwnerAction(t)
                        : t.status === 'completed'),
                ) && (
                  <div className="collection-empty">
                    <Workflow size={34} />
                    <h2>这里会记录工作的每一步</h2>
                    <p>向任一助手发送任务，即可在此查看进度。</p>
                    <button
                      className="primary-button"
                      onClick={() => setView('workspace')}
                    >
                      开始一个任务 <ArrowRight size={16} />
                    </button>
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </main>
      ) : (
        <KnowledgeCollection
          knowledge={data?.knowledge || []}
          roles={roles}
          workspace={data?.config.workspace}
          team={teamSpace ? { id: teamSpace.id, name: teamSpace.name } : null}
          search={knowledgeSearch}
          filterScope={knowledgeFilterScope}
          onSearchChange={setKnowledgeSearch}
          onFilterScopeChange={setKnowledgeFilterScope}
          onAdd={() => openKnowledge()}
          onOpen={(item) => openKnowledge(undefined, item)}
          onRename={(item) => {
            setQuickRenameKnowledge(item);
            setQuickRenameTitle(item.title);
          }}
          onDelete={(item) => setKnowledgeToDelete(item)}
          formatTime={formatTime}
        />
      )}
    </>
  );
}
