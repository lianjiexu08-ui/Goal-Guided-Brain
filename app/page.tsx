'use client';

import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { registerWorkbenchTools } from '@/lib/webmcp';
import {
  AuthenticationGate,
  ExecutionInspector,
  Management,
  managementNavigation,
} from './management';
import { api, entityList, entityText, type Entity } from './workbench-api';
import {
  AssistantEditor,
  assistantIcons,
  blankAssistant,
  type Assistant,
} from './assistant-editor';
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
  MessageSquare,
  Pencil,
  Paperclip,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Users,
  UserRound,
  ListChecks,
  Terminal,
  Trash2,
  Undo2,
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
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

type RoleId = string;
type Task = {
  id: string;
  role: RoleId;
  sessionId: string;
  workspace: string;
  title: string;
  prompt: string;
  status: string;
  result: string;
  error: string;
  log: string;
  createdAt: string;
  sourceTaskId?: string;
  knowledgeIds: string[];
  jobId?: string | null;
  groupId?: string | null;
  parentTaskId?: string | null;
  parentJobId?: string | null;
  spaceId?: string | null;
  artifactCount?: number;
  verificationStatus?: string | null;
  attachmentIds?: string[];
  attachments?: Attachment[];
};
type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
};
type DraftCache = {
  drafts?: Record<string, string>;
  attachments?: Record<string, Attachment[]>;
};
type Session = {
  id: string;
  role: RoleId;
  title: string;
  createdAt: string;
  workspace: string;
};
type Knowledge = {
  id: string;
  title: string;
  content: string;
  scope: string;
  state: string;
  source: string;
  updatedAt: string;
  projectPath: string;
};
type Config = {
  workspace: string;
  model: string;
  hasApiKey: boolean;
  dshReady: boolean;
  maxConcurrent: number;
  dataDir: string;
  roleInstructions: Record<RoleId, string>;
  roleSkills: Record<RoleId, string[]>;
  profile: Profile;
};
type Profile = {
  name: string;
  language: string;
  timezone: string;
  tone: string;
  verbosity: string;
  responseFormat: string;
  preferredRole: string;
  preferredProvider: string;
  preferredModel: string;
  habits: string[];
  rules: string[];
  instructions: string;
};
type TeamMessage = {
  id: string;
  spaceId: string;
  teamId?: string;
  clientMessageId?: string | null;
  kind: string;
  senderType: 'owner' | 'agent' | 'system' | 'team';
  senderId: string;
  fromTeamId?: string | null;
  toTeamId?: string | null;
  relatedMessageId?: string | null;
  taskId?: string | null;
  content: string;
  status: string;
  error?: string | null;
  createdAt: string;
  attachmentIds?: string[];
  attachments?: Attachment[];
};
type TeamRecruitmentMember = {
  memberId?: string;
  agentId?: string;
  roleId: string;
  name: string;
  responsibility: string;
  deliverables?: string[];
  skills?: string[];
  /** Stable Skill bindings used by the runtime; skills is display-only prose. */
  skillIds?: string[];
  /** Stable MCP/Plugin capability bindings used by the runtime. */
  capabilityIds?: string[];
  tools?: string[];
  /** Explicit runtime tool overrides. A null value follows the role template. */
  toolAccess?: { files?: boolean; web?: boolean; terminal?: boolean } | null;
  modelHint?: string;
  dependencies?: string[];
};
type TeamRecruitmentProposal = {
  version?: number;
  teamName: string;
  goal: string;
  purpose?: string;
  size: number;
  members: TeamRecruitmentMember[];
  openQuestions?: string[];
  ready?: boolean;
};
type TeamRecruitment = {
  phase: string;
  sessionId?: string | null;
  turns?: number;
  brief?: string;
  proposal?: TeamRecruitmentProposal | null;
  confirmedAt?: string | null;
};
type TeamSpace = {
  id: string;
  name: string;
  goal: string;
  workspace: string;
  pmRoleId: string;
  memberRoleIds: string[];
  status: string;
  model?: string | null;
  providerId?: string | null;
  autonomy: { mode: string; maxDepth: number; maxJobs: number; budgetTokens: number };
  teamType?: string;
  purpose?: string;
  collaboration?: { enabled?: boolean; autoHandoff?: boolean; sharedBoard?: boolean; allowedTeamIds?: string[] };
  memberSettings?: Record<string, {
    label?: string;
    responsibility?: string;
    modelHint?: string;
    providerIds?: string[];
  }>;
  recruitment?: TeamRecruitment;
  messages: TeamMessage[];
};
type TeamForm = {
  name: string;
  goal: string;
  pmRoleId: string;
  memberRoleIds: string[];
  workspace: string;
  teamType: 'custom' | 'development' | 'operations' | 'product' | 'project';
  allowCollaboration: boolean;
  autonomyMode: 'auto' | 'assist';
};
type Capability = {
  id: string;
  name: string;
  kind: string;
  version: string | null;
  enabled: boolean;
  description: string;
  tools: string[];
  health?: {
    ok?: boolean;
    checkedAt?: string | null;
    latencyMs?: number | null;
    toolCount?: number | null;
  } | null;
};
type ProviderModel = {
  id: string;
  name: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number;
};
type Provider = {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  priority: number;
  health?: {
    ok: boolean;
    model?: string | null;
    toolTest?: boolean;
    latencyMs?: number | null;
    error?: string | null;
  } | null;
  models: ProviderModel[];
};
type State = {
  roles: Assistant[];
  skillCatalog: { id: string; name: string }[];
  capabilities: Capability[];
  providers: Provider[];
  tasks: Task[];
  sessions: Session[];
  knowledge: Knowledge[];
  spaces: TeamSpace[];
  config: Config;
};
const modelDisplayName = (model: ProviderModel) =>
  model.name === model.id ? model.name : `${model.name} · ${model.id}`;
const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  state_unknown: '状态未知',
  blocked: '等待处理',
  paused: '已暂停',
  budget_exceeded: '预算超限',
  'budget-exceeded': '预算超限',
};
const verificationLabels: Record<string, string> = {
  verified: '已验收',
  failed: '验证失败',
  'pending-review': '待验收',
  'needs-review': '需要复核',
};
const capabilityKindLabels: Record<string, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  plugin: 'Plugin',
};
const isActive = (t: Task) => ['queued', 'running'].includes(t.status);
const taskVerification = (task: Task) =>
  task.verificationStatus
    ? verificationLabels[task.verificationStatus] || task.verificationStatus
    : task.status === 'completed'
      ? '待验收'
      : '';
const formatTime = (s: string) =>
  new Date(s).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const DRAFT_CACHE_KEY = 'ggb.composer-drafts.v1';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
function readDraftCache(): DraftCache {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(DRAFT_CACHE_KEY) || '{}') as DraftCache;
    const drafts = value?.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts)
      ? Object.fromEntries(Object.entries(value.drafts).filter(([, draft]) => typeof draft === 'string'))
      : {};
    const attachments = value?.attachments && typeof value.attachments === 'object' && !Array.isArray(value.attachments)
      ? Object.fromEntries(Object.entries(value.attachments).map(([key, items]) => [
          key,
          Array.isArray(items)
            ? items.filter((item): item is Attachment =>
                !!item && typeof item === 'object' &&
                typeof item.id === 'string' && typeof item.name === 'string' &&
                typeof item.mime === 'string' && Number.isFinite(item.size),
              ).slice(0, MAX_ATTACHMENTS)
            : [],
        ]))
      : {};
    return { drafts, attachments };
  } catch {
    return {};
  }
}
function Choice({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v !== null && onChange(v)}
      items={options}
    >
      <SelectTrigger aria-label={label} className="choice">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export default function Home() {
  return (
    <AuthenticationGate>
      <SidebarProvider
        style={{ '--sidebar-width': '244px' } as React.CSSProperties}
      >
        <Workbench />
      </SidebarProvider>
    </AuthenticationGate>
  );
}
function Workbench() {
  const { isMobile, setOpenMobile } = useSidebar();
  // 团队招募是主入口。工作空间载入后默认选中项目经理，具体角色由团队招募过程决定。
  const [role, setRole] = useState<RoleId>('__router__');
  const [view, setView] = useState('workspace');
  const [data, setData] = useState<State | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [selected, setSelected] = useState<Partial<Record<RoleId, string>>>({});
  const [selectedSpaceId, setSelectedSpaceId] = useState('');
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftAttachments, setDraftAttachments] = useState<Record<string, Attachment[]>>({});
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<
    'settings' | 'knowledge' | 'handoff' | 'team' | 'rename-team' | null
  >(null);
  const [teamRenameForm, setTeamRenameForm] = useState({ name: '' });
  const [teamForm, setTeamForm] = useState<TeamForm>({
    name: '',
    goal: '',
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    workspace: '',
    teamType: 'custom',
    allowCollaboration: true,
    autonomyMode: 'auto',
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
  const [knowledgeFilterScope, setKnowledgeFilterScope] = useState<string>('all');
  const [quickRenameKnowledge, setQuickRenameKnowledge] = useState<Knowledge | null>(null);
  const [quickRenameTitle, setQuickRenameTitle] = useState('');
  const [knowledgeToDelete, setKnowledgeToDelete] = useState<Knowledge | null>(null);
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
  const [expandedCharters, setExpandedCharters] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const routeInitialized = useRef(false);
  const draftCacheHydrated = useRef(false);
  const roles = data?.roles || [];
  const activeRoles = roles.filter((r) => !r.archived);
  const assistant = roles.find((r) => r.id === role) || {
    ...blankAssistant,
    name: data ? '暂无助手' : '载入中',
  };
  const Icon =
    assistantIcons[assistant.icon as keyof typeof assistantIcons] || Sparkles;
  const tasks = data?.tasks || [];
  const sessions = (data?.sessions || []).filter((s) => s.role === role);
  const currentSession = selected[role];
  const conversationWorkspace =
    sessions.find((s) => s.id === currentSession)?.workspace ||
    data?.config.workspace;
  const spaces = data?.spaces || [];
  const confirmedSpaces = spaces.filter(
    (space) => space.status !== 'archived' && space.recruitment?.phase === 'confirmed',
  );
  const recruitmentSpaces = spaces.filter(
    (space) => space.status !== 'archived' && space.recruitment?.phase !== 'confirmed',
  );
  const recruitmentSpace =
    recruitmentSpaces.find((space) => space.id === selectedSpaceId) ||
    recruitmentSpaces[0];
  const teamSpace =
    spaces.find((space) => space.id === selectedSpaceId) ||
    spaces[0];
  const isRecruitmentView = view === 'recruitment';
  const isConversationView = view === 'workspace' || isRecruitmentView;
  const isTeamConversation = teamSpace?.pmRoleId === role;
  const assistantName = teamSpace?.memberSettings?.[role]?.label || assistant.name;
  const currentTasks = tasks
    .filter((t) =>
      teamSpace?.pmRoleId === role
        ? t.role === role && t.spaceId === teamSpace.id
        : t.sessionId === currentSession,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const running = tasks.filter(isActive);
  const rosterReady = teamSpace?.recruitment?.phase === 'confirmed';
  const visibleMemberIds = teamSpace
    ? rosterReady
      ? teamSpace.memberRoleIds
      : [teamSpace.pmRoleId]
    : [];
  const teamMembers = teamSpace
    ? activeRoles
        .filter((item) => visibleMemberIds.includes(item.id))
        .sort((a, b) => Number(b.id === teamSpace.pmRoleId) - Number(a.id === teamSpace.pmRoleId))
    : activeRoles;
  const teamMessages = [...(teamSpace?.messages || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const teamTasks = tasks.filter((task) => task.spaceId === teamSpace?.id);
  const teamOpenTasks = teamTasks.filter(isActive);
  const projectManager = roles.find((item) => item.id === teamSpace?.pmRoleId);
  const recruitment = teamSpace?.recruitment;
  const recruitmentProposal = recruitment?.proposal;
  const isRecruiting = isTeamConversation && recruitment?.phase !== 'confirmed';
  const charterKey = `${teamSpace?.id}:${recruitmentProposal?.version}:${recruitment?.phase}`;
  const charterExpanded = expandedCharters[charterKey] ?? recruitment?.phase !== 'confirmed';
  const modelOptions = (data?.providers || [])
    // TypeSafe is a structured decision backend. It does not generate chat
    // replies or code, so it must never appear in the conversation model
    // switcher. It remains configurable in Management and callable through
    // the dedicated decision flow.
    .filter((provider) => provider.enabled && provider.protocol !== 'typesafe-system-one')
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.id}::${model.id}`,
        providerId: provider.id,
        providerName: provider.name,
        model,
      })),
    );
  const modelOverrideKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const draftKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const attachmentDraftKey = draftKey;
  const currentMemberSettings = teamSpace?.memberSettings?.[role];
  const isTeamMember = !!teamSpace?.memberRoleIds.includes(role);
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
      (!preferredProviderIds.length || preferredProviderIds.includes(option.providerId)),
  );
  const teamModelOption = modelOptions.find(
    (option) =>
      option.model.id === teamSpace?.model &&
      (!teamSpace?.providerId || option.providerId === teamSpace.providerId),
  );
  const selectedModelOption =
    modelOptions.find((option) => option.key === modelOverrides[modelOverrideKey]) ||
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
      (k.projectPath === conversationWorkspace &&
        ['project', role].includes(k.scope)),
  );
  async function refresh() {
    try {
      const next = await api<State>('state');
      setData(next);
      setSelectedSpaceId((current) =>
        current && next.spaces?.some((space) => space.id === current)
          ? current
          : next.spaces?.[0]?.id || '',
      );
      if (!routeInitialized.current) {
        const preferred = next.spaces?.[0]?.pmRoleId || next.roles.find((item) => !item.archived)?.id;
        if (preferred) setRole(preferred);
        if (next.spaces?.[0]?.id) setSelectedSpaceId(next.spaces[0].id);
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
    const timer = window.setTimeout(() => {
      const cached = readDraftCache();
      setDrafts((current) => ({ ...cached.drafts, ...current }));
      setDraftAttachments((current) => ({ ...cached.attachments, ...current }));
      draftCacheHydrated.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!draftCacheHydrated.current) return;
    try {
      window.localStorage.setItem(
        DRAFT_CACHE_KEY,
        JSON.stringify({ drafts, attachments: draftAttachments } satisfies DraftCache),
      );
    } catch {
      // Storage quotas and private browsing restrictions are both recoverable.
    }
  }, [drafts, draftAttachments]);
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
          setSelected((s) => ({ ...s, [task.role]: task.sessionId }));
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
    if (currentTasks.length > 0) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [currentTasks.length, role, teamSpace?.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadAttachments(files: File[]) {
    const existing = draftAttachments[attachmentDraftKey] || [];
    const incoming = files
      .filter((file) => file.size > 0)
      .slice(0, Math.max(0, MAX_ATTACHMENTS - existing.length));
    if (!incoming.length) return;
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setNotice(`“${oversized.name || '文件'}”超过 10 MB，未添加。`);
      return;
    }
    if (files.length > incoming.length) {
      setNotice(`每次对话最多保留 ${MAX_ATTACHMENTS} 个附件。`);
    }
    await action(async () => {
      const uploaded: Attachment[] = [];
      for (const file of incoming) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        uploaded.push(await api<Attachment>('attachments', 'POST', {
          name: file.name || `粘贴文件-${Date.now()}`,
          mime: file.type || 'application/octet-stream',
          data: btoa(binary),
        }));
      }
      setDraftAttachments((current) => ({
        ...current,
        [attachmentDraftKey]: [...(current[attachmentDraftKey] || []), ...uploaded].slice(0, MAX_ATTACHMENTS),
      }));
      setNotice(`已添加 ${uploaded.length} 个附件，发送时会携带文件内容。`);
    });
  }
  function clipboardFiles(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length) return files;
    return Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  }
  async function submit() {
    const attachmentIds = (draftAttachments[attachmentDraftKey] || []).map((item) => item.id);
    if ((!drafts[draftKey]?.trim() && !attachmentIds.length) || assistant.archived || !assistant.id) return;
    await action(async () => {
      // The single team-recruitment entry is the team's front door. Keep its messages in
      // the same space timeline so PM replies and delegated work stay linked.
      if (teamSpace?.pmRoleId === role) {
        const message = await api<TeamMessage & { sessionId?: string }>(
          `spaces/${teamSpace.id}/messages`,
          'POST',
          {
            clientMessageId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content: drafts[draftKey],
            attachmentIds,
            ...(selectedModelOption
              ? {
                  model: selectedModelOption.model.id,
                  providerId: selectedModelOption.providerId,
                  allowModelWithoutTools: !selectedModelOption.model.tools,
                }
              : {}),
          },
        );
        if (message.sessionId) {
          setSelected((s) => ({ ...s, [role]: message.sessionId }));
        }
        setDrafts((s) => ({ ...s, [draftKey]: '' }));
        setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
        return;
      }
      const task = await api<Task>('tasks', 'POST', {
        role,
        sessionId: currentSession,
        prompt: drafts[draftKey],
        attachmentIds,
        ...(isTeamMember && teamSpace
          ? { teamId: teamSpace.id, spaceId: teamSpace.id }
          : {}),
        ...(selectedModelOption
          ? {
              model: selectedModelOption.model.id,
              providerId: selectedModelOption.providerId,
              allowModelWithoutTools: !selectedModelOption.model.tools,
            }
          : {}),
      });
      setSelected((s) => ({ ...s, [role]: task.sessionId }));
      setDrafts((s) => ({ ...s, [draftKey]: '' }));
      setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
    });
  }
  async function retryTeamMessage(message: TeamMessage) {
    if (!teamSpace || message.status !== 'blocked') return;
    await action(async () => {
      const retried = await api<TeamMessage & { sessionId?: string }>(
        `spaces/${teamSpace.id}/messages`,
        'POST',
        {
          clientMessageId: message.clientMessageId || undefined,
          content: message.content,
          attachmentIds: message.attachmentIds || [],
          ...(selectedModelOption
            ? {
                model: selectedModelOption.model.id,
                providerId: selectedModelOption.providerId,
                allowModelWithoutTools: !selectedModelOption.model.tools,
              }
            : {}),
        },
      );
      if (retried.sessionId) {
        setSelected((s) => ({ ...s, [role]: retried.sessionId }));
      }
    });
  }
  async function changeTeamModel(value: string) {
    const option = modelOptions.find((item) => item.key === value);
    if (!option) return;
    await action(async () => {
      if (!teamSpace || !isTeamMember) {
        setModelOverrides((current) => ({ ...current, [modelOverrideKey]: option.key }));
        setNotice(`本次对话已切换到 ${option.providerName} · ${option.model.name}`);
        return;
      }
      const currentSettings = teamSpace.memberSettings || {};
      await api(`spaces/${teamSpace.id}`, 'PUT', {
        ...(role === teamSpace.pmRoleId
          ? { model: option.model.id, providerId: option.providerId }
          : {}),
        memberSettings: {
          ...currentSettings,
          [role]: {
            ...currentSettings[role],
            modelHint: option.model.id,
            providerIds: [option.providerId],
          },
        },
      });
      setModelOverrides((current) => {
        const next = { ...current };
        delete next[modelOverrideKey];
        return next;
      });
      setNotice(`${assistantName} 已切换到 ${option.providerName} · ${option.model.name}`);
    });
  }
  async function confirmTeamRecruitment() {
    if (!teamSpace?.recruitment?.proposal) return;
    const proposalVersion = teamSpace.recruitment.proposal.version;
    await action(async () => {
      const saved = await api<TeamSpace>(
        `spaces/${teamSpace.id}/recruitment/confirm`,
        'POST',
        { version: proposalVersion },
      );
      await refresh();
      setSelectedSpaceId(saved.id);
      setRole(saved.pmRoleId);
      setSelected((current) => ({ ...current, [saved.pmRoleId]: undefined }));
      setView('workspace');
      setNotice(`团队“${saved.name}”已确认，项目经理可以开始安排任务`);
    });
  }
  function openSettings() {
    if (isMobile) setOpenMobile(false);
    setSettingsForm({
      workspace: data?.config.workspace || '',
      model: data?.config.model || 'deepseek-v4-flash',
    });
    setProfileForm(data?.config.profile || profileForm);
    setModal('settings');
  }
  function openKnowledge(task?: Task, item?: Knowledge) {
    setKnowledgeHistory(null);
    setDeletingKnowledge(false);
    setKnowledgeForm(
      item || {
        title: task?.title || '',
        content: task?.result || '',
        scope: 'project',
        projectPath:
          task?.workspace ||
          (isConversationView
            ? conversationWorkspace
            : data?.config.workspace),
        state: task ? 'draft' : 'confirmed',
        source: task ? `任务 ${task.id}` : '手动添加',
      },
    );
    setModal('knowledge');
  }
  function openHandoff(task: Task) {
    setHandoffTask(task);
    setHandoffRole(activeRoles.find((r) => r.id !== task.role)?.id || '');
    setHandoffNote('');
    setModal('handoff');
  }
  function openTeamRename() {
    if (!teamSpace) return;
    setTeamRenameForm({ name: teamSpace.name });
    setModal('rename-team');
  }
  function openTeamCreate() {
    const pm = activeRoles.find((item) => item.id === 'project_manager') || activeRoles[0];
    setTeamForm({
      name: '',
      goal: '',
      pmRoleId: pm?.id || 'project_manager',
      memberRoleIds: pm ? [pm.id] : [],
      workspace: data?.config.workspace || '',
      teamType: 'custom',
      allowCollaboration: true,
      autonomyMode: 'auto',
    });
    setModal('team');
  }
  async function startRecruitment(forceNew = false) {
    if (!forceNew && recruitmentSpace) {
      selectTeam(recruitmentSpace.id);
      setView('recruitment');
      if (isMobile) setOpenMobile(false);
      return;
    }
    const pm = activeRoles.find((item) => item.id === 'project_manager') || activeRoles[0];
    if (!pm) return;
    await action(async () => {
      const saved = await api<TeamSpace>('spaces', 'POST', {
        // This is an internal draft label. The visible team name is chosen
        // from the actual work described in the Team Charter after approval.
        name: '待命名需求',
        goal: '通过多轮交流明确需求、交付物和团队职责。',
        pmRoleId: pm.id,
        memberRoleIds: [pm.id],
        workspace: data?.config.workspace || '',
        recruitment: { phase: 'discovery' },
      });
      setSelectedSpaceId(saved.id);
      setRole(saved.pmRoleId);
      setSelected((current) => ({ ...current, [saved.pmRoleId]: undefined }));
      setDrafts((current) => ({ ...current, [`${saved.id}:${saved.pmRoleId}`]: '' }));
      setView('recruitment');
      if (isMobile) setOpenMobile(false);
      setNotice('招募已开始，描述你希望团队完成的目标');
    });
  }
  function openTeamConversation() {
    if (recruitmentSpace) selectTeam(recruitmentSpace.id);
    else void startRecruitment();
    setView('recruitment');
    if (isMobile) setOpenMobile(false);
  }
  function openTeamOverview() {
    const target =
      confirmedSpaces.find((space) => space.id === selectedSpaceId) ||
      confirmedSpaces[0];
    if (!target) {
      openTeamConversation();
      return;
    }
    selectTeam(target.id);
    setView('team');
    if (isMobile) setOpenMobile(false);
  }
  function selectTeam(id: string) {
    const next = data?.spaces?.find((space) => space.id === id);
    if (!next) return;
    setModal(null);
    const changed = next.id !== selectedSpaceId;
    setSelectedSpaceId(next.id);
    setRole(next.pmRoleId);
    if (changed) {
      // A team is an independent conversation boundary. The draft is keyed by
      // team and role, so switching teams restores each team's own composer.
      setSelected((current) => ({ ...current, [next.pmRoleId]: undefined }));
    }
  }
  function showTask(task: Task) {
    setRole(task.role);
    setSelected((s) => ({ ...s, [task.role]: task.sessionId }));
    setView('workspace');
  }
  function editRole() {
    setEditingAssistant(assistant);
  }
  const taskCard = (task: Task) => (
    <button className="task-card" key={task.id} onClick={() => showTask(task)}>
      <div className={`status-icon ${task.status}`}>
        {task.status === 'running' ? (
          <LoaderCircle className="spin" />
        ) : task.status === 'completed' ? (
          <Check />
        ) : (
          <Circle />
        )}
      </div>
      <div>
        <strong>{task.title}</strong>
        <span>
          {roles.find((r) => r.id === task.role)?.name} ·{' '}
          {formatTime(task.createdAt)}
        </span>
      </div>
      <span className={`status ${task.status}`}>
        {statusLabels[task.status]}
      </span>
      <ArrowRight size={16} />
    </button>
  );
  return (
    <>
      <Sidebar className="work-sidebar">
        <SidebarHeader className="brand-header">
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
                <span className="role-letter chat-entry-icon"><MessageSquare size={18} /></span>
                <span>
                  <strong>团队招募</strong>
                  <small>多轮澄清 · 一起组建合适的团队</small>
                </span>
                {running.length > 0 ? <span className="live-dot" /> : <ArrowRight className="nav-icon" />}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="team-nav-head">
            <span>我的团队</span>
            <button type="button" aria-label="发布新需求" disabled={busy || !activeRoles.length} onClick={() => void startRecruitment(true)}>
              <Plus size={14} />
            </button>
          </div>
          <SidebarMenu className="team-nav-list">
            {confirmedSpaces.map((space) => (
              <SidebarMenuItem key={space.id}>
                <SidebarMenuButton
                  className="team-nav-item"
                  isActive={selectedSpaceId === space.id && ['workspace', 'team'].includes(view)}
                  onClick={() => {
                    selectTeam(space.id);
                    setView('workspace');
                    if (isMobile) setOpenMobile(false);
                  }}
                >
                  <span className="team-nav-dot"><Users size={14} /></span>
                  <span>
                    <strong>{space.name}</strong>
                    <small>{space.goal || '尚未设置团队职责'}</small>
                  </span>
                  {tasks.some((task) => task.spaceId === space.id && isActive(task)) && <span className="live-dot" />}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {!confirmedSpaces.length && (
              <SidebarMenuItem>
                <button type="button" className="team-nav-empty" disabled={busy || !activeRoles.length} onClick={() => void startRecruitment()}>
                  <Plus size={14} /> {recruitmentSpace ? '团队确认后会显示在这里' : '还没有已创建团队'}
                </button>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
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
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="sidebar-note">
            <span className="live-dot" />
            <p>
              先把需求发布给团队招募。<small>AI 会先澄清，再按实际工作内容生成团队名称和职责。</small>
            </p>
          </div>
        </SidebarContent>
        <SidebarFooter>
          <button className="environment" onClick={openSettings}>
            <div className="avatar">L</div>
            <div>
              <strong>工作空间</strong>
              <span>
                {data?.config.dshReady ? '执行引擎已连接' : '连接执行引擎'} ·{' '}
                {data?.config.hasApiKey ? '模型已配置' : '待配置模型'}
              </span>
            </div>
            <Settings2 size={17} />
          </button>
        </SidebarFooter>
      </Sidebar>
      <div className="workspace-shell">
        <header className="topbar">
          <div>
            <SidebarTrigger className="mobile-menu" />
            <span className="breadcrumb">工作空间</span>
            <span className="slash">/</span>
            <strong>
              {isConversationView
                ? isRecruitmentView ? '需求发布' : isTeamConversation ? '团队对话' : assistantName
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
        {managementNavigation.some((item) => item.id === view) ? (
          <Management key={view} view={view} onChanged={refresh} />
        ) : view === 'team' ? (
          <main className="team-page" key={`team-page:${teamSpace?.id || 'none'}`}>
            <div className="team-heading">
              <div>
                <span className="section-kicker">TEAM ACTIVITY</span>
                <h1>{teamSpace?.name || '查看团队如何推进。'}</h1>
                <p>{teamSpace?.goal || '项目经理会在后台选择成员、分派任务并汇总进展。新的需求请从团队招募发起。'}</p>
              </div>
              <div className="team-heading-actions">
                {teamSpace?.recruitment?.phase === 'confirmed' && confirmedSpaces.length > 0 ? (
                  <Choice
                    label="选择团队"
                    value={teamSpace.id}
                    onChange={selectTeam}
                    options={confirmedSpaces.map((space) => ({ value: space.id, label: space.name }))}
                  />
                ) : null}
                <button className="secondary-button" type="button" disabled={busy || !activeRoles.length} onClick={() => void startRecruitment(true)}><Plus size={15} /> 发布新需求</button>
                <button className="text-button" type="button" disabled={busy || !teamSpace} onClick={openTeamRename}><Pencil size={13} /> 重命名</button>
                <button className="text-button" type="button" onClick={openTeamCreate}>高级配置</button>
                <div className="team-health"><span className="live-dot" /> {rosterReady ? `${teamMembers.length} 位成员已配置` : recruitment?.phase === 'proposed' ? '方案待确认' : '正在招募'}</div>
              </div>
            </div>
            <div className="team-grid">
              <section className="team-chat-panel">
                <div className="team-chat-head">
                  <div className="pm-avatar"><Users size={20} /></div>
                  <div><strong>{projectManager?.name || '项目经理'}</strong><span>协调需求、安排任务、跟踪结果</span></div>
                  <span className="pm-status"><span className="live-dot" /> {teamTasks.some((task) => task.role === teamSpace?.pmRoleId && isActive(task)) ? '正在工作' : '随时响应'}</span>
                </div>
                <div className="team-chat-stream">
                  <div className="team-intro-message">
                    <span className="message-label"><span className="mini-role pm">PM</span> 项目经理</span>
                    <p>把目标、问题或一段模糊需求直接丢进来。我会先和你澄清，再给出团队规模、职责和推进方式。</p>
                    <div className="pm-flow"><span>多轮澄清</span><ArrowRight size={13} /><span>Team Charter</span><ArrowRight size={13} /><span>确认创建</span></div>
                  </div>
                  {teamMessages.map((message) => {
                    const relatedTask = message.taskId
                      ? tasks.find((task) => task.id === message.taskId)
                      : null;
                    const outgoingCollaboration =
                      message.kind === 'handoff' &&
                      message.fromTeamId === teamSpace?.id;
                    const targetTeamName = data?.spaces?.find(
                      (item) => item.id === message.toTeamId,
                    )?.name;
                    const author = message.senderType === 'owner'
                      ? '你'
                      : message.senderType === 'team'
                        ? outgoingCollaboration
                          ? `本团队 → ${targetTeamName || '协作团队'}`
                          : data?.spaces?.find((item) => item.id === message.fromTeamId)?.name || '协作团队'
                        : roles.find((item) => item.id === message.senderId)?.name || '项目经理';
                    return (
                    <div className={`team-message ${message.senderType === 'owner' ? 'from-user' : 'from-pm'} ${message.status === 'blocked' ? 'blocked' : ''}`} key={message.id}>
                      <span className="message-label">
                        {author} <small>{formatTime(message.createdAt)}</small>
                        {message.status === 'blocked' && <em className="team-message-state">未发送</em>}
                      </span>
                      <p>{message.content}</p>
                      {!!message.attachments?.length && (
                        <div className="attachment-list" aria-label="消息附件">
                          {message.attachments.map((attachment) => (
                            <span className="attachment-chip" key={attachment.id}>
                              <Paperclip size={13} />
                              {attachment.name}
                              <small>{formatBytes(attachment.size)}</small>
                            </span>
                          ))}
                        </div>
                      )}
                      {message.kind === 'handoff' && relatedTask && (
                        <small className="team-message-collab-status">
                          跨团队任务 · {statusLabels[relatedTask.status] || relatedTask.status}
                        </small>
                      )}
                      {message.status === 'blocked' && (
                        <div className="team-message-blocked">
                          <span>{message.error || '项目经理正在处理上一条消息。'}</span>
                          {message.senderType === 'owner' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void retryTeamMessage(message)}
                            >
                              重新发送
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    );
                  })}
                  {teamTasks.length > 0 && (
                    <div className="team-activity">
                      <div className="team-activity-title"><Workflow size={14} /> 团队执行动态</div>
                      {teamTasks.slice(0, 8).map((task) => (
                        <button className="team-task-row" key={task.id} onClick={() => showTask(task)}>
                          <span className={`status-icon ${task.status}`}>
                            {task.status === 'running' ? <LoaderCircle size={13} className="spin" /> : task.status === 'completed' ? <Check size={13} /> : <Circle size={13} />}
                          </span>
                          <span>
                            <strong>{roles.find((item) => item.id === task.role)?.name || task.role}</strong>
                            <small>{task.title}</small>
                            {(task.result || task.error) && <small className="team-task-result">{(task.result || task.error).replace(/\s+/g, ' ').slice(0, 180)}</small>}
                            {taskVerification(task) && <small className={`team-task-proof ${task.verificationStatus || 'pending-review'}`}>验收 · {taskVerification(task)}{task.artifactCount ? ` · ${task.artifactCount} 项证据` : ''}</small>}
                          </span>
                          <em className={`status ${task.status}`}>{statusLabels[task.status]}</em>
                        </button>
                      ))}
                    </div>
                  )}
                  {!teamMessages.length && <div className="team-empty"><MessageSquare size={18} /> 还没有团队动态。完成一次任务后，进展会显示在这里。</div>}
                </div>
                <div className="team-readonly-note">
                  <div className="team-readonly-icon"><MessageSquare size={16} /></div>
                  <div>
                    <strong>新的需求从团队招募发起</strong>
                    <p>这里专门查看项目经理的拆解、成员状态和任务结果。</p>
                  </div>
                  <button className="text-button" onClick={openTeamConversation}>
                    {recruitment?.phase === 'confirmed' ? '回到团队对话' : '回到团队招募'} <ArrowRight size={13} />
                  </button>
                </div>
              </section>
              <aside className="team-roster-panel">
                <div className="team-roster-head"><div><span className="section-kicker">ROSTER</span><h2>协作成员</h2></div><span className="count-pill">{teamMembers.length}</span></div>
                <div className="team-member-list">
                  {teamMembers.map((member) => {
                    const MemberIcon = assistantIcons[member.icon as keyof typeof assistantIcons] || UserRound;
                    const memberTasks = teamTasks.filter((task) => task.role === member.id);
                    const active = memberTasks.filter(isActive).length;
                    const settings = teamSpace?.memberSettings?.[member.id];
                    const memberModel = settings?.modelHint || member.model || teamSpace?.model;
                    return (
                      <button className="team-member-card" key={member.id} onClick={() => { setRole(member.id); setView('workspace'); }}>
                        <span className="team-member-icon" style={{ color: member.color, background: `${member.color}18` }}><MemberIcon size={18} /></span>
                        <span className="team-member-copy">
                          <strong>{settings?.label || member.name}</strong>
                          {settings?.responsibility && <span className="team-member-responsibility">{settings.responsibility}</span>}
                          <small>{memberModel || '跟随工作空间模型'}</small>
                        </span>
                        <span className={`team-member-state ${active ? 'working' : ''}`}><span className="live-dot" />{active ? `${active} 项进行中` : '待命'}</span>
                      </button>
                    );
                  })}
                </div>
                {!rosterReady && <div className="team-roster-pending">Team Charter 确认后，候选成员才会创建并出现在这里。</div>}
                <div className="team-summary"><div className="team-summary-title"><ListChecks size={16} />任务总览</div><div className="team-metrics"><span><strong>{teamOpenTasks.length}</strong><small>进行中</small></span><span><strong>{teamTasks.filter((task) => task.status === 'completed').length}</strong><small>已完成</small></span></div><button className="text-button" onClick={() => setView('tasks')}>查看全部任务 <ArrowRight size={13} /></button></div>
              </aside>
            </div>
          </main>
        ) : isConversationView ? (
          <div className="working-grid" key={`workspace:${teamSpace?.id || 'none'}:${role}`}>
            <section className="conversation">
              <div className="conversation-top">
                <div>
                  <span className="section-kicker">{isRecruitmentView ? 'REQUIREMENT INTAKE · 需求发布' : isTeamConversation ? 'TEAM CONVERSATION · 协作推进' : 'AGENT CONVERSATION · 独立讨论'}</span>
                  <h1>
                    {isRecruitmentView ? '发布需求，招募团队' : isTeamConversation ? teamSpace?.name : assistantName}
                    <span className="quiet-badge">
                      {tasks.some((t) => t.role === role && isActive(t)) ? '工作中' : '随时开始'}
                    </span>
                  </h1>
                  <p className="conversation-subtitle">{isRecruitmentView ? '把要解决的问题、交付物和约束直接发给项目经理。团队名称会根据实际工作内容生成，确认后才会进入“我的团队”。' : isTeamConversation ? teamSpace?.goal : teamSpace?.memberSettings?.[role]?.responsibility || assistant.desc}</p>
                </div>
                <div className="conversation-controls">
                  {teamSpace && (isRecruiting ? recruitmentSpace : confirmedSpaces[0]) ? (
                    <Choice
                      label={isRecruiting ? '选择需求草稿' : '选择团队'}
                      value={teamSpace.id}
                      onChange={selectTeam}
                      options={isRecruiting
                        ? recruitmentSpaces.map((space) => ({ value: space.id, label: `需求草稿 · ${space.name}` }))
                        : confirmedSpaces.map((space) => ({ value: space.id, label: space.name }))}
                    />
                  ) : null}
                  <button className="secondary-button" type="button" disabled={busy || !activeRoles.length} onClick={() => void startRecruitment(true)}>
                    <Plus size={15} /> {isRecruitmentView ? '另起需求' : '发布新需求'}
                  </button>
                  {!isRecruitmentView && <button className="text-button" type="button" disabled={busy || !teamSpace} onClick={openTeamRename}><Pencil size={13} /> 重命名</button>}
                  {!isRecruitmentView && <button className="text-button" type="button" onClick={openTeamCreate}>高级配置</button>}
                  <button
                    className="icon-button"
                    title="编辑助手"
                    aria-label="编辑助手"
                    disabled={!assistant.id}
                    onClick={editRole}
                  >
                    <Settings2 size={18} />
                  </button>
                  {!isTeamConversation && <button
                    className="secondary-button"
                    onClick={() =>
                      setSelected((s) => ({ ...s, [role]: undefined }))
                    }
                  >
                    <Plus size={16} />
                    新会话
                  </button>
                  }
                </div>
              </div>
              {!isTeamConversation && <div className="session-picker">
                {sessions.length > 0 && (
                  <Choice
                    label="选择会话"
                    value={currentSession || ''}
                    onChange={(id) =>
                      setSelected((s) => ({ ...s, [role]: id }))
                    }
                    options={[
                      { value: '', label: '新会话' },
                      ...sessions.map((s) => ({ value: s.id, label: s.title })),
                    ]}
                  />
                )}
                <span>
                  <MessageSquare size={14} />
                  独立上下文
                </span>
              </div>}
              {isTeamConversation && recruitmentProposal && (
                <section
                  className={`recruitment-proposal-card${recruitment?.phase === 'confirmed' ? ' is-confirmed' : ''}`}
                  aria-label="团队招募方案"
                >
                  <button
                    className="recruitment-proposal-head"
                    type="button"
                    aria-expanded={charterExpanded}
                    onClick={() => setExpandedCharters((current) => ({ ...current, [charterKey]: !charterExpanded }))}
                  >
                    <div>
                      <span className="section-kicker">TEAM CHARTER</span>
                      <h2>{recruitmentProposal.teamName || teamSpace?.name || '团队方案'}</h2>
                    </div>
                    <span className="recruitment-head-actions">
                      <span className="recruitment-phase">
                        {recruitment?.phase === 'confirmed' ? '已确认' : '待你确认'}
                      </span>
                      <ChevronDown size={16} className={charterExpanded ? 'charter-chevron expanded' : 'charter-chevron'} />
                    </span>
                  </button>
                  {charterExpanded && <>
                    <p className="recruitment-proposal-goal">{recruitmentProposal.goal}</p>
                    <div className="recruitment-proposal-meta">
                      <span><Users size={14} />建议 {recruitmentProposal.size || recruitmentProposal.members.length} 位智能体</span>
                      {recruitmentProposal.purpose && <span>{recruitmentProposal.purpose}</span>}
                    </div>
                    <div className="recruitment-member-list">
                      {recruitmentProposal.members.map((member) => (
                        (() => {
                          const skillNames = (member.skillIds || []).map((id) =>
                            data?.skillCatalog.find((skill) => skill.id === id)?.name || id,
                          );
                          const capabilityNames = (member.capabilityIds || []).map((id) =>
                            data?.capabilities.find((capability) => capability.id === id)?.name || id,
                          );
                          const toolLabels = member.toolAccess
                            ? ([
                                ['files', '文件'],
                                ['web', '网页'],
                                ['terminal', '终端'],
                              ] as const)
                                .filter(([key]) => member.toolAccess?.[key] !== undefined)
                                .map(([key, label]) => `${label}${member.toolAccess?.[key] ? '已启用' : '未启用'}`)
                            : [];
                          return (
                            <div className="recruitment-member" key={member.memberId || `${member.roleId}-${member.name}`}>
                              <div className="recruitment-member-index">{(member.name || member.roleId || '成').slice(0, 1)}</div>
                              <div className="recruitment-member-copy">
                                <strong>{member.name || member.roleId || '未命名成员'}</strong>
                                <p>{member.responsibility}</p>
                                {member.modelHint && <small>模型：{member.modelHint}</small>}
                                {!!member.deliverables?.length && <small>交付：{member.deliverables.slice(0, 2).join(' · ')}</small>}
                                {!!member.skills?.length && <small>技能说明：{member.skills.slice(0, 3).join(' · ')}</small>}
                                {!!skillNames.length && <small>绑定 Skill：{skillNames.slice(0, 3).join(' · ')}</small>}
                                {!!member.tools?.length && <small>工具说明：{member.tools.slice(0, 3).join(' · ')}</small>}
                                {!!capabilityNames.length && <small>绑定能力：{capabilityNames.slice(0, 3).join(' · ')}</small>}
                                {member.toolAccess ? (
                                  !!toolLabels.length && <small>工具权限：{toolLabels.join(' · ')}</small>
                                ) : (
                                  <small>工具权限：沿用角色模板</small>
                                )}
                                {!!member.dependencies?.length && <small>依赖：{member.dependencies.slice(0, 2).join(' · ')}</small>}
                              </div>
                            </div>
                          );
                        })()
                      ))}
                    </div>
                    {!!recruitmentProposal.openQuestions?.length && (
                      <div className="recruitment-open-questions">
                        <strong>还需要你确认</strong>
                        <ul>{recruitmentProposal.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
                      </div>
                    )}
                    <div className="recruitment-proposal-actions">
                      {recruitment?.phase === 'confirmed' ? (
                        <span className="recruitment-confirmed"><Check size={15} />团队已创建，下一轮可以直接安排任务</span>
                      ) : (
                        <button className="primary-button" type="button" disabled={busy || !!recruitmentProposal.openQuestions?.length} onClick={() => void confirmTeamRecruitment()}>
                          <Check size={16} />{recruitmentProposal.openQuestions?.length ? '先补充信息' : '确认创建团队'}
                        </button>
                      )}
                      <button className="text-button" type="button" onClick={() => composerRef.current?.focus()}>
                        继续补充需求 <ArrowRight size={13} />
                      </button>
                    </div>
                  </>}
                </section>
              )}
              <div className="message-area">
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
                    <h2>{isRecruitmentView ? '发布你的需求' : assistant.greeting || assistantName}</h2>
                    <p>{isRecruitmentView ? '描述要解决的问题、交付物和限制条件。项目经理会和你多轮澄清，再判断需要几个智能体以及每个智能体的职责。' : teamSpace?.memberSettings?.[role]?.responsibility || assistant.desc}</p>
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
                            setDrafts((d) => ({ ...d, [draftKey]: p }))
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
                        {task.error && (
                          <p className="task-error">{task.error}</p>
                        )}
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
                                disabled={
                                  !activeRoles.some((r) => r.id !== task.role)
                                }
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
              <div className="composer-area">
                <div
                  className="composer"
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDraggingFiles(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setDraggingFiles(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDraggingFiles(false);
                    void uploadAttachments(Array.from(event.dataTransfer.files));
                  }}
                >
                  <textarea
                    ref={composerRef}
                    aria-label={`发送给${assistantName}`}
                    placeholder={isRecruitmentView ? '描述你想完成的事，先不用决定要几个智能体…' : `告诉${assistantName}，你想完成什么…`}
                    value={drafts[draftKey] || ''}
                    disabled={!assistant.id || assistant.archived}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))
                    }
                    onPaste={(event) => {
                      const files = clipboardFiles(event);
                      if (!files.length) return;
                      event.preventDefault();
                      void uploadAttachments(files);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (!busy) void submit();
                      }
                    }}
                  />
                  <div className={`composer-attachments${draggingFiles ? ' is-dragging' : ''}`}>
                    {draggingFiles ? <span>松开即可添加文件</span> : <span><Paperclip size={13} />拖入或粘贴图片、文件，发送时会携带文件内容</span>}
                    {!!draftAttachments[attachmentDraftKey]?.length && (
                      <div className="attachment-list draft-attachments">
                        {draftAttachments[attachmentDraftKey].map((attachment) => (
                          <button
                            type="button"
                            className="attachment-chip"
                            key={attachment.id}
                            title="移除附件"
                            onClick={() => setDraftAttachments((current) => ({
                              ...current,
                              [attachmentDraftKey]: current[attachmentDraftKey].filter((item) => item.id !== attachment.id),
                            }))}
                          >
                            <Paperclip size={13} />
                            {attachment.name}
                            <small>{formatBytes(attachment.size)} · 点击移除</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="composer-bottom">
                    <button className="workspace-path" onClick={openSettings}>
                      <FolderOpen size={15} />
                      <span>
                        {conversationWorkspace
                          ?.split('/')
                          .filter(Boolean)
                          .pop() || '选择工作目录'}
                      </span>
                    </button>
                    <div>
                      {selectedModelOption ? (
                        <label
                          className="model-switcher"
                          title={isTeamMember ? '切换当前团队成员使用的模型' : '仅切换本次独立对话使用的模型'}
                        >
                          <span className="sr-only">选择模型</span>
                          <select
                            aria-label="选择模型"
                            value={selectedModelOption.key}
                            disabled={busy}
                            onChange={(event) => void changeTeamModel(event.target.value)}
                          >
                            {modelOptions.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.providerName} · {modelDisplayName(option.model)}
                                {!option.model.tools ? ' · 纯文本' : ''}
                              </option>
                            ))}
                          </select>
                          <small className="model-id" title={`实际请求模型 ID：${selectedModelOption.model.id}`}>
                            ID: {selectedModelOption.model.id}
                          </small>
                          {!selectedModelOption.model.tools && (
                            <small>纯文本模式</small>
                          )}
                        </label>
                      ) : (
                        <span className="model-label">尚未配置模型</span>
                      )}
                      <button
                        className="send-button"
                        aria-label="发送任务"
                        disabled={
                          busy ||
                          (!drafts[draftKey]?.trim() && !draftAttachments[attachmentDraftKey]?.length) ||
                          !data ||
                          !assistant.id ||
                          assistant.archived
                        }
                        onClick={submit}
                      >
                        {busy ? (
                          <LoaderCircle size={18} className="spin" />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="composer-hint">
                  Enter 发送 · Shift + Enter 换行<span>{isRecruitmentView ? '先澄清需求，再确认团队方案' : '任务在后台执行'}</span>
                </p>
              </div>
            </section>
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
                        {capabilityKindLabels[capability.kind] || capability.kind} · {capability.name}
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
                <button
                  className="add-knowledge"
                  onClick={() => openKnowledge()}
                >
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
          </div>
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
              <span className="count-pill">{running.length} 个进行中</span>
            </div>
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
                <TabsTrigger value="done">已完成</TabsTrigger>
              </TabsList>
              {['all', 'active', 'done'].map((filter) => (
                <TabsContent key={filter} value={filter}>
                  <div className="task-list">
                    {tasks
                      .filter(
                        (t) =>
                          filter === 'all' ||
                          (filter === 'active'
                            ? isActive(t)
                            : t.status === 'completed'),
                      )
                      .map(taskCard)}
                  </div>
                  {!tasks.some(
                    (t) =>
                      filter === 'all' ||
                      (filter === 'active'
                        ? isActive(t)
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
          <main className="collection-page">
            <div className="page-heading">
              <div>
                <span className="section-kicker">SHARED KNOWLEDGE</span>
                <h1>每次工作，都有积累。</h1>
                <p>个人偏好、项目背景与角色经验，在本地长期保存。</p>
              </div>
              <button
                className="primary-button"
                onClick={() => openKnowledge()}
              >
                <Plus size={16} />
                添加知识
              </button>
            </div>
            <div className="knowledge-toolbar">
              <div className="search-field">
                <Search size={18} />
                <input
                  placeholder="搜索知识标题或内容…"
                  aria-label="搜索知识"
                  value={knowledgeSearch}
                  onChange={(e) => setKnowledgeSearch(e.target.value)}
                />
                {knowledgeSearch && (
                  <button
                    type="button"
                    className="clear-search-btn"
                    onClick={() => setKnowledgeSearch('')}
                    title="清空搜索"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="knowledge-filter-tags">
                {[
                  { id: 'all', label: '全部' },
                  { id: 'project', label: '项目共享' },
                  { id: 'personal', label: '个人知识' },
                  ...roles.map((r) => ({ id: r.id, label: r.name })),
                ].map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={`filter-pill ${knowledgeFilterScope === tag.id ? 'active' : ''}`}
                    onClick={() => setKnowledgeFilterScope(tag.id)}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
            </div>
            {(() => {
              const currentWorkspace = data?.config.workspace;
              const scopedKnowledge = (data?.knowledge || []).filter(
                (k) => k.scope === 'personal' || k.projectPath === currentWorkspace,
              );
              const filteredKnowledge = scopedKnowledge
                .filter((k) => {
                  if (knowledgeFilterScope === 'all') return true;
                  return k.scope === knowledgeFilterScope;
                })
                .filter((k) =>
                  `${k.title} ${k.content}`
                    .toLowerCase()
                    .includes(knowledgeSearch.toLowerCase()),
                );

              if (!scopedKnowledge.length) {
                return (
                  <div className="collection-empty">
                    <BookOpen size={34} />
                    <h2>给助手一份共同的背景</h2>
                    <p>从项目介绍、开发约定，或你的工作偏好开始。</p>
                    <button
                      className="secondary-button"
                      onClick={() => openKnowledge()}
                    >
                      添加第一份知识
                    </button>
                  </div>
                );
              }

              if (!filteredKnowledge.length) {
                return (
                  <div className="collection-empty compact">
                    <Search size={28} />
                    <h2>未找到匹配的知识</h2>
                    <p>尝试更换搜索关键词或重置分类筛选。</p>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setKnowledgeSearch('');
                        setKnowledgeFilterScope('all');
                      }}
                    >
                      重置筛选条件
                    </button>
                  </div>
                );
              }

              return (
                <div className="knowledge-grid">
                  {filteredKnowledge.map((k) => (
                    <div className="knowledge-card-wrapper" key={k.id}>
                      <button
                        type="button"
                        className="knowledge-card-clickable"
                        onClick={() => openKnowledge(undefined, k)}
                      >
                        <div className="knowledge-card-header">
                          <div className="knowledge-card-meta">
                            <FileText size={18} />
                            <span className="quiet-badge">
                              {k.scope === 'personal'
                                ? '个人知识'
                                : k.scope === 'project'
                                  ? '项目共享'
                                  : roles.find((r) => r.id === k.scope)?.name}
                            </span>
                          </div>
                        </div>
                        <h3>{k.title}</h3>
                        <p>{k.content}</p>
                        <footer>
                          <span
                            className={k.state === 'confirmed' ? 'confirmed' : ''}
                          >
                            {k.state === 'confirmed' ? '已确认' : '待确认草稿'}
                          </span>
                          <span>{formatTime(k.updatedAt)}</span>
                        </footer>
                      </button>
                      <div className="knowledge-card-actions">
                        <button
                          type="button"
                          className="card-action-btn"
                          title="快速重命名"
                          onClick={() => {
                            setQuickRenameKnowledge(k);
                            setQuickRenameTitle(k.title);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="card-action-btn danger"
                          title="删除知识"
                          onClick={() => setKnowledgeToDelete(k)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </main>
        )}
      </div>
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
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => !open && setModal(null)}
      >
        <DialogContent className="work-dialog">
          <DialogTitle>
            {modal === 'settings'
              ? '工作空间设置'
              : modal === 'knowledge'
                ? '编辑知识'
                : modal === 'handoff'
                  ? '交给其他助手'
                  : modal === 'rename-team'
                    ? '重命名团队'
              : '手动创建团队'}
          </DialogTitle>
          <DialogDescription>
            {modal === 'settings'
              ? '配置应用于新任务；已经开始的任务保持当前配置。'
              : modal === 'knowledge'
                ? '保存到本地，后续任务会按相关性读取。'
                : modal === 'handoff'
                  ? '将目标、成果和补充要求传给目标助手，创建独立会话。'
                  : modal === 'rename-team'
                    ? '只修改团队显示名称，团队消息、成员和任务都会保留。'
                  : '每个团队拥有自己的职责、成员和工作目录。你可以在团队招募中切换团队，团队也可以通过项目经理互相协作。'}
          </DialogDescription>
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
                      setKnowledgeForm((f) => ({ ...f, scope }))
                    }
                    options={[
                      { value: 'personal', label: '个人 · 所有项目' },
                      { value: 'project', label: '项目 · 所有助手共享' },
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
                    onChange={(state) =>
                      setKnowledgeForm((f) => ({ ...f, state }))
                    }
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
              <div className="manage-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy}
                >
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
                          const result = await api<
                            Entity[] | { items: Entity[] }
                          >(`knowledge/${id}/history`);
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
                                const restoredContent = entityText(snapshot, 'content');
                                const restoredSource = entityText(snapshot, 'source');
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
                                setNotice('已恢复历史版本到表单，点击“保存知识”生效');
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
                  options={roles
                    .filter((r) => !r.archived && r.id !== handoffTask?.role)
                    .map((r) => ({ value: r.id, label: r.name }))}
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
                  onChange={(e) =>
                    setTeamRenameForm({ name: e.target.value })
                  }
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
          {modal === 'team' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const saved = await api<TeamSpace>('spaces', 'POST', {
                    name: teamForm.name,
                    goal: teamForm.goal,
                    purpose: teamForm.goal,
                    teamType: teamForm.teamType,
                    pmRoleId: teamForm.pmRoleId,
                    memberRoleIds: teamForm.memberRoleIds,
                    workspace: teamForm.workspace,
                    autonomy: { mode: teamForm.autonomyMode },
                    collaboration: {
                      enabled: teamForm.allowCollaboration,
                      autoHandoff: true,
                      sharedBoard: true,
                      allowedTeamIds: [],
                    },
                  });
                  setSelectedSpaceId(saved.id);
                  setRole(saved.pmRoleId);
                  setSelected((current) => ({ ...current, [saved.pmRoleId]: undefined }));
                  setModal(null);
                  setView('workspace');
                  setNotice(`团队“${saved.name}”已创建`);
                });
              }}
            >
              <label>
                团队名称
                <input
                  required
                  maxLength={80}
                  value={teamForm.name}
                  onChange={(e) => setTeamForm((form) => ({ ...form, name: e.target.value }))}
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
                  onChange={(e) => setTeamForm((form) => ({ ...form, goal: e.target.value }))}
                  placeholder="这个团队负责什么？什么结果代表完成？"
                />
              </label>
              <div className="form-grid two">
                <div className="field-label">
                  团队类型
                  <Choice
                    label="团队类型"
                    value={teamForm.teamType}
                    onChange={(teamType) => setTeamForm((form) => ({ ...form, teamType: teamType as TeamForm['teamType'] }))}
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
                    onChange={(pmRoleId) => setTeamForm((form) => ({
                      ...form,
                      pmRoleId,
                      memberRoleIds: form.memberRoleIds.includes(pmRoleId)
                        ? form.memberRoleIds
                        : [pmRoleId, ...form.memberRoleIds],
                    }))}
                    options={activeRoles.map((item) => ({ value: item.id, label: item.name }))}
                  />
                </div>
                <label>
                  工作目录
                  <input
                    required
                    value={teamForm.workspace}
                    onChange={(e) => setTeamForm((form) => ({ ...form, workspace: e.target.value }))}
                    placeholder="沿用工作空间目录"
                  />
                </label>
              </div>
              <label className="team-collaboration-toggle" aria-label="允许与其他团队协作">
                <input
                  type="checkbox"
                  checked={teamForm.allowCollaboration}
                  onChange={(e) => setTeamForm((form) => ({ ...form, allowCollaboration: e.target.checked }))}
                />
                <span><strong>允许与其他团队协作</strong><small>项目经理可以向其他团队请求支持，并共享任务状态。</small></span>
              </label>
              <fieldset className="team-member-picker">
                <legend>协作成员</legend>
                <div className="team-member-options">
                  {activeRoles.map((item) => (
                    <div key={item.id} className="team-member-option">
                      <input
                        id={`team-member-${item.id}`}
                        type="checkbox"
                        aria-label={`选择${item.name}`}
                        checked={teamForm.memberRoleIds.includes(item.id) || item.id === teamForm.pmRoleId}
                        disabled={item.id === teamForm.pmRoleId}
                        onChange={(e) => setTeamForm((form) => ({
                          ...form,
                          memberRoleIds: e.target.checked
                            ? [...new Set([...form.memberRoleIds, item.id])]
                            : form.memberRoleIds.filter((id) => id !== item.id),
                        }))}
                      />
                      <span><strong>{item.name}</strong><small>{item.desc}</small></span>
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="field-label">
                自驱模式
                <Choice
                  label="团队自驱模式"
                  value={teamForm.autonomyMode}
                  onChange={(autonomyMode) => setTeamForm((form) => ({ ...form, autonomyMode: autonomyMode as TeamForm['autonomyMode'] }))}
                  options={[
                    { value: 'auto', label: '自驱 · 自动拆解和推进' },
                    { value: 'assist', label: '协作 · 关键步骤先确认' },
                  ]}
                />
              </div>
              <button className="primary-button" type="submit" disabled={busy || !activeRoles.length}>
                <Plus size={16} /> 创建团队
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
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
              {(taskDetail.knowledgeIds || [])
                .map(
                  (id) => data?.knowledge.find((k) => k.id === id)?.title || id,
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
                  await api(
                    `knowledge/${quickRenameKnowledge.id}`,
                    'PUT',
                    {
                      ...quickRenameKnowledge,
                      title: quickRenameTitle.trim(),
                    },
                  );
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
