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

export function TransientOverlays({ context }: { context: WorkbenchContext }) {
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
      {isMobile &&
        !modal &&
        !editingAssistant &&
        !taskDetail &&
        !quickRenameKnowledge &&
        !knowledgeToDelete && (
          <nav className="mobile-bottom-nav" aria-label="移动端主导航">
            <button
              type="button"
              className={isRecruitmentView ? 'active' : ''}
              aria-current={isRecruitmentView ? 'page' : undefined}
              onClick={() => {
                dismissMobileInput();
                openTeamConversation();
              }}
            >
              <MessageSquare size={18} />
              <span>招募</span>
            </button>
            <button
              type="button"
              className={view === 'team' ? 'active' : ''}
              aria-current={view === 'team' ? 'page' : undefined}
              onClick={() => {
                dismissMobileInput();
                openTeamOverview();
              }}
            >
              <Users size={18} />
              <span>团队</span>
            </button>
            <button
              type="button"
              className={view === 'tasks' ? 'active' : ''}
              aria-current={view === 'tasks' ? 'page' : undefined}
              onClick={() => {
                dismissMobileInput();
                setView('tasks');
              }}
            >
              <Workflow size={18} />
              <span>任务</span>
              {running.length > 0 && (
                <b>{running.length > 9 ? '9+' : running.length}</b>
              )}
            </button>
            <button
              type="button"
              className={isMoreView ? 'active' : ''}
              aria-current={isMoreView ? 'page' : undefined}
              onClick={() => {
                dismissMobileInput();
                setOpenMobile(true);
              }}
            >
              <Menu size={18} />
              <span>更多</span>
              {actionableNotificationCount > 0 && (
                <b aria-hidden="true">
                  {actionableNotificationCount > 9
                    ? '9+'
                    : actionableNotificationCount}
                </b>
              )}
            </button>
          </nav>
        )}
      {notice && !editingAssistant && (
        <output className="toast">
          {notice}
          <button aria-label="关闭通知" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </output>
      )}
      {editingAssistant && (
        <AssistantEditor
          initial={editingAssistant}
          templates={activeRoles}
          skills={data?.skillCatalog || []}
          onClose={() => setEditingAssistant(null)}
          onSave={async (form) => {
            const saved = await api<Assistant>(
              form.id ? `roles/${form.id}` : 'roles',
              form.id ? 'PUT' : 'POST',
              form,
            );
            await refresh();
            setEditingAssistant(null);
            setRole(saved.id);
            setView('workspace');
            setNotice(form.id ? '助手已保存' : '助手已创建');
          }}
        />
      )}
    </>
  );
}
