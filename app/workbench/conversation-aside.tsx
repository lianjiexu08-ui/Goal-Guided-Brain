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
import { capabilityKindLabels, statusLabels } from './model';

export function ConversationAside({ context }: { context: WorkbenchContext }) {
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
    <aside className="context-panel">
      <div className="context-header">
        <span>{isRecruitmentView ? '需求发布' : '团队上下文'}</span>
        <button
          className="icon-button"
          aria-label="编辑助手配置"
          disabled={!assistant.id}
          onClick={editRole}
        >
          <Pencil size={18} />
        </button>
      </div>
      <div className="capability-card">
        <div className="capability-title">
          <Icon size={18} style={{ color: assistant.color }} />
          <strong>团队招募能力</strong>
        </div>
        <div className="skill-tags">
          {(data?.skillCatalog || [])
            .filter((s) => assistant.skillIds.includes(s.id))
            .map(({ name: s }) => (
              <span key={s}>{s}</span>
            ))}
          {assistant.workflow && <span>自定义 Skill</span>}
        </div>
        <p>
          {[
            assistant.tools.files && '文件读写',
            assistant.tools.web && '网页检索',
            assistant.tools.terminal && '沙箱终端',
          ]
            .filter(Boolean)
            .join(' · ') || '未启用工具'}
        </p>
        {boundCapabilities.length > 0 && (
          <div className="bound-capabilities">
            <span className="bound-capabilities-label">已绑定能力</span>
            {boundCapabilities.map((capability) => (
              <span className="bound-capability" key={capability.id}>
                {capabilityKindLabels[capability.kind] || capability.kind} ·{' '}
                {capability.name}
                {capability.kind === 'mcp' && capability.tools.length > 0
                  ? ` · ${capability.tools.length} 个工具`
                  : ''}
              </span>
            ))}
          </div>
        )}
        <button
          className="text-button"
          disabled={!assistant.id}
          onClick={editRole}
        >
          编辑配置 <ArrowRight size={13} />
        </button>
        <button className="text-button" onClick={() => setView('capabilities')}>
          管理 Skill / MCP / Plugin <ArrowRight size={13} />
        </button>
      </div>
      <div className="context-section">
        <div className="section-row">
          <h3>
            <BookOpen size={16} />
            可用知识
          </h3>
          <span>{knowledge.length}</span>
        </div>
        {knowledge.length ? (
          knowledge.slice(0, 5).map((k) => (
            <button
              className="knowledge-mini"
              key={k.id}
              onClick={() => openKnowledge(undefined, k)}
            >
              <FileText size={16} />
              <span>
                {k.title}
                <small>
                  {k.state === 'confirmed' ? '已确认' : '草稿'} ·{' '}
                  {k.scope === 'personal'
                    ? '个人'
                    : k.scope === 'project'
                      ? '项目共享'
                      : k.scope === 'team'
                        ? '团队共享'
                        : '角色专属'}
                </small>
              </span>
            </button>
          ))
        ) : (
          <div className="context-empty">
            加入项目背景、约定和需求，
            <br />
            让助手每次都有据可依。
          </div>
        )}
        <button className="add-knowledge" onClick={() => openKnowledge()}>
          <Plus size={15} />
          添加知识
        </button>
      </div>
      <div className="context-section">
        <div className="section-row">
          <h3>
            <Workflow size={16} />
            后台动态
          </h3>
          <span>{running.length}</span>
        </div>
        {running.length ? (
          running.slice(0, 4).map((t) => (
            <button
              className="activity-mini"
              key={t.id}
              onClick={() => showTask(t)}
            >
              <span className="live-dot" />
              <span>
                {t.title}
                <small>
                  {roles.find((r) => r.id === t.role)?.name} ·{' '}
                  {statusLabels[t.status]}
                </small>
              </span>
            </button>
          ))
        ) : (
          <div className="context-empty">暂无进行中的任务。</div>
        )}
      </div>
      <div className="local-note">
        <Layers3 size={17} />
        <span>
          知识按任务检索
          <br />
          <small>仅加载相关资料，保留来源。</small>
        </span>
      </div>
    </aside>
  );
}
