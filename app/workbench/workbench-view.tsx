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
import { formatTime } from './model';
import { WorkbenchSidebar } from './workbench-sidebar';
import { RouteContent } from './route-content';
import { TransientOverlays } from './transient-overlays';
import { WorkbenchMainDialog } from './workbench-main-dialog';

export function WorkbenchView({ context }: { context: WorkbenchContext }) {
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
    teamTimeline,
    teamTimelineHasMore,
    teamTasks,
    timelineItems,
    visibleTeamTimeline,
    timelineFilterOptions,
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
    loadOlderTeamTimeline,
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
    timelineFilter,
    setTimelineFilter,
    timelineLoading,
    setExpandedCharters,
    recruitmentApprovals,
    setRecruitmentApprovals,
    recruitmentSyncState,
  } = context;
  return (
    <>
      <WorkbenchSidebar context={context} />
      <div className="workspace-shell">
        <header className="topbar">
          <div>
            <SidebarTrigger className="mobile-menu" />
            <span className="breadcrumb">工作空间</span>
            <span className="slash">/</span>
            <strong>
              {isConversationView
                ? isRecruitmentView
                  ? '需求发布'
                  : isTeamConversation
                    ? '团队对话'
                    : assistantName
                : view === 'tasks'
                  ? '后台任务'
                  : view === 'assistants'
                    ? '管理助手'
                    : view === 'team'
                      ? '团队动态'
                      : managementNavigation.find((item) => item.id === view)
                          ?.label || '知识库'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${connectionError ? 'offline' : ''}`}>
              <span className="live-dot" />
              {connectionError ? '服务未连接' : '服务已连接'}
            </span>
            <button
              className="icon-button"
              aria-label="打开设置"
              onClick={openSettings}
            >
              <Settings2 size={19} />
            </button>
          </div>
        </header>
        {isMobile && (
          <div className="mobile-context-bar" data-testid="mobile-context-bar">
            <div className="mobile-context-copy">
              <span>当前工作</span>
              <strong title={mobileContextTitle}>{mobileContextTitle}</strong>
              <small title={mobileContextDetail}>{mobileContextDetail}</small>
            </div>
            <button
              type="button"
              className="mobile-context-switch"
              aria-label="切换团队和工作空间"
              onClick={openMobileSwitcher}
            >
              切换
            </button>
          </div>
        )}
        {connectionError && (
          <div className="error-banner">
            无法连接工作台服务。请确认服务正在运行。
            <button onClick={refresh}>重试</button>
          </div>
        )}
        {data && !data.config.hasApiKey && isConversationView && (
          <div className="setup-banner">
            <Sparkles size={17} />
            <span>尚未配置可用模型。</span>
            <button onClick={() => setView('models')}>
              配置模型 <ArrowRight size={14} />
            </button>
          </div>
        )}
        <RouteContent context={context} />
      </div>
      <TransientOverlays context={context} />{' '}
      <WorkbenchMainDialog context={context} />
      <Dialog
        open={!!taskDetail}
        onOpenChange={(open) => !open && setTaskDetail(null)}
      >
        <DialogContent className="work-dialog">
          <DialogTitle>执行记录</DialogTitle>
          <DialogDescription>{taskDetail?.title}</DialogDescription>
          {taskDetail && (
            <ExecutionInspector key={taskDetail.id} taskId={taskDetail.id} />
          )}
          <pre className="execution-log">
            {taskDetail?.log || '暂无执行记录。'}
          </pre>
          {taskDetail && (
            <p className="field-help">
              已引用知识：
              {taskDetail.knowledgeRefs?.length
                ? taskDetail.knowledgeRefs
                    .map((ref) => {
                      const title =
                        data?.knowledge.find((item) => item.id === ref.id)
                          ?.title || ref.id;
                      return `${title} v${ref.version}${ref.source ? ` · ${ref.source}` : ''}`;
                    })
                    .join('、')
                : (taskDetail.knowledgeIds || [])
                    .map(
                      (id) =>
                        data?.knowledge.find((k) => k.id === id)?.title || id,
                    )
                    .join('、') || '无'}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={quickRenameKnowledge !== null}
        onOpenChange={(open) => !open && setQuickRenameKnowledge(null)}
      >
        <DialogContent className="work-dialog">
          <DialogTitle>重命名知识</DialogTitle>
          <DialogDescription>修改知识标题，保存后立即生效。</DialogDescription>
          {quickRenameKnowledge && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!quickRenameTitle.trim()) return;
                void action(async () => {
                  await api(`knowledge/${quickRenameKnowledge.id}`, 'PUT', {
                    ...quickRenameKnowledge,
                    title: quickRenameTitle.trim(),
                  });
                  setQuickRenameKnowledge(null);
                  setNotice('知识已重命名');
                });
              }}
            >
              <label>
                知识标题
                <input
                  required
                  maxLength={160}
                  value={quickRenameTitle}
                  onChange={(e) => setQuickRenameTitle(e.target.value)}
                  placeholder="输入新的知识标题"
                />
              </label>
              <div className="manage-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setQuickRenameKnowledge(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || !quickRenameTitle.trim()}
                >
                  <Check size={16} /> 保存名称
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={knowledgeToDelete !== null}
        onOpenChange={(open) => !open && setKnowledgeToDelete(null)}
      >
        <DialogContent className="work-dialog">
          <DialogTitle>删除知识</DialogTitle>
          <DialogDescription>
            确认要删除知识“{knowledgeToDelete?.title}”吗？此操作不可逆。
          </DialogDescription>
          {knowledgeToDelete && (
            <div className="manage-actions" style={{ marginTop: 20 }}>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setKnowledgeToDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                style={{ background: '#b44a3f', borderColor: '#b44a3f' }}
                disabled={busy}
                onClick={() => {
                  void action(async () => {
                    await api(`knowledge/${knowledgeToDelete.id}`, 'DELETE');
                    setKnowledgeToDelete(null);
                    setNotice('知识已删除');
                  });
                }}
              >
                <Trash2 size={16} /> 确认删除
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
