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
import { WorkbenchDialogGeneral } from './workbench-dialog-general';
import { WorkbenchDialogTeam } from './workbench-dialog-team';

export function WorkbenchMainDialog({
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
    <Dialog
      open={modal !== null}
      onOpenChange={(open) => !open && setModal(null)}
    >
      <DialogContent
        className={`work-dialog${modal === 'team-template' ? ' team-template-dialog' : ''}${modal === 'team' ? ' team-settings-dialog' : ''}${modal === 'mobile-switcher' ? ' mobile-switcher-dialog' : ''}`}
      >
        <DialogTitle>
          {modal === 'mobile-switcher'
            ? '切换当前工作'
            : modal === 'settings'
              ? '工作空间设置'
              : modal === 'knowledge'
                ? '编辑知识'
                : modal === 'handoff'
                  ? '交给其他助手'
                  : modal === 'rename-team'
                    ? '重命名团队'
                    : modal === 'team-template'
                      ? '保存团队模板'
                      : editingTeamId
                        ? '团队设置'
                        : '手动创建团队'}
        </DialogTitle>
        <DialogDescription>
          {modal === 'mobile-switcher'
            ? '只切换当前对话和团队上下文，草稿会按团队分别保留。'
            : modal === 'settings'
              ? '配置应用于新任务；已经开始的任务保持当前配置。'
              : modal === 'knowledge'
                ? '保存到本地，后续任务会按相关性读取。'
                : modal === 'handoff'
                  ? '将目标、成果和补充要求传给目标助手，创建独立会话。'
                  : modal === 'rename-team'
                    ? '只修改团队显示名称，团队消息、成员和任务都会保留。'
                    : modal === 'team-template'
                      ? '模板只保存团队配置，不会包含消息、任务、招募会话、草稿或附件。使用模板创建新团队时，需要重新确认名称、目标、目录和协作边界。'
                      : editingTeamId
                        ? '调整当前团队的职责、成员、执行目录和自驱模式；已有任务保持原来的执行快照。'
                        : '每个团队拥有自己的职责、成员和工作目录。你可以在团队招募中切换团队，团队也可以通过项目经理互相协作。'}
        </DialogDescription>
        <WorkbenchDialogGeneral context={context} />
        <WorkbenchDialogTeam context={context} />
      </DialogContent>
    </Dialog>
  );
}
