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

export function WorkbenchDialogTeam({
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
    <>
      {modal === 'team' && (
        <form
          id="team-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const payload = {
                name: teamForm.name,
                goal: teamForm.goal,
                purpose: teamForm.goal,
                teamType: teamForm.teamType,
                pmRoleId: teamForm.pmRoleId,
                memberRoleIds: teamForm.memberRoleIds,
                workspace: teamForm.workspace,
                workspaceMode: teamForm.workspaceMode,
                autonomy: {
                  mode: teamForm.autonomyMode,
                  maxDepth: Number(teamForm.autonomyMaxDepth),
                  maxJobs: Number(teamForm.autonomyMaxJobs),
                  budgetTokens: Number(teamForm.autonomyBudgetTokens),
                },
                collaboration: {
                  ...(editingTeamId && teamSpace?.collaboration
                    ? teamSpace.collaboration
                    : {
                        autoHandoff: true,
                        sharedBoard: true,
                        allowedTeamIds: [],
                      }),
                  enabled: teamForm.allowCollaboration,
                  allowedTeamIds: teamForm.allowedTeamIds,
                },
                model: teamForm.model || null,
                providerId: teamForm.providerId || null,
              };
              const saved = await api<TeamSpace>(
                editingTeamId
                  ? `spaces/${editingTeamId}`
                  : teamTemplateId
                    ? `team-templates/${teamTemplateId}/apply`
                    : 'spaces',
                editingTeamId ? 'PUT' : 'POST',
                teamTemplateId && !editingTeamId
                  ? {
                      name: teamForm.name,
                      goal: teamForm.goal,
                      purpose: teamForm.goal,
                      workspace: teamForm.workspace,
                      workspaceMode: teamForm.workspaceMode,
                      teamType: teamForm.teamType,
                      autonomy: payload.autonomy,
                      model: teamForm.model || null,
                      providerId: teamForm.providerId || null,
                      collaboration: payload.collaboration,
                    }
                  : payload,
              );
              // Refresh before selecting a newly created team so mobile and
              // desktop views can resolve the id from the same state snapshot.
              if (!editingTeamId) await refresh();
              setSelectedSpaceId(saved.id);
              setRole(saved.pmRoleId);
              setModal(null);
              if (!editingTeamId) setView('workspace');
              setNotice(
                editingTeamId
                  ? `团队“${saved.name}”设置已保存`
                  : teamTemplateId
                    ? `已从模板创建团队“${saved.name}”`
                    : `团队“${saved.name}”已创建`,
              );
            });
          }}
        >
          {!editingTeamId && (
            <label>
              配置来源
              <select
                aria-label="选择团队模板"
                value={teamTemplateId}
                onChange={(e) => openCreateTeam(e.target.value)}
              >
                <option value="">空白团队</option>
                {teamTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <small className="field-help">
                选择模板只会预填配置；创建时仍需重新确认团队名称、目标、目录、模型和协作权限。
              </small>
            </label>
          )}
          <label>
            团队名称
            <input
              required
              maxLength={80}
              value={teamForm.name}
              onChange={(e) =>
                setTeamForm((form) => ({ ...form, name: e.target.value }))
              }
              placeholder="例如：产品开发组、线上运维组"
            />
          </label>
          <label>
            团队职责 / 目标
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={teamForm.goal}
              onChange={(e) =>
                setTeamForm((form) => ({ ...form, goal: e.target.value }))
              }
              placeholder="这个团队负责什么？什么结果代表完成？"
            />
          </label>
          <div className="form-grid two">
            <div className="field-label">
              团队类型
              <Choice
                label="团队类型"
                value={teamForm.teamType}
                onChange={(teamType) =>
                  setTeamForm((form) => ({
                    ...form,
                    teamType: teamType as TeamForm['teamType'],
                  }))
                }
                options={[
                  { value: 'custom', label: '自定义团队' },
                  { value: 'development', label: '开发团队' },
                  { value: 'operations', label: '运维团队' },
                  { value: 'product', label: '产品团队' },
                  { value: 'project', label: '项目团队' },
                ]}
              />
            </div>
            <div className="field-label">
              项目经理
              <Choice
                label="项目经理"
                value={teamForm.pmRoleId}
                onChange={(pmRoleId) =>
                  setTeamForm((form) => ({
                    ...form,
                    pmRoleId,
                    memberRoleIds: form.memberRoleIds.includes(pmRoleId)
                      ? form.memberRoleIds
                      : [pmRoleId, ...form.memberRoleIds],
                  }))
                }
                options={activeRoles.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </div>
            <label>
              默认模型
              <select
                value={
                  teamForm.model && teamForm.providerId
                    ? `${teamForm.providerId}::${teamForm.model}`
                    : ''
                }
                onChange={(e) => {
                  const [providerId = '', model = ''] =
                    e.target.value.split('::');
                  setTeamForm((form) => ({ ...form, providerId, model }));
                }}
              >
                <option value="">沿用工作空间模型</option>
                {teamForm.model &&
                  teamForm.providerId &&
                  !modelOptions.some(
                    (item) =>
                      item.key === `${teamForm.providerId}::${teamForm.model}`,
                  ) && (
                    <option value={`${teamForm.providerId}::${teamForm.model}`}>
                      当前配置 · {teamForm.model}
                    </option>
                  )}
                {modelOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.providerName} · {item.model.name}
                  </option>
                ))}
              </select>
              <small className="field-help">
                模板中的模型会预填；可在这里重新选择。
              </small>
            </label>
            <label>
              工作目录
              <input
                required
                aria-label="工作目录"
                aria-describedby="team-workspace-help"
                value={teamForm.workspace}
                onChange={(e) =>
                  setTeamForm((form) => ({
                    ...form,
                    workspace: e.target.value,
                  }))
                }
                placeholder="沿用工作空间目录"
              />
              <small className="field-help" id="team-workspace-help">
                项目经理的后续对话和成员的新会话使用此目录；已有成员会话保留原目录。
                隔离执行时会从此项目创建副本，实际执行位置可在任务详情查看。
              </small>
            </label>
            <div className="field-label">
              默认执行目录
              <Choice
                label="默认执行目录"
                value={teamForm.workspaceMode}
                onChange={(workspaceMode) =>
                  setTeamForm((form) => ({
                    ...form,
                    workspaceMode: workspaceMode as TeamForm['workspaceMode'],
                  }))
                }
                options={[
                  { value: 'isolated', label: '隔离目录（推荐）' },
                  { value: 'worktree', label: 'Git worktree' },
                  { value: 'snapshot', label: '快照目录' },
                  { value: 'shared', label: '共享源目录' },
                ]}
              />
            </div>
          </div>
          <label
            className="team-collaboration-toggle"
            aria-label="允许与其他团队协作"
          >
            <input
              type="checkbox"
              checked={teamForm.allowCollaboration}
              onChange={(e) =>
                setTeamForm((form) => ({
                  ...form,
                  allowCollaboration: e.target.checked,
                }))
              }
            />
            <span>
              <strong>允许与其他团队协作</strong>
              <small>项目经理可以向其他团队请求支持，并共享任务状态。</small>
            </span>
          </label>
          <fieldset
            className="team-member-picker team-collaborator-picker"
            disabled={!teamForm.allowCollaboration}
          >
            <legend>可协作团队</legend>
            <p className="team-picker-help">
              不勾选表示允许当前所有已确认团队；勾选后只允许向选中的团队发起协作。
            </p>
            <div className="team-member-options">
              {(data?.spaces || [])
                .filter(
                  (candidate) =>
                    candidate.id !== editingTeamId &&
                    candidate.status === 'active' &&
                    candidate.recruitment?.phase === 'confirmed',
                )
                .map((candidate) => (
                  <label key={candidate.id} className="team-member-option">
                    <input
                      type="checkbox"
                      aria-label={`允许协作：${candidate.name}`}
                      checked={teamForm.allowedTeamIds.includes(candidate.id)}
                      onChange={(event) =>
                        setTeamForm((form) => ({
                          ...form,
                          allowedTeamIds: event.target.checked
                            ? [
                                ...new Set([
                                  ...form.allowedTeamIds,
                                  candidate.id,
                                ]),
                              ]
                            : form.allowedTeamIds.filter(
                                (id) => id !== candidate.id,
                              ),
                        }))
                      }
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.purpose || candidate.goal}</small>
                    </span>
                  </label>
                ))}
              {!(data?.spaces || []).some(
                (candidate) =>
                  candidate.id !== editingTeamId &&
                  candidate.status === 'active' &&
                  candidate.recruitment?.phase === 'confirmed',
              ) && (
                <small className="team-picker-empty">
                  还没有其他已确认团队。创建并确认团队后，可以在这里限制协作范围。
                </small>
              )}
            </div>
          </fieldset>
          <fieldset className="team-member-picker">
            <legend>协作成员</legend>
            <div className="team-member-options">
              {activeRoles.map((item) => (
                <div key={item.id} className="team-member-option">
                  <input
                    id={`team-member-${item.id}`}
                    type="checkbox"
                    aria-label={`选择${item.name}`}
                    checked={
                      teamForm.memberRoleIds.includes(item.id) ||
                      item.id === teamForm.pmRoleId
                    }
                    disabled={item.id === teamForm.pmRoleId}
                    onChange={(e) =>
                      setTeamForm((form) => ({
                        ...form,
                        memberRoleIds: e.target.checked
                          ? [...new Set([...form.memberRoleIds, item.id])]
                          : form.memberRoleIds.filter((id) => id !== item.id),
                      }))
                    }
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.desc}</small>
                  </span>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="field-label">
            自驱模式
            <Choice
              label="团队自驱模式"
              value={teamForm.autonomyMode}
              onChange={(autonomyMode) =>
                setTeamForm((form) => ({
                  ...form,
                  autonomyMode: autonomyMode as TeamForm['autonomyMode'],
                }))
              }
              options={[
                { value: 'auto', label: '自驱 · 自动拆解和推进' },
                { value: 'assist', label: '协作 · 关键步骤先确认' },
              ]}
            />
          </div>
          <div className="form-grid three team-autonomy-limits">
            <label>
              最大拆解层级
              <input
                type="number"
                min={1}
                max={4}
                required
                value={teamForm.autonomyMaxDepth}
                onChange={(e) =>
                  setTeamForm((form) => ({
                    ...form,
                    autonomyMaxDepth: e.target.value,
                  }))
                }
              />
              <small className="field-help">
                限制项目经理继续拆分子任务的层级。
              </small>
            </label>
            <label>
              活跃任务上限
              <input
                type="number"
                min={1}
                max={32}
                required
                value={teamForm.autonomyMaxJobs}
                onChange={(e) =>
                  setTeamForm((form) => ({
                    ...form,
                    autonomyMaxJobs: e.target.value,
                  }))
                }
              />
              <small className="field-help">
                达到上限后，新任务会被拦截，处理完现有任务后再继续。
              </small>
            </label>
            <label>
              团队 Token 预算
              <input
                type="number"
                min={1000}
                max={100000000}
                step={1000}
                required
                value={teamForm.autonomyBudgetTokens}
                onChange={(e) =>
                  setTeamForm((form) => ({
                    ...form,
                    autonomyBudgetTokens: e.target.value,
                  }))
                }
              />
              <small className="field-help">
                团队累计达到预算会自动暂停自治。
              </small>
            </label>
          </div>
        </form>
      )}
      {modal === 'team' && (
        <div className="team-form-actions">
          <button
            className="primary-button"
            type="submit"
            form="team-settings-form"
            disabled={busy || !activeRoles.length}
          >
            <Plus size={16} /> {editingTeamId ? '保存团队设置' : '创建团队'}
          </button>
        </div>
      )}
    </>
  );
}
