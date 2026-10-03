'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { registerWorkbenchTools } from '@/lib/webmcp';
import { api, type Entity } from '../workbench-api';
import { MAX_ATTACHMENTS } from '../drafts/model';
import { useDraftSync } from '../drafts/use-draft-sync';
import type { Assistant } from '../assistant-editor';
import { WorkbenchView } from './workbench-view';
import { createWorkbenchRenderers } from './renderers';
import { createWorkbenchActions } from './actions';
import { deriveWorkbenchState } from './derived';
import { managementNavigation } from '../management';
import { useSidebar } from '@/components/ui/sidebar';
import {
  RoleId,
  Task,
  Session,
  Knowledge,
  Profile,
  TeamMessage,
  TeamTimelineItem,
  TimelineFilter,
  CapabilityApproval,
  TeamRecruitment,
  TeamForm,
  State,
  ROUTE_CACHE_KEY,
  MAX_ATTACHMENT_BYTES,
  readRouteCache,
} from './model';

export function Workbench() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  // 团队招募是主入口。工作空间载入后默认选中项目经理，具体角色由团队招募过程决定。
  const [role, setRole] = useState<RoleId>('__router__');
  const [view, setView] = useState('workspace');
  const [data, setData] = useState<State | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [selected, setSelected] = useState<Partial<Record<RoleId, string>>>({});
  const [selectedSpaceId, setSelectedSpaceId] = useState('');
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>(
    {},
  );
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<
    | 'settings'
    | 'knowledge'
    | 'handoff'
    | 'team'
    | 'rename-team'
    | 'team-template'
    | 'mobile-switcher'
    | null
  >(null);
  const [teamRenameForm, setTeamRenameForm] = useState({ name: '' });
  const [teamTemplateForm, setTeamTemplateForm] = useState({
    name: '',
    description: '',
  });
  const [mobileTeamQuery, setMobileTeamQuery] = useState('');
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [teamTemplateId, setTeamTemplateId] = useState('');
  const [teamForm, setTeamForm] = useState<TeamForm>({
    name: '',
    goal: '',
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    allowedTeamIds: [],
    workspace: '',
    workspaceMode: 'isolated',
    teamType: 'custom',
    allowCollaboration: true,
    autonomyMode: 'auto',
    autonomyMaxDepth: '4',
    autonomyMaxJobs: '32',
    autonomyBudgetTokens: '200000',
    model: '',
    providerId: '',
  });
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  const [handoffTask, setHandoffTask] = useState<Task | null>(null);
  const [handoffRole, setHandoffRole] = useState('developer');
  const [handoffNote, setHandoffNote] = useState('');
  const [knowledgeForm, setKnowledgeForm] = useState<Partial<Knowledge>>({
    title: '',
    content: '',
    scope: 'project',
    state: 'confirmed',
    source: '手动添加',
  });
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [knowledgeFilterScope, setKnowledgeFilterScope] =
    useState<string>('all');
  const [quickRenameKnowledge, setQuickRenameKnowledge] =
    useState<Knowledge | null>(null);
  const [quickRenameTitle, setQuickRenameTitle] = useState('');
  const [knowledgeToDelete, setKnowledgeToDelete] = useState<Knowledge | null>(
    null,
  );
  const [knowledgeHistory, setKnowledgeHistory] = useState<{
    id: string;
    items: Entity[];
  } | null>(null);
  const [deletingKnowledge, setDeletingKnowledge] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    workspace: '',
    model: 'deepseek-v4-flash',
  });
  const [profileForm, setProfileForm] = useState<Profile>({
    name: '',
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    tone: 'direct',
    verbosity: 'balanced',
    responseFormat: 'markdown',
    preferredRole: 'assistant',
    preferredProvider: '',
    preferredModel: '',
    habits: [],
    rules: [],
    instructions: '',
  });
  const [editingAssistant, setEditingAssistant] = useState<Assistant | null>(
    null,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [taskFilter, setTaskFilter] = useState('all');
  const [selectedReviewTaskIds, setSelectedReviewTaskIds] = useState<string[]>(
    [],
  );
  const [batchReviewNote, setBatchReviewNote] = useState('');
  const [batchReviewBusy, setBatchReviewBusy] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineHistory, setTimelineHistory] = useState<
    Record<string, TeamTimelineItem[]>
  >({});
  const [timelineHasMore, setTimelineHasMore] = useState<
    Record<string, boolean>
  >({});
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [expandedCharters, setExpandedCharters] = useState<
    Record<string, boolean>
  >({});
  const [recruitmentApprovals, setRecruitmentApprovals] = useState<
    Record<string, CapabilityApproval>
  >({});
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const routeInitialized = useRef(false);
  const [recruitmentSyncState, setRecruitmentSyncState] = useState<
    'idle' | 'syncing' | 'synced' | 'offline'
  >('idle');
  const teamEventRefreshTimerRef = useRef<number | null>(null);
  const recruitmentCursorRef = useRef<Record<string, string>>({});
  const overlayHistoryActiveRef = useRef(false);
  const closingOverlayFromPopRef = useRef(false);
  /* oxlint-disable no-explicit-any */
  const {
    roles,
    activeRoles,
    teamTemplates,
    assistant,
    Icon,
    tasks,
    allSessions,
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
  } = deriveWorkbenchState({
    data,
    role,
    view,
    selectedReviewTaskIds,
    mobileTeamQuery,
    selectedSpaceId,
    timelineHistory,
    timelineHasMore,
    timelineFilter,
    expandedCharters,
    recruitmentApprovals,
  }) as {
    tasks: Task[];
    allSessions: Session[];
    modelOptions: Array<{
      key: string;
      providerId: string;
      providerName: string;
      model: { id: string; tools?: boolean };
      providerHealth?: unknown;
    }>;
    [key: string]: any;
  };
  /* oxlint-enable no-explicit-any */
  const modelOverrideKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const dataReady = !!data;
  const draftKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const attachmentDraftKey = draftKey;
  const draftSync = useDraftSync({
    key: draftKey,
    scope: { spaceId: teamSpace?.id || null, roleId: role },
    ready: dataReady && role !== '__router__',
  });
  const {
    drafts,
    setDrafts,
    draftAttachments,
    setDraftAttachments,
    draftSyncState,
    draftConflict,
    setDraftConflict,
    markDraftDirty,
    clearServerDraft,
    resolveDraftConflict,
    draftVersionRef,
  } = draftSync;
  const hasMobileOverlay =
    isMobile &&
    Boolean(
      openMobile ||
      modal ||
      editingAssistant ||
      taskDetail ||
      quickRenameKnowledge ||
      knowledgeToDelete,
    );
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return undefined;
    const handlePopState = () => {
      if (!overlayHistoryActiveRef.current) return;
      overlayHistoryActiveRef.current = false;
      closingOverlayFromPopRef.current = true;
      setOpenMobile(false);
      setModal(null);
      setEditingAssistant(null);
      setTaskDetail(null);
      setQuickRenameKnowledge(null);
      setKnowledgeToDelete(null);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, setOpenMobile]);

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      overlayHistoryActiveRef.current = false;
      closingOverlayFromPopRef.current = false;
      return;
    }
    if (hasMobileOverlay && !overlayHistoryActiveRef.current) {
      window.history.pushState({ ggbOverlay: true }, '', window.location.href);
      overlayHistoryActiveRef.current = true;
      return;
    }
    if (!hasMobileOverlay && overlayHistoryActiveRef.current) {
      if (closingOverlayFromPopRef.current) {
        closingOverlayFromPopRef.current = false;
        return;
      }
      overlayHistoryActiveRef.current = false;
      window.history.back();
    }
  }, [hasMobileOverlay, isMobile]);

  const currentMemberSettings = teamSpace?.memberSettings?.[role];
  const isTeamMember = !!teamSpace?.memberRoleIds.includes(role);
  const mobileContextTitle = isRecruitmentView
    ? '团队招募'
    : isConversationView
      ? teamSpace?.name || assistantName
      : managementNavigation.find((item) => item.id === view)?.label ||
        (view === 'team'
          ? '团队动态'
          : view === 'tasks'
            ? '后台任务'
            : view === 'assistants'
              ? '助手与模型'
              : '知识库');
  const mobileContextDetail = isRecruitmentView
    ? '需求发布 · 先和项目经理澄清目标'
    : isConversationView
      ? `${teamSpace?.status === 'paused' ? '自治已暂停 · ' : ''}${teamSpace?.goal || '当前团队工作空间'}`
      : '工作空间';
  const isMoreView =
    !isRecruitmentView && !['workspace', 'team', 'tasks'].includes(view);
  const teamSessionIds = teamSpace
    ? new Set(
        tasks
          .filter((task) => task.spaceId === teamSpace.id && task.role === role)
          .map((task) => task.sessionId),
      )
    : new Set<string>();
  const sessions =
    teamSpace && (isTeamConversation || isTeamMember)
      ? allSessions.filter((session) => teamSessionIds.has(session.id))
      : allSessions;
  // Team conversations have their own session history. Namespacing the
  // selected session by team prevents a developer opened in Team A from
  // showing Team A's messages after the same member is selected in Team B.
  const sessionSelectionKey =
    teamSpace && (isTeamConversation || isTeamMember)
      ? `${teamSpace.id}:${role}`
      : role;
  const currentSession = selected[sessionSelectionKey];
  const conversationWorkspace =
    sessions.find((s) => s.id === currentSession)?.workspace ||
    data?.config.workspace;
  const currentTasks = tasks
    .filter((t) =>
      teamSpace?.pmRoleId === role
        ? t.role === role && t.spaceId === teamSpace.id
        : t.sessionId === currentSession,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const preferredModelId =
    currentMemberSettings?.modelHint ||
    (isTeamConversation ? projectManager?.model : assistant.model) ||
    data?.config.model;
  const preferredProviderIds = currentMemberSettings?.providerIds?.length
    ? currentMemberSettings.providerIds
    : isTeamConversation
      ? projectManager?.providerIds || []
      : assistant.providerIds || [];
  const roleModelOption = modelOptions.find(
    (option) =>
      option.model.id === preferredModelId &&
      (!preferredProviderIds.length ||
        preferredProviderIds.includes(option.providerId)),
  );
  const teamModelOption = modelOptions.find(
    (option) =>
      option.model.id === teamSpace?.model &&
      (!teamSpace?.providerId || option.providerId === teamSpace.providerId),
  );
  const selectedModelOption =
    modelOptions.find(
      (option) => option.key === modelOverrides[modelOverrideKey],
    ) ||
    (currentMemberSettings?.modelHint ? roleModelOption : null) ||
    (isTeamMember || isTeamConversation ? teamModelOption : null) ||
    roleModelOption ||
    modelOptions[0] ||
    null;
  const boundCapabilities = (data?.capabilities || []).filter((capability) =>
    assistant.capabilityIds?.includes(capability.id),
  );
  const knowledge = (data?.knowledge || []).filter(
    (k) =>
      k.scope === 'personal' ||
      (k.scope === 'team' && k.teamId === teamSpace?.id) ||
      (k.projectPath === conversationWorkspace &&
        ['project', role].includes(k.scope)),
  );
  const syncRecruitment = useCallback(
    async (spaceId: string) => {
      const cursor = recruitmentCursorRef.current[spaceId] || '';
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('after', cursor);
      if (spaceId === selectedSpaceId) setRecruitmentSyncState('syncing');
      try {
        const page = await api<{
          messages: TeamMessage[];
          cursor?: string | null;
          recruitment?: TeamRecruitment;
        }>(`spaces/${spaceId}/recruitment?${query.toString()}`);
        setData((current) => {
          if (!current) return current;
          return {
            ...current,
            spaces: current.spaces.map((space) => {
              if (space.id !== spaceId) return space;
              const messages = new Map(
                (space.messages || []).map((message) => [message.id, message]),
              );
              for (const message of page.messages || [])
                messages.set(message.id, message);
              return {
                ...space,
                recruitment: page.recruitment || space.recruitment,
                messages: [...messages.values()].sort((a, b) =>
                  a.createdAt.localeCompare(b.createdAt),
                ),
              };
            }),
          };
        });
        if (page.cursor) recruitmentCursorRef.current[spaceId] = page.cursor;
        if (spaceId === selectedSpaceId) setRecruitmentSyncState('synced');
      } catch {
        if (spaceId === selectedSpaceId) setRecruitmentSyncState('offline');
      }
    },
    [selectedSpaceId],
  );
  async function refresh() {
    try {
      const next = await api<State>('state');
      setData(next);
      const primary =
        next.spaces?.find(
          (space) =>
            space.status !== 'archived' &&
            space.recruitment?.phase === 'confirmed',
        ) ||
        next.spaces?.find((space) => space.status !== 'archived') ||
        next.spaces?.[0];
      const cachedRoute = readRouteCache();
      const cachedSpace = cachedRoute.spaceId
        ? next.spaces?.find(
            (space) =>
              space.id === cachedRoute.spaceId && space.status !== 'archived',
          )
        : null;
      setSelectedSpaceId((current) =>
        current &&
        next.spaces?.some(
          (space) => space.id === current && space.status !== 'archived',
        )
          ? current
          : cachedSpace?.id || primary?.id || '',
      );
      if (!routeInitialized.current) {
        const initialSpace = cachedSpace || primary;
        const cachedRole =
          cachedRoute.role &&
          initialSpace?.memberRoleIds.includes(cachedRoute.role) &&
          next.roles.some(
            (item) => item.id === cachedRoute.role && !item.archived,
          )
            ? cachedRoute.role
            : null;
        const preferred =
          cachedRole ||
          initialSpace?.pmRoleId ||
          next.roles.find((item) => !item.archived)?.id;
        if (preferred) setRole(preferred);
        if (initialSpace?.id) setSelectedSpaceId(initialSpace.id);
        if (cachedRoute.view) setView(cachedRoute.view);
        routeInitialized.current = true;
      }
      setConnectionError('');
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  }
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setRecruitmentApprovals({}), 0);
    return () => window.clearTimeout(timer);
  }, [charterKey]);
  useEffect(() => {
    const spaceId =
      isRecruitmentView &&
      teamSpace?.id &&
      teamSpace.recruitment?.phase !== 'confirmed'
        ? teamSpace.id
        : null;
    if (!spaceId) {
      const reset = window.setTimeout(() => setRecruitmentSyncState('idle'), 0);
      return () => window.clearTimeout(reset);
    }
    recruitmentCursorRef.current[spaceId] =
      recruitmentCursorRef.current[spaceId] || '';
    const initial = window.setTimeout(() => void syncRecruitment(spaceId), 0);
    const timer = window.setInterval(() => void syncRecruitment(spaceId), 2000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [
    isRecruitmentView,
    teamSpace?.id,
    teamSpace?.recruitment?.phase,
    syncRecruitment,
  ]);
  useEffect(() => {
    const spaceId = teamSpace?.id;
    if (!spaceId || !(isConversationView || view === 'team')) return;
    const source = new EventSource(
      `/api/spaces/${encodeURIComponent(spaceId)}/events/stream?limit=120`,
    );
    let ready = false;
    const scheduleRefresh = () => {
      if (!ready) return;
      if (teamEventRefreshTimerRef.current !== null)
        window.clearTimeout(teamEventRefreshTimerRef.current);
      teamEventRefreshTimerRef.current = window.setTimeout(() => {
        teamEventRefreshTimerRef.current = null;
        void refresh();
      }, 120);
    };
    const onReady = () => {
      ready = true;
    };
    source.addEventListener('ready', onReady);
    source.addEventListener('team_event', scheduleRefresh);
    source.onerror = () => {
      // EventSource reconnects on its own. The existing state polling keeps
      // the workspace usable while a device or server is temporarily offline.
    };
    return () => {
      source.removeEventListener('ready', onReady);
      source.removeEventListener('team_event', scheduleRefresh);
      source.close();
      if (teamEventRefreshTimerRef.current !== null) {
        window.clearTimeout(teamEventRefreshTimerRef.current);
        teamEventRefreshTimerRef.current = null;
      }
    };
  }, [isConversationView, teamSpace?.id, view]);
  useEffect(() => {
    if (!selectedSpaceId) return;
    try {
      window.localStorage.setItem(
        ROUTE_CACHE_KEY,
        JSON.stringify({ spaceId: selectedSpaceId, role, view }),
      );
    } catch {
      // Storage quotas and private browsing restrictions are both recoverable.
    }
  }, [selectedSpaceId, role, view]);
  useEffect(() => {
    if (!taskDetail?.id) return;
    const id = taskDetail.id;
    let cancelled = false;
    const load = async () => {
      try {
        const full = await api<Task>(`tasks/${id}`);
        if (!cancelled) setTaskDetail(full);
      } catch (error) {
        if (!cancelled) setNotice((error as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskDetail?.id]);
  useEffect(
    () =>
      registerWorkbenchTools({
        assistants: async () =>
          (await api<State>('state')).roles
            .filter((r) => !r.archived)
            .map(({ id, name }) => ({ id, name })),
        list: async () =>
          (await api<State>('state')).tasks.map(
            ({ id, role, title, status, result }) => ({
              id,
              role,
              title,
              status,
              result,
            }),
          ),
        create: async (input) => {
          const task = await api<Task>('tasks', 'POST', input);
          setRole(task.role);
          setSelected((s) => ({
            ...s,
            [task.spaceId ? `${task.spaceId}:${task.role}` : task.role]:
              task.sessionId,
          }));
          setView('workspace');
          await refresh();
          return { id: task.id, status: task.status };
        },
      }),
    [],
  );
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const updateViewport = () => {
      const viewportHeight = Math.round(viewport.height);
      const keyboardInset = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
      );
      root.style.setProperty('--ggb-viewport-height', `${viewportHeight}px`);
      root.style.setProperty('--ggb-keyboard-inset', `${keyboardInset}px`);
      if (keyboardInset > 120) root.dataset.keyboardOpen = 'true';
      else delete root.dataset.keyboardOpen;
    };
    updateViewport();
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);
    return () => {
      viewport.removeEventListener('resize', updateViewport);
      viewport.removeEventListener('scroll', updateViewport);
      root.style.removeProperty('--ggb-viewport-height');
      root.style.removeProperty('--ggb-keyboard-inset');
      delete root.dataset.keyboardOpen;
    };
  }, [isMobile]);
  useEffect(() => {
    if (currentTasks.length > 0) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [currentTasks.length, role, teamSpace?.id]);
  const {
    action,
    toggleReviewTask,
    toggleAllReviewTasks,
    batchReview,
    uploadAttachments,
    clipboardFiles,
    submit,
    retryTeamMessage,
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
    loadOlderTeamTimeline,
    selectTeam,
    showTask,
    openRiskTeam,
    openRiskTask,
    handoffRoles,
    editRole,
    // The action factory only captures refs for event handlers; it does not read ref.current during render.
    /* oxlint-disable */
  } = createWorkbenchActions({
    setBusy,
    refresh,
    setNotice,
    setSelectedReviewTaskIds,
    selectedReviewTaskIds,
    reviewTasks,
    batchReviewNote,
    setBatchReviewNote,
    setBatchReviewBusy,
    draftAttachments,
    attachmentDraftKey,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES,
    isTeamMember,
    isTeamConversation,
    teamSpace,
    setDraftAttachments,
    setDraftConflict,
    markDraftDirty,
    drafts,
    draftKey,
    getDraftVersionRef: () => draftVersionRef,
    assistant,
    role,
    selectedModelOption,
    setSelected,
    sessionSelectionKey,
    clearServerDraft,
    currentSession,
    modelOptions,
    setModelOverrides,
    modelOverrideKey,
    assistantName,
    recruitmentApprovals,
    setSelectedSpaceId,
    setRole,
    setView,
    isMobile,
    setOpenMobile,
    data,
    setSettingsForm,
    setProfileForm,
    profileForm,
    setModal,
    setMobileTeamQuery,
    setKnowledgeHistory,
    setDeletingKnowledge,
    setKnowledgeForm,
    isConversationView,
    conversationWorkspace,
    setHandoffTask,
    setHandoffRole,
    setHandoffNote,
    setTeamRenameForm,
    activeRoles,
    setEditingTeamId,
    setTeamForm,
    setTeamTemplateId,
    setTeamTemplateForm,
    teamTemplates,
    recruitmentSpace,
    setDrafts,
    confirmedSpaces,
    selectedSpaceId,
    tasks,
    setTaskDetail,
    setTimelineFilter,
    timelineLoading,
    setTimelineLoading,
    teamTimeline,
    setTimelineHistory,
    setTimelineHasMore,
    setEditingAssistant,
  });
  /* oxlint-enable */
  const { renderTeamTimelineItem, taskCard, reviewTaskCard } =
    createWorkbenchRenderers({
      roles,
      tasks,
      teamSpace,
      data,
      busy,
      showTask,
      retryTeamMessage,
      selectedReviewTaskIds,
      toggleReviewTask,
    });
  const viewContext = {
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
    archiveTeam,
    restoreTeam,
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
  };
  return <WorkbenchView context={viewContext} />;
}
