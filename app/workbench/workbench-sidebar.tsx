/* oxlint-disable */
// @ts-nocheck
'use client';
import { modelSetupLabel } from './model-setup-notice';
// Focused presentation modules receive a controller context assembled by Workbench.
/* oxlint-disable no-explicit-any, no-unused-vars */
import { useState } from 'react';
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
import { isActive } from './model';

export function WorkbenchSidebar({ context }: { context: WorkbenchContext }) {
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
    archivedSpaces,
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
    restoreTeam,
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
  const [teamQuery, setTeamQuery] = useState('');
  const normalizedTeamQuery = teamQuery.trim().toLocaleLowerCase();
  const visibleTeams = confirmedSpaces.filter((space) => {
    if (!normalizedTeamQuery) return true;
    return `${space.name} ${space.goal || ''}`
      .toLocaleLowerCase()
      .includes(normalizedTeamQuery);
  });
  const showTeamSearch = confirmedSpaces.length >= 3;
  return (
    <Sidebar className="work-sidebar">
      <SidebarHeader className="brand-header">
        <button
          type="button"
          className="mobile-sidebar-close"
          aria-label="关闭导航"
          onClick={() => setOpenMobile(false)}
        >
          <X size={18} />
        </button>
        <div className="brand">
          <div className="brand-symbol">
            <Layers3 size={20} />
          </div>
          <div className="brand-info">
            <div className="brand-title-row">
              <span className="brand-title">Goal-Guided</span>
              <span className="version">01</span>
            </div>
            <span className="brand-subtitle">BRAIN · DSH WORKSPACE</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <div className="nav-caption">工作入口</div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isRecruitmentView}
              onClick={openTeamConversation}
              className="role-nav chat-entry"
            >
              <span className="role-letter chat-entry-icon">
                <MessageSquare size={18} />
              </span>
              <span>
                <strong>团队招募</strong>
                <small>多轮澄清 · 一起组建合适的团队</small>
              </span>
              {running.length > 0 ? (
                <span className="live-dot" />
              ) : (
                <ArrowRight className="nav-icon" />
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="team-nav-head">
          <span>我的团队</span>
          <button
            type="button"
            aria-label="发布新需求"
            disabled={busy || !activeRoles.length}
            onClick={() => void startRecruitment(true)}
          >
            <Plus size={14} />
          </button>
        </div>
        {showTeamSearch && (
          <label className="team-nav-search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">搜索我的团队</span>
            <input
              type="search"
              aria-label="搜索我的团队"
              value={teamQuery}
              placeholder="搜索团队或职责"
              onChange={(event) => setTeamQuery(event.target.value)}
            />
            {teamQuery && (
              <button
                type="button"
                aria-label="清除团队搜索"
                onClick={() => setTeamQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </label>
        )}
        <SidebarMenu className="team-nav-list">
          {visibleTeams.map((space) => (
            <SidebarMenuItem key={space.id}>
              <SidebarMenuButton
                className="team-nav-item"
                isActive={
                  selectedSpaceId === space.id &&
                  ['workspace', 'team'].includes(view)
                }
                onClick={() => {
                  selectTeam(space.id);
                  setTeamQuery('');
                  setView('workspace');
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <span className="team-nav-dot">
                  <Users size={14} />
                </span>
                <span>
                  <strong>{space.name}</strong>
                  <small>{space.goal || '尚未设置团队职责'}</small>
                </span>
                {Number(data?.teamRiskCounts?.[space.id] || 0) > 0 && (
                  <b
                    className="team-risk-badge"
                    aria-label={`${data?.teamRiskCounts?.[space.id]} 项待处理`}
                  >
                    {Number(data?.teamRiskCounts?.[space.id] || 0) > 9
                      ? '9+'
                      : data?.teamRiskCounts?.[space.id]}
                  </b>
                )}
                {tasks.some(
                  (task) => task.spaceId === space.id && isActive(task),
                ) && <span className="live-dot" />}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {showTeamSearch && !visibleTeams.length && (
            <SidebarMenuItem>
              <div className="team-nav-filter-empty">没有匹配的团队</div>
            </SidebarMenuItem>
          )}
          {!confirmedSpaces.length && (
            <SidebarMenuItem>
              <button
                type="button"
                className="team-nav-empty"
                disabled={busy || !activeRoles.length}
                onClick={() => void startRecruitment()}
              >
                <Plus size={14} />{' '}
                {recruitmentSpace
                  ? '团队确认后会显示在这里'
                  : '还没有已创建团队'}
              </button>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        {archivedSpaces.length > 0 && (
          <div className="team-archived-list" aria-label="已归档团队">
            <div className="team-nav-head team-nav-archived-head">
              <span>已归档团队</span>
              <Archive size={13} />
            </div>
            <SidebarMenu className="team-nav-list">
              {archivedSpaces.map((space) => (
                <SidebarMenuItem key={space.id}>
                  <SidebarMenuButton
                    className="team-nav-item archived"
                    aria-label={`恢复团队 ${space.name}`}
                    onClick={() => void restoreTeam(space.id)}
                    disabled={busy}
                  >
                    <span className="team-nav-dot">
                      <Archive size={14} />
                    </span>
                    <span>
                      <strong>{space.name}</strong>
                      <small>已归档 · 点击恢复</small>
                    </span>
                    <Undo2 className="nav-icon" size={14} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </div>
        )}
        <div className="nav-divider" />
        <div className="nav-caption">工作空间</div>
        <SidebarMenu>
          {[
            { id: 'team', label: '团队动态', icon: Users },
            { id: 'assistants', label: '助手与模型', icon: Settings2 },
            { id: 'tasks', label: '后台任务', icon: Workflow },
            { id: 'knowledge', label: '知识库', icon: BookOpen },
            ...managementNavigation,
          ].map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                className="utility-nav"
                isActive={view === item.id}
                onClick={() => {
                  if (item.id === 'team') openTeamOverview();
                  else {
                    setView(item.id);
                    if (isMobile) setOpenMobile(false);
                  }
                }}
              >
                <item.icon />
                <span>{item.label}</span>
                {item.id === 'tasks' && running.length > 0 && (
                  <b>{running.length}</b>
                )}
                {item.id === 'attention' && actionableNotificationCount > 0 && (
                  <b aria-hidden="true">
                    {actionableNotificationCount > 9
                      ? '9+'
                      : actionableNotificationCount}
                  </b>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="sidebar-note">
          <span className="live-dot" />
          <p>
            先把需求发布给团队招募。
            <small>AI 会先澄清，再按实际工作内容生成团队名称和职责。</small>
          </p>
        </div>
      </SidebarContent>
      <SidebarFooter>
        <button className="environment" onClick={openSettings}>
          <div className="avatar">L</div>
          <div>
            <strong>工作空间</strong>
            <span>
              {data?.config.dshReady ? '已发现执行引擎' : '未找到执行引擎'} ·{' '}
              {modelSetupLabel(data?.config)}
            </span>
          </div>
          <Settings2 size={17} />
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
