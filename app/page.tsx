'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  AlertTriangle,
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
  RefreshCw,
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
  workspaceMode?: 'shared' | 'isolated' | 'worktree' | 'snapshot' | null;
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
  deliveryStatus?: string | null;
  acceptanceDecision?: string | null;
  acceptanceNote?: string | null;
  currentRequirementVersion?: number | null;
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
  updatedAt?: Record<string, string>;
  revisions?: Record<string, number>;
  bases?: Record<string, DraftBase>;
};
type DraftBase = {
  content: string;
  attachmentIds: string[];
};
type DraftTextChange = {
  start: number;
  end: number;
  replacement: string;
};
type DraftConflict = {
  key: string;
  spaceId: string | null;
  roleId: string;
  localContent: string;
  remoteContent: string;
  localAttachments: Attachment[];
  remoteAttachments: Attachment[];
  remoteRevision?: number;
  remoteUpdatedAt?: string;
};
type ServerDraft = {
  spaceId: string | null;
  roleId: string;
  content: string;
  attachmentIds: string[];
  attachments: Attachment[];
  revision?: number;
  updatedAt?: string;
};
type RouteCache = {
  spaceId?: string;
  role?: string;
  view?: string;
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
  teamId?: string | null;
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
  updatedAt?: string;
  attachmentIds?: string[];
  attachments?: Attachment[];
};
type TeamTimelineItem = {
  id: string;
  type: 'message' | 'task' | 'task-event' | 'artifact' | 'verification' | 'acceptance' | 'attention';
  at: string;
  teamId?: string | null;
  teamName?: string | null;
  teamType?: string | null;
  messageId?: string;
  clientMessageId?: string | null;
  senderType?: TeamMessage['senderType'];
  senderId?: string;
  fromTeamId?: string | null;
  toTeamId?: string | null;
  relatedMessageId?: string | null;
  kind?: string;
  taskId?: string | null;
  content?: string;
  status?: string | null;
  error?: string | null;
  attachmentIds?: string[];
  attachments?: Attachment[];
  role?: string;
  title?: string;
  result?: string;
  workspaceMode?: string | null;
  artifactCount?: number;
  verificationStatus?: string | null;
  deliveryStatus?: string | null;
  acceptanceDecision?: string | null;
  acceptanceNote?: string | null;
  currentRequirementVersion?: number | null;
  eventType?: string;
  data?: unknown;
  name?: string;
  verified?: boolean;
};
type TimelineFilter = 'all' | 'messages' | 'execution' | 'evidence' | 'risk';
type TeamRisk = {
  id: string;
  sourceType: 'task' | 'attention';
  kind: 'execution' | 'delivery' | 'attention';
  status: string;
  title: string;
  detail: string;
  updatedAt: string;
  teamId: string;
  teamName: string;
  taskId?: string | null;
  jobId?: string | null;
  groupId?: string | null;
  deliveryStatus?: string | null;
  acceptanceDecision?: string | null;
  attentionId?: string;
};
type TeamRiskResponse = {
  items: TeamRisk[];
  hasMore: boolean;
  total: number;
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
  workspaceMode?: 'shared' | 'isolated' | 'worktree' | 'snapshot';
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
  timeline?: TeamTimelineItem[];
};
type TeamTemplate = {
  id: string;
  name: string;
  description?: string;
  sourceTeamId?: string | null;
  sourceTeamName?: string | null;
  teamType?: TeamForm['teamType'];
  goal: string;
  purpose?: string;
  model?: string | null;
  providerId?: string | null;
  workspaceMode?: TeamForm['workspaceMode'];
  pmRoleId: string;
  memberRoleIds: string[];
  responsibilities?: Record<string, string>;
  memberSettings?: TeamSpace['memberSettings'];
  autonomy?: TeamSpace['autonomy'];
  collaboration?: TeamSpace['collaboration'];
  createdAt?: string;
  updatedAt?: string;
};
type TeamCollaborator = {
  id: string;
  chatId?: string;
  name: string;
  teamType?: string;
  purpose?: string;
  pmRoleId?: string;
  status?: string;
};
type TeamForm = {
  name: string;
  goal: string;
  pmRoleId: string;
  memberRoleIds: string[];
  allowedTeamIds: string[];
  workspace: string;
  workspaceMode: 'isolated' | 'worktree' | 'snapshot' | 'shared';
  teamType: 'custom' | 'development' | 'operations' | 'product' | 'project';
  allowCollaboration: boolean;
  autonomyMode: 'auto' | 'assist';
  model: string;
  providerId: string;
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
    checkedAt?: string | null;
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
  teamTemplates: TeamTemplate[];
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
  accepted: '已交付',
  'awaiting-owner': '待你验收',
  rejected: '已退回复核',
  'pending-review': '待复核',
};
const verificationLabels: Record<string, string> = {
  verified: '已验收',
  failed: '验证失败',
  'pending-review': '待验收',
  'needs-review': '需要复核',
  'awaiting-owner': '待你验收',
  accepted: '已交付',
  rejected: '已退回复核',
  stale: '验收已失效',
};
const capabilityKindLabels: Record<string, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  plugin: 'Plugin',
};
const isActive = (t: Task) => ['queued', 'running'].includes(t.status);
const taskVerification = (task: Task) => {
  if (task.deliveryStatus)
    return statusLabels[task.deliveryStatus] || verificationLabels[task.deliveryStatus] || task.deliveryStatus;
  return task.verificationStatus
    ? verificationLabels[task.verificationStatus] || task.verificationStatus
    : task.status === 'completed'
      ? '待验收'
      : '';
};
const taskNeedsOwnerAction = (task: Task) =>
  ['pending-review', 'awaiting-owner', 'rejected'].includes(
    task.deliveryStatus || task.verificationStatus || '',
  );
const taskNeedsAttention = (task: Task) =>
  ['blocked', 'failed', 'interrupted', 'state_unknown', 'budget-exceeded', 'budget_exceeded'].includes(task.status) ||
  (task.status !== 'completed' && Boolean(task.error));
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
const ROUTE_CACHE_KEY = 'ggb.workspace-route.v1';
const ROUTE_VIEWS = new Set([
  'workspace',
  'recruitment',
  'team',
  'assistants',
  'tasks',
  'knowledge',
  'jobs',
  'models',
  'resources',
  'nodes',
  'capabilities',
  'schedules',
  'attention',
  'backups',
]);
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
    const updatedAt = value?.updatedAt && typeof value.updatedAt === 'object' && !Array.isArray(value.updatedAt)
      ? Object.fromEntries(Object.entries(value.updatedAt).filter(([, timestamp]) => typeof timestamp === 'string'))
      : {};
    const revisions = value?.revisions && typeof value.revisions === 'object' && !Array.isArray(value.revisions)
      ? Object.fromEntries(Object.entries(value.revisions).filter(([, revision]) => Number.isSafeInteger(revision)))
      : {};
    const bases = value?.bases && typeof value.bases === 'object' && !Array.isArray(value.bases)
      ? Object.fromEntries(Object.entries(value.bases).filter(([, base]) =>
          !!base && typeof base === 'object' && !Array.isArray(base) &&
          typeof (base as DraftBase).content === 'string' &&
          Array.isArray((base as DraftBase).attachmentIds) &&
          (base as DraftBase).attachmentIds.every((id) => typeof id === 'string'),
        ).map(([key, base]) => [key, {
          content: (base as DraftBase).content,
          attachmentIds: (base as DraftBase).attachmentIds.slice(0, MAX_ATTACHMENTS),
        }]))
      : {};
    return { drafts, attachments, updatedAt, revisions, bases };
  } catch {
    return {};
  }
}

function draftChangeFromBase(base: string, next: string): DraftTextChange | null {
  if (base === next) return null;
  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start += 1;
  let baseEnd = base.length;
  let nextEnd = next.length;
  while (baseEnd > start && nextEnd > start && base[baseEnd - 1] === next[nextEnd - 1]) {
    baseEnd -= 1;
    nextEnd -= 1;
  }
  return { start, end: baseEnd, replacement: next.slice(start, nextEnd) };
}

function draftRangesOverlap(a: DraftTextChange, b: DraftTextChange) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function mergeDraftText(base: string, local: string, remote: string) {
  if (local === remote) return { content: local, conflict: false };
  if (local === base) return { content: remote, conflict: false };
  if (remote === base) return { content: local, conflict: false };
  const localChange = draftChangeFromBase(base, local);
  const remoteChange = draftChangeFromBase(base, remote);
  if (!localChange || !remoteChange) return { content: localChange ? local : remote, conflict: false };
  if (localChange.start === remoteChange.start && localChange.end === remoteChange.end &&
      localChange.replacement === remoteChange.replacement) {
    return { content: local, conflict: false };
  }
  if (draftRangesOverlap(localChange, remoteChange)) return { content: local, conflict: true };
  const changes = [localChange, remoteChange].sort((a, b) => b.start - a.start);
  let content = base;
  for (const change of changes) content = content.slice(0, change.start) + change.replacement + content.slice(change.end);
  return { content, conflict: false };
}

function mergeDraftAttachments(local: Attachment[], remote: Attachment[]) {
  const merged = new Map<string, Attachment>();
  for (const attachment of [...local, ...remote]) merged.set(attachment.id, attachment);
  return [...merged.values()].slice(0, MAX_ATTACHMENTS);
}
function readRouteCache(): RouteCache {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(ROUTE_CACHE_KEY) || '{}') as RouteCache;
    return {
      ...(typeof value?.spaceId === 'string' ? { spaceId: value.spaceId } : {}),
      ...(typeof value?.role === 'string' ? { role: value.role } : {}),
      ...(typeof value?.view === 'string' && ROUTE_VIEWS.has(value.view) ? { view: value.view } : {}),
    };
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

function RiskInbox({
  teams,
  onOpenTeam,
  onOpenTask,
}: {
  teams: TeamSpace[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [teamFilter, setTeamFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [items, setItems] = useState<TeamRisk[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const kindLabels: Record<string, string> = {
    execution: '执行风险',
    delivery: '交付风险',
    attention: '待确认事项',
  };
  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<TeamRiskResponse>(`risks?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems(page.items || []);
      setTotal(page.total || 0);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.updatedAt}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
      setItems([]);
      setTotal(0);
      setHasMore(false);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [kindFilter, teamFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirstPage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage]);
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '50', before: nextCursor });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<TeamRiskResponse>(`risks?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems((current) => [...current, ...(page.items || [])]);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.updatedAt}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="risk-inbox" aria-label="跨团队风险">
      <div className="risk-inbox-head">
        <div>
          <span className="section-kicker">TEAM RISKS</span>
          <h2>跨团队风险</h2>
          <p>把失败执行、交付复核和需要确认的事项放在一个入口。</p>
        </div>
        <div className="risk-inbox-summary">
          <span className="count-pill needs-review">{total} 项待处理</span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新跨团队风险"
            onClick={() => void loadFirstPage()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="risk-inbox-toolbar">
        <label>
          <span>团队</span>
          <select aria-label="风险团队" value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}>
            <option value="all">全部已创建团队</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select aria-label="风险类型" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
            <option value="all">全部风险</option>
            <option value="execution">执行风险</option>
            <option value="delivery">交付风险</option>
            <option value="attention">待确认事项</option>
          </select>
        </label>
      </div>
      {error && <div className="risk-inbox-error">{error}</div>}
      {items.length > 0 ? (
        <div className="risk-inbox-list">
          {items.map((item) => (
            <button
              type="button"
              className="risk-inbox-item"
              key={item.id}
              aria-label={`打开风险 ${item.title}`}
              onClick={() => item.taskId ? onOpenTask(item.taskId) : onOpenTeam(item.teamId)}
            >
              <span className={`risk-inbox-icon ${item.kind}`}><AlertTriangle size={15} /></span>
              <span className="risk-inbox-copy">
                <strong>{item.title}</strong>
                <small>{item.teamName} · {kindLabels[item.kind] || item.kind} · {item.detail}</small>
              </span>
              <em>{statusLabels[item.status] || verificationLabels[item.status] || item.status}</em>
            </button>
          ))}
          {hasMore && (
            <button type="button" className="risk-inbox-more" onClick={() => void loadMore()} disabled={loading}>
              {loading ? '加载中…' : '加载更早风险'}
            </button>
          )}
        </div>
      ) : (
        <div className="risk-inbox-empty">
          <Check size={20} />
          <span>{loading ? '正在检查团队风险…' : '当前没有需要处理的跨团队风险。'}</span>
        </div>
      )}
    </section>
  );
}

function CrossTeamTimeline({
  teams,
  onOpenTeam,
  onOpenTask,
}: {
  teams: TeamSpace[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [teamFilter, setTeamFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [items, setItems] = useState<TeamTimelineItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const kindLabels: Record<string, string> = {
    all: '全部动态',
    messages: '消息',
    execution: '执行',
    evidence: '证据',
    risk: '风险',
  };
  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '60' });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<{ items: TeamTimelineItem[]; hasMore: boolean }>(`timeline?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems(page.items || []);
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.at}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
      setItems([]);
      setHasMore(false);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [kindFilter, teamFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirstPage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage]);
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '60', before: nextCursor });
      if (teamFilter !== 'all') query.set('teamId', teamFilter);
      if (kindFilter !== 'all') query.set('kind', kindFilter);
      const page = await api<{ items: TeamTimelineItem[]; hasMore: boolean }>(`timeline?${query.toString()}`);
      const last = page.items?.[page.items.length - 1];
      setItems((current) => {
        const merged = new Map([...page.items, ...current].map((item) => [item.id, item]));
        return [...merged.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      });
      setHasMore(page.hasMore === true);
      setNextCursor(last ? `${last.at}|${last.id}` : null);
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const renderItem = (item: TeamTimelineItem) => {
    const title = item.type === 'message'
      ? '团队消息'
      : item.type === 'task'
        ? item.title || '后台任务'
        : item.type === 'task-event'
          ? `执行事件 · ${item.eventType || 'event'}`
          : item.type === 'acceptance'
            ? item.acceptanceDecision === 'accepted' ? '所有者通过交付' : '所有者退回复核'
            : item.type === 'verification'
              ? `验收证据 · ${item.name || '未命名验证'}`
              : `产物 · ${item.name || '未命名产物'}`;
    const detail = item.type === 'message'
      ? item.content || '团队消息'
      : item.type === 'task'
        ? item.error || item.result || statusLabels[item.deliveryStatus || item.status || ''] || item.status || '任务状态已更新'
        : item.type === 'acceptance'
          ? item.acceptanceNote || '所有者已记录交付决定'
          : item.type === 'task-event'
            ? item.data && typeof item.data === 'object' && 'reason' in item.data
              ? String(item.data.reason)
              : '执行事件已记录'
            : item.status
              ? `状态：${statusLabels[item.status] || item.status}`
              : '已记录到团队交付证据';
    const open = () => item.taskId ? onOpenTask(item.taskId) : item.teamId ? onOpenTeam(item.teamId) : undefined;
    return (
      <button
        type="button"
        className="cross-team-timeline-item"
        key={item.id}
        aria-label={`打开团队动态 ${item.teamName || '团队'} ${title}`}
        onClick={open}
        disabled={!item.teamId}
      >
        <span className="cross-team-timeline-team">{item.teamName || '团队'} · {kindLabels[kindFilter] || '团队动态'}</span>
        <span className="cross-team-timeline-copy">
          <strong>{title}</strong>
          <small>{detail.replace(/\s+/g, ' ').slice(0, 220)} · {formatTime(item.at)}</small>
        </span>
      </button>
    );
  };
  return (
    <section className="cross-team-timeline" aria-label="跨团队统一时间线">
      <div className="cross-team-timeline-head">
        <div>
          <span className="section-kicker">ALL TEAMS</span>
          <h2>全部团队动态</h2>
          <p>在一个时间线上查看各团队的消息、执行和交付证据。</p>
        </div>
        <div className="cross-team-timeline-summary">
          <span className="count-pill">{teams.length} 个团队</span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新跨团队时间线"
            onClick={() => void loadFirstPage()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="cross-team-timeline-toolbar">
        <label>
          <span>团队</span>
          <select aria-label="统一时间线团队" value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}>
            <option value="all">全部已创建团队</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select aria-label="统一时间线类型" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
            {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="cross-team-timeline-error">{error}</div>}
      {items.length > 0 ? (
        <div className="cross-team-timeline-list">
          {items.map(renderItem)}
          {hasMore && (
            <button type="button" className="timeline-load-more cross-team-timeline-more" onClick={() => void loadMore()} disabled={loading}>
              {loading ? '加载中…' : '加载更早动态'}
            </button>
          )}
        </div>
      ) : (
        <div className="cross-team-timeline-empty">
          <History size={18} />
          <span>{loading ? '正在加载团队动态…' : '当前筛选没有团队动态。'}</span>
        </div>
      )}
    </section>
  );
}

function TeamCollaborationConsole({
  team,
  teams,
  tasks,
  onOpenTeam,
  onOpenTask,
  onChanged,
}: {
  team: TeamSpace;
  teams: TeamSpace[];
  tasks: Task[];
  onOpenTeam: (teamId: string) => void;
  onOpenTask: (taskId: string) => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [collaborators, setCollaborators] = useState<TeamCollaborator[]>([]);
  const [targetTeamId, setTargetTeamId] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lastCreated, setLastCreated] = useState<(TeamMessage & {
    sourceTeamId?: string;
    targetTeamId?: string;
    sessionId?: string;
  }) | null>(null);
  const confirmed = team.recruitment?.phase === 'confirmed';
  const enabled = team.collaboration?.enabled !== false;
  const target = collaborators.find((item) => item.id === targetTeamId);
  const teamById = new Map(teams.map((item) => [item.id, item]));
  const taskById = new Map(tasks.map((item) => [item.id, item]));

  const loadCollaborators = useCallback(async () => {
    if (!confirmed || !enabled) {
      setCollaborators([]);
      setTargetTeamId('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api<TeamCollaborator[]>(`teams/${team.id}/collaborators`);
      setCollaborators(Array.isArray(result) ? result : []);
    } catch (rawError) {
      setCollaborators([]);
      setError((rawError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [confirmed, enabled, team.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCollaborators(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCollaborators]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTargetTeamId((current) => {
        if (current && collaborators.some((item) => item.id === current)) return current;
        return collaborators[0]?.id || '';
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [collaborators]);

  const messages = [...(team.messages || [])]
    .filter((message) => message.kind === 'handoff' || (
      message.kind === 'reply' && Boolean(message.relatedMessageId || message.fromTeamId)
    ))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

  const statusLabel = (message: TeamMessage, task?: Task) => {
    if (task) {
      const status = task.deliveryStatus || task.verificationStatus || task.status;
      return statusLabels[status] || verificationLabels[status] || status;
    }
    return statusLabels[message.status] || message.status;
  };

  async function submitCollaboration(event: { preventDefault: () => void }) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!targetTeamId) {
      setError('请先选择目标团队。');
      return;
    }
    if (!trimmed) {
      setError('请说明希望目标团队完成的协作目标。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const clientMessageId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const created = await api<TeamMessage & {
        sourceTeamId?: string;
        targetTeamId?: string;
        sessionId?: string;
      }>(`teams/${team.id}/collaborate`, 'POST', {
        targetTeamId,
        content: trimmed,
        clientMessageId,
      });
      setContent('');
      setLastCreated(created);
      await onChanged?.();
    } catch (rawError) {
      setError((rawError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="team-collaboration-console" aria-label="团队协作控制台">
      <div className="team-collaboration-head">
        <div>
          <span className="section-kicker">TEAM HANDOFF</span>
          <h2>跨团队协作</h2>
          <p>把清晰的协作目标交给另一个团队，由目标团队自己的项目经理接收、拆解和回传结果。</p>
        </div>
        <span className={`team-collaboration-state ${enabled && confirmed ? 'ready' : ''}`}>
          <span className="live-dot" />
          {confirmed ? (enabled ? `${collaborators.length} 个可协作团队` : '协作已关闭') : '招募确认后可用'}
        </span>
      </div>
      {!confirmed || !enabled ? (
        <div className="team-collaboration-disabled">
          <Users size={17} />
          <span>{!confirmed ? '当前团队还在招募阶段。确认 Team Charter 后，才能委派给其他团队。' : '团队设置已关闭跨团队协作。需要时可在团队设置中重新开启。'}</span>
        </div>
      ) : (
        <form className="team-collaboration-form" onSubmit={submitCollaboration}>
          <label>
            <span>目标团队</span>
            <select
              aria-label="选择协作目标团队"
              value={targetTeamId}
              onChange={(event) => setTargetTeamId(event.target.value)}
              disabled={loading || submitting || collaborators.length === 0}
            >
              {!collaborators.length && <option value="">暂无可协作团队</option>}
              {collaborators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {target && (
            <div className="team-collaboration-target">
              <strong>{target.name}</strong>
              <span>{target.purpose || '目标团队将由自己的项目经理判断是否接受并安排执行。'}</span>
            </div>
          )}
          <label className="team-collaboration-content">
            <span>协作目标</span>
            <textarea
              aria-label="协作目标"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：请检查本次发布的监控、回滚和故障响应清单，并回传可执行建议。"
              rows={3}
              maxLength={32000}
              disabled={submitting || collaborators.length === 0}
            />
          </label>
          <div className="team-collaboration-form-footer">
            <small>目标团队会在自己的任务队列中看到这条请求；你可以在下面跟踪任务和回传。</small>
            <button className="primary-button" type="submit" disabled={submitting || loading || collaborators.length === 0}>
              {submitting ? '发送中…' : '发起跨团队协作'} <ArrowRight size={14} />
            </button>
          </div>
        </form>
      )}
      {error && <div className="team-collaboration-error">{error}</div>}
      {lastCreated && (
        <output className="team-collaboration-success">
          <Check size={15} />
          <span>协作请求已发送给 {teamById.get(lastCreated.targetTeamId || targetTeamId)?.name || target?.name || '目标团队'}。</span>
          {lastCreated.taskId && <button type="button" onClick={() => onOpenTask(lastCreated.taskId!)}>查看任务</button>}
        </output>
      )}
      <div className="team-collaboration-history">
        <div className="team-collaboration-history-head">
          <strong>最近协作</strong>
          {messages.length > 0 && <span>{messages.length} 条记录</span>}
        </div>
        {messages.length > 0 ? messages.map((message) => {
          const outgoing = message.fromTeamId === team.id;
          const relatedTeamId = outgoing ? message.toTeamId : message.fromTeamId;
          const relatedTeam = relatedTeamId ? teamById.get(relatedTeamId) : undefined;
          const relatedTask = message.taskId ? taskById.get(message.taskId) : undefined;
          const relatedName = relatedTeam?.name || (outgoing ? '目标团队' : '协作团队');
          return (
            <article className="team-collaboration-item" key={message.id}>
              <div className="team-collaboration-item-main">
                <span className="team-collaboration-item-icon"><Workflow size={14} /></span>
                <div>
                  <strong>{outgoing ? `发给 ${relatedName}` : `来自 ${relatedName}`}</strong>
                  <small>{message.kind === 'reply' ? '目标团队回传' : '协作请求'} · {formatTime(message.createdAt)}</small>
                </div>
                <em className={message.status === 'blocked' ? 'blocked' : ''}>{statusLabel(message, relatedTask)}</em>
              </div>
              <p>{message.content}</p>
              <div className="team-collaboration-item-actions">
                {relatedTeamId && <button type="button" onClick={() => onOpenTeam(relatedTeamId)}>打开团队</button>}
                {relatedTask && <button type="button" onClick={() => onOpenTask(relatedTask.id)}>查看任务</button>}
              </div>
            </article>
          );
        }) : (
          <div className="team-collaboration-empty"><Workflow size={16} /> 发起一次协作后，这里会显示目标团队、任务状态和回传结果。</div>
        )}
      </div>
    </section>
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
    'settings' | 'knowledge' | 'handoff' | 'team' | 'rename-team' | 'team-template' | null
  >(null);
  const [teamRenameForm, setTeamRenameForm] = useState({ name: '' });
  const [teamTemplateForm, setTeamTemplateForm] = useState({ name: '', description: '' });
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
  const [selectedReviewTaskIds, setSelectedReviewTaskIds] = useState<string[]>([]);
  const [batchReviewNote, setBatchReviewNote] = useState('');
  const [batchReviewBusy, setBatchReviewBusy] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [timelineHistory, setTimelineHistory] = useState<Record<string, TeamTimelineItem[]>>({});
  const [timelineHasMore, setTimelineHasMore] = useState<Record<string, boolean>>({});
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [expandedCharters, setExpandedCharters] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const routeInitialized = useRef(false);
  const draftCacheHydrated = useRef(false);
  const [draftCacheReady, setDraftCacheReady] = useState(false);
  const draftDirtyRef = useRef<Set<string>>(new Set());
  const draftRevisionRef = useRef<Record<string, number>>({});
  const draftUpdatedAtRef = useRef<Record<string, string>>({});
  const draftBaseRef = useRef<Record<string, DraftBase>>({});
  const draftVersionRef = useRef<Record<string, number>>({});
  const draftTimersRef = useRef<Record<string, number>>({});
  const activeDraftKeyRef = useRef('');
  const draftsRef = useRef<Record<string, string>>({});
  const draftAttachmentsRef = useRef<Record<string, Attachment[]>>({});
  const [draftSyncState, setDraftSyncState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'conflict'>('idle');
  const [draftConflict, setDraftConflict] = useState<DraftConflict | null>(null);
  const [recruitmentSyncState, setRecruitmentSyncState] = useState<'idle' | 'syncing' | 'synced' | 'offline'>('idle');
  const recruitmentCursorRef = useRef<Record<string, string>>({});
  const roles = data?.roles || [];
  const activeRoles = roles.filter((r) => !r.archived);
  const teamTemplates = data?.teamTemplates || [];
  const assistant = roles.find((r) => r.id === role) || {
    ...blankAssistant,
    name: data ? '暂无助手' : '载入中',
  };
  const Icon =
    assistantIcons[assistant.icon as keyof typeof assistantIcons] || Sparkles;
  const tasks = data?.tasks || [];
  const allSessions = (data?.sessions || []).filter((s) => s.role === role);
  const reviewTasks = tasks.filter(taskNeedsOwnerAction);
  const allReviewTasksSelected = reviewTasks.length > 0 && reviewTasks.every((task) => selectedReviewTaskIds.includes(task.id));
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
  const primarySpace = confirmedSpaces[0] || recruitmentSpaces[0] || spaces[0];
  const teamSpace =
    spaces.find((space) => space.id === selectedSpaceId) ||
    primarySpace;
  const isRecruitmentView = view === 'recruitment';
  const isConversationView = view === 'workspace' || isRecruitmentView;
  const isTeamConversation = teamSpace?.pmRoleId === role;
  const assistantName = teamSpace?.memberSettings?.[role]?.label || assistant.name;
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
  const currentServerTimeline = teamSpace?.timeline || [];
  const currentTimelineHistory = teamSpace ? timelineHistory[teamSpace.id] || [] : [];
  const teamTimeline = [...currentTimelineHistory, ...currentServerTimeline].sort((a, b) =>
    a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  );
  const teamTimelineHasMore = teamSpace
    ? timelineHasMore[teamSpace.id] ?? currentServerTimeline.length >= 120
    : false;
  const teamTasks = tasks.filter((task) => task.spaceId === teamSpace?.id);
  const legacyTeamTimeline: TeamTimelineItem[] = [
    ...teamMessages.map((message) => ({
      id: `message:${message.id}`,
      type: 'message' as const,
      at: message.createdAt,
      messageId: message.id,
      clientMessageId: message.clientMessageId || null,
      senderType: message.senderType,
      senderId: message.senderId,
      fromTeamId: message.fromTeamId || null,
      toTeamId: message.toTeamId || null,
      relatedMessageId: message.relatedMessageId || null,
      kind: message.kind,
      taskId: message.taskId || null,
      content: message.content,
      status: message.status,
      error: message.error || null,
      attachmentIds: message.attachmentIds || [],
      attachments: message.attachments || [],
    })),
    ...teamTasks.slice(0, 8).map((task) => ({
      id: `task:${task.id}`,
      type: 'task' as const,
      at: task.createdAt,
      taskId: task.id,
      role: task.role,
      title: task.title,
      status: task.status,
      result: task.result || '',
      error: task.error || '',
      workspaceMode: task.workspaceMode || null,
      artifactCount: task.artifactCount || 0,
      verificationStatus: task.verificationStatus || null,
      deliveryStatus: task.deliveryStatus || null,
      acceptanceDecision: task.acceptanceDecision || null,
      acceptanceNote: task.acceptanceNote || null,
    })),
  ];
  const timelineItems = teamTimeline.length > 0 ? teamTimeline : legacyTeamTimeline;
  const timelineNeedsAttention = (item: TeamTimelineItem) => {
    if (item.type === 'message') return item.status === 'blocked' || Boolean(item.error);
    if (item.type === 'task') {
      return [
        'blocked',
        'failed',
        'interrupted',
        'state_unknown',
        'budget-exceeded',
        'budget_exceeded',
      ].includes(item.status || '') || item.deliveryStatus === 'rejected' || Boolean(item.error);
    }
    if (item.type === 'task-event') return /fail|error|block|interrupt|budget/i.test(item.eventType || '');
    if (item.type === 'acceptance') return item.acceptanceDecision === 'rejected';
    if (item.type === 'attention') return item.status !== 'resolved';
    return false;
  };
  const visibleTeamTimeline = timelineItems.filter((item) => {
    if (timelineFilter === 'messages') return item.type === 'message';
    if (timelineFilter === 'execution') return item.type === 'task' || item.type === 'task-event';
    if (timelineFilter === 'evidence') return item.type === 'artifact' || item.type === 'verification' || item.type === 'acceptance';
    if (timelineFilter === 'risk') return timelineNeedsAttention(item);
    return true;
  });
  const timelineFilterOptions: Array<{ id: TimelineFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'messages', label: '消息' },
    { id: 'execution', label: '执行' },
    { id: 'evidence', label: '证据' },
    { id: 'risk', label: '风险' },
  ];
  const teamOpenTasks = teamTasks.filter(isActive);
  const teamReviewTasks = teamTasks.filter(taskNeedsOwnerAction);
  const teamRiskTasks = teamTasks.filter(taskNeedsAttention);
  const teamEvidenceCount = teamTasks.reduce(
    (total, task) => total + (task.artifactCount || 0),
    0,
  );
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
        providerHealth: provider.health && provider.health.model === model.id
          ? provider.health
          : null,
        model,
      })),
    );
  const modelOverrideKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const draftKey = `${teamSpace?.id || 'standalone'}:${role}`;
  const attachmentDraftKey = draftKey;
  const currentMemberSettings = teamSpace?.memberSettings?.[role];
  const dataReady = !!data;
  const isTeamMember = !!teamSpace?.memberRoleIds.includes(role);
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
      (k.scope === 'team' && k.teamId === teamSpace?.id) ||
      (k.projectPath === conversationWorkspace &&
        ['project', role].includes(k.scope)),
  );
  function draftQuery(spaceId: string | null, roleId: string) {
    const query = new URLSearchParams({ role: roleId });
    if (spaceId) query.set('spaceId', spaceId);
    return `drafts?${query.toString()}`;
  }
  async function loadServerDraft(spaceId: string | null, roleId: string) {
    return api<ServerDraft>(draftQuery(spaceId, roleId));
  }
  function setDraftSyncStateFor(key: string, state: 'idle' | 'saving' | 'saved' | 'offline' | 'conflict') {
    if (activeDraftKeyRef.current === key) setDraftSyncState(state);
  }
  function markDraftDirty(key: string) {
    draftDirtyRef.current.add(key);
    draftVersionRef.current[key] = (draftVersionRef.current[key] || 0) + 1;
    draftUpdatedAtRef.current[key] = new Date().toISOString();
    setDraftSyncStateFor(key, 'saving');
  }
  function clearDraftTimer(key: string) {
    const timer = draftTimersRef.current[key];
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    delete draftTimersRef.current[key];
  }
  function queueDraftSync(
    key: string,
    spaceId: string | null,
    roleId: string,
    content: string,
    attachmentIds: string[],
    delay = 650,
  ) {
    if (typeof window === 'undefined' || !draftDirtyRef.current.has(key)) return;
    clearDraftTimer(key);
    const version = draftVersionRef.current[key] || 0;
    draftTimersRef.current[key] = window.setTimeout(() => {
      delete draftTimersRef.current[key];
      void persistDraft(key, spaceId, roleId, content, attachmentIds, version);
    }, delay);
  }
  async function persistDraft(
    key: string,
    spaceId: string | null,
    roleId: string,
    content: string,
    attachmentIds: string[],
    version: number,
  ) {
    if (!draftDirtyRef.current.has(key) || draftVersionRef.current[key] !== version) return;
    setDraftSyncStateFor(key, 'saving');
    const revision = draftRevisionRef.current[key];
    try {
      const saved = await api<ServerDraft>('drafts', 'PUT', {
        spaceId,
        roleId,
        content,
        attachmentIds,
        ...(revision !== undefined ? { revision } : {}),
      });
      if (saved.revision !== undefined) draftRevisionRef.current[key] = saved.revision;
      else delete draftRevisionRef.current[key];
      draftBaseRef.current[key] = {
        content: saved.content,
        attachmentIds: saved.attachmentIds || attachmentIds,
      };
      if (draftVersionRef.current[key] !== version || !draftDirtyRef.current.has(key)) return;
      draftDirtyRef.current.delete(key);
      draftUpdatedAtRef.current[key] = saved.updatedAt || draftUpdatedAtRef.current[key] || new Date().toISOString();
      setDraftConflict((current) => current?.key === key ? null : current);
      setDraftSyncStateFor(key, 'saved');
    } catch (rawError) {
      const error = rawError as Error & { status?: number };
      if (error.status === 409) {
        try {
          const latest = await loadServerDraft(spaceId, roleId);
          const remoteAttachments = Array.isArray(latest.attachments)
            ? latest.attachments.filter((item): item is Attachment =>
                !!item && typeof item.id === 'string' && typeof item.name === 'string' &&
                typeof item.mime === 'string' && Number.isFinite(item.size),
              ).slice(0, MAX_ATTACHMENTS)
            : [];
          if (latest.revision !== undefined) draftRevisionRef.current[key] = latest.revision;
          const localContent = draftsRef.current[key] || content;
          const localAttachments = draftAttachmentsRef.current[key] || [];
          const remoteContent = typeof latest.content === 'string' ? latest.content : '';
          const remoteBase: DraftBase = {
            content: remoteContent,
            attachmentIds: latest.attachmentIds || remoteAttachments.map((item) => item.id),
          };
          const base = draftBaseRef.current[key];
          const mergedText = base
            ? mergeDraftText(base.content, localContent, remoteContent)
            : { content: localContent, conflict: true };
          if (!mergedText.conflict) {
            const mergedAttachments = mergeDraftAttachments(localAttachments, remoteAttachments);
            draftBaseRef.current[key] = remoteBase;
            draftsRef.current[key] = mergedText.content;
            draftAttachmentsRef.current[key] = mergedAttachments;
            setDrafts((current) => ({ ...current, [key]: mergedText.content }));
            setDraftAttachments((current) => ({ ...current, [key]: mergedAttachments }));
            markDraftDirty(key);
            queueDraftSync(
              key,
              spaceId,
              roleId,
              mergedText.content,
              mergedAttachments.map((item) => item.id),
              80,
            );
          } else {
            setDraftConflict({
              key,
              spaceId,
              roleId,
              localContent,
              remoteContent,
              localAttachments,
              remoteAttachments,
              remoteRevision: latest.revision,
              remoteUpdatedAt: latest.updatedAt,
            });
            setDraftSyncStateFor(key, 'conflict');
          }
          return;
        } catch {
          // Keep the local draft dirty when the remote version cannot be read.
        }
      }
      setDraftSyncStateFor(key, 'offline');
    }
  }

  function resolveDraftConflict(choice: 'local' | 'remote') {
    const conflict = draftConflict;
    if (!conflict) return;
    const { key } = conflict;
    clearDraftTimer(key);
    if (choice === 'remote') {
      draftsRef.current[key] = conflict.remoteContent;
      draftAttachmentsRef.current[key] = conflict.remoteAttachments;
      setDrafts((current) => ({ ...current, [key]: conflict.remoteContent }));
      setDraftAttachments((current) => ({ ...current, [key]: conflict.remoteAttachments }));
      draftBaseRef.current[key] = {
        content: conflict.remoteContent,
        attachmentIds: conflict.remoteAttachments.map((item) => item.id),
      };
      draftUpdatedAtRef.current[key] = conflict.remoteUpdatedAt || new Date().toISOString();
      draftDirtyRef.current.delete(key);
      setDraftConflict(null);
      setDraftSyncStateFor(key, 'saved');
      return;
    }
    const localContent = draftsRef.current[key] ?? conflict.localContent;
    const localAttachments = draftAttachmentsRef.current[key] ?? conflict.localAttachments;
    draftBaseRef.current[key] = {
      content: conflict.remoteContent,
      attachmentIds: conflict.remoteAttachments.map((item) => item.id),
    };
    if (conflict.remoteRevision !== undefined) draftRevisionRef.current[key] = conflict.remoteRevision;
    draftsRef.current[key] = localContent;
    draftAttachmentsRef.current[key] = localAttachments;
    setDraftConflict(null);
    markDraftDirty(key);
    queueDraftSync(
      key,
      conflict.spaceId,
      conflict.roleId,
      localContent,
      localAttachments.map((item) => item.id),
      80,
    );
  }
  async function clearServerDraft(
    key: string,
    spaceId: string | null,
    roleId: string,
    sentContent = '',
    sentAttachmentIds: string[] = [],
  ) {
    clearDraftTimer(key);
    try {
      let revision = draftRevisionRef.current[key];
      // A user can send before the 650 ms debounce finishes. Read the remote
      // record first so the successful send does not leave the just-sent text
      // queued for restoration on the next visit. Preserve a different remote
      // draft owned by another window, including an optimistic-concurrency
      // conflict discovered while saving this draft.
      try {
        const latest = await loadServerDraft(spaceId, roleId);
        if (!latest.revision) {
          delete draftRevisionRef.current[key];
          delete draftUpdatedAtRef.current[key];
          delete draftBaseRef.current[key];
          draftDirtyRef.current.delete(key);
          setDraftSyncStateFor(key, 'saved');
          return;
        }
        const sameContent = latest.content.trim() === sentContent.trim() &&
          JSON.stringify(latest.attachmentIds || []) === JSON.stringify(sentAttachmentIds);
        if (!sameContent) {
          delete draftRevisionRef.current[key];
          delete draftUpdatedAtRef.current[key];
          delete draftBaseRef.current[key];
          draftDirtyRef.current.delete(key);
          setDraftSyncStateFor(key, 'saved');
          return;
        }
        revision = latest.revision;
      } catch (error) {
        if (revision === undefined) throw error;
      }
      await api('drafts', 'DELETE', {
        spaceId,
        roleId,
        revision,
      });
      delete draftRevisionRef.current[key];
      delete draftUpdatedAtRef.current[key];
      delete draftBaseRef.current[key];
      draftDirtyRef.current.delete(key);
      setDraftConflict((current) => current?.key === key ? null : current);
      setDraftSyncStateFor(key, 'saved');
    } catch (rawError) {
      const error = rawError as Error & { status?: number };
      // Sending succeeded, so clear the local composer even if a stale remote
      // draft could not be removed. A 409 means another window owns a newer
      // revision; preserving it is safer than deleting that user's text.
      draftDirtyRef.current.delete(key);
      delete draftRevisionRef.current[key];
      delete draftUpdatedAtRef.current[key];
      delete draftBaseRef.current[key];
      setDraftSyncStateFor(key, error.status === 409 ? 'saved' : 'offline');
    }
  }
  const syncRecruitment = useCallback(async (spaceId: string) => {
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
            for (const message of page.messages || []) messages.set(message.id, message);
            return {
              ...space,
              recruitment: page.recruitment || space.recruitment,
              messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
            };
          }),
        };
      });
      if (page.cursor) recruitmentCursorRef.current[spaceId] = page.cursor;
      if (spaceId === selectedSpaceId) setRecruitmentSyncState('synced');
    } catch {
      if (spaceId === selectedSpaceId) setRecruitmentSyncState('offline');
    }
  }, [selectedSpaceId]);
  async function refresh() {
    try {
      const next = await api<State>('state');
      setData(next);
      const primary =
        next.spaces?.find((space) => space.status !== 'archived' && space.recruitment?.phase === 'confirmed') ||
        next.spaces?.find((space) => space.status !== 'archived') ||
        next.spaces?.[0];
      const cachedRoute = readRouteCache();
      const cachedSpace = cachedRoute.spaceId
        ? next.spaces?.find((space) =>
            space.id === cachedRoute.spaceId && space.status !== 'archived',
          )
        : null;
      setSelectedSpaceId((current) =>
        current && next.spaces?.some((space) => space.id === current && space.status !== 'archived')
          ? current
          : cachedSpace?.id || primary?.id || '',
      );
      if (!routeInitialized.current) {
        const initialSpace = cachedSpace || primary;
        const cachedRole = cachedRoute.role && initialSpace?.memberRoleIds.includes(cachedRoute.role) &&
          next.roles.some((item) => item.id === cachedRoute.role && !item.archived)
          ? cachedRoute.role
          : null;
        const preferred = cachedRole || initialSpace?.pmRoleId || next.roles.find((item) => !item.archived)?.id;
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
    const spaceId = isRecruitmentView && teamSpace?.id && teamSpace.recruitment?.phase !== 'confirmed'
      ? teamSpace.id
      : null;
    if (!spaceId) {
      const reset = window.setTimeout(() => setRecruitmentSyncState('idle'), 0);
      return () => window.clearTimeout(reset);
    }
    recruitmentCursorRef.current[spaceId] = recruitmentCursorRef.current[spaceId] || '';
    const initial = window.setTimeout(() => void syncRecruitment(spaceId), 0);
    const timer = window.setInterval(() => void syncRecruitment(spaceId), 2000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [isRecruitmentView, teamSpace?.id, teamSpace?.recruitment?.phase, syncRecruitment]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const cached = readDraftCache();
      setDrafts((current) => ({ ...cached.drafts, ...current }));
      setDraftAttachments((current) => ({ ...cached.attachments, ...current }));
      draftUpdatedAtRef.current = cached.updatedAt || {};
      draftRevisionRef.current = cached.revisions || {};
      draftBaseRef.current = cached.bases || {};
      draftCacheHydrated.current = true;
      setDraftCacheReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!draftCacheHydrated.current) return;
    try {
      window.localStorage.setItem(
        DRAFT_CACHE_KEY,
        JSON.stringify({
          drafts,
          attachments: draftAttachments,
          updatedAt: draftUpdatedAtRef.current,
          revisions: draftRevisionRef.current,
          bases: draftBaseRef.current,
        } satisfies DraftCache),
      );
    } catch {
      // Storage quotas and private browsing restrictions are both recoverable.
    }
  }, [drafts, draftAttachments, draftSyncState]);
  useEffect(() => {
    activeDraftKeyRef.current = draftKey;
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDraftConflict((current) => current && current.key !== draftKey ? null : current);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey]);
  useEffect(() => {
    draftsRef.current = drafts;
    draftAttachmentsRef.current = draftAttachments;
  }, [drafts, draftAttachments]);
  useEffect(() => {
    if (!draftCacheReady || !dataReady || !role || role === '__router__') return;
    const key = draftKey;
    const spaceId = teamSpace?.id || null;
    let cancelled = false;
    const restore = async () => {
      try {
        const remote = await loadServerDraft(spaceId, role);
        if (cancelled) return;
        const remoteAttachments = Array.isArray(remote.attachments)
          ? remote.attachments.filter((item): item is Attachment =>
              !!item && typeof item.id === 'string' && typeof item.name === 'string' &&
              typeof item.mime === 'string' && Number.isFinite(item.size),
            ).slice(0, MAX_ATTACHMENTS)
            : [];
        const remoteContent = typeof remote.content === 'string' ? remote.content : '';
        const remoteBase: DraftBase = {
          content: remoteContent,
          attachmentIds: remote.attachmentIds || remoteAttachments.map((item) => item.id),
        };
        const hadBase = !!draftBaseRef.current[key];
        if (!hadBase) draftBaseRef.current[key] = remoteBase;
        if (remote.revision !== undefined) draftRevisionRef.current[key] = remote.revision;
        else delete draftRevisionRef.current[key];
        if (draftDirtyRef.current.has(key)) return;
        const localContent = draftsRef.current[key] || '';
        const localAttachments = draftAttachmentsRef.current[key] || [];
        const remoteHasContent = !!remoteContent.trim() || remoteAttachments.length > 0;
        const localHasContent = !!localContent.trim() || localAttachments.length > 0;
        const localUpdatedAt = draftUpdatedAtRef.current[key];
        const remoteUpdatedAt = typeof remote.updatedAt === 'string' ? remote.updatedAt : '';
        const remoteIsNewer = remoteHasContent && (
          !localHasContent ||
          (!!remoteUpdatedAt && (!localUpdatedAt || remoteUpdatedAt > localUpdatedAt))
        );
        const localIsNewer = localHasContent && (
          !remoteHasContent ||
          (!!localUpdatedAt && !!remoteUpdatedAt && localUpdatedAt > remoteUpdatedAt)
        );
        const attachmentsDiffer = JSON.stringify(localAttachments.map((item) => item.id)) !==
          JSON.stringify(remoteBase.attachmentIds);
        const unknownBaseConflict = !hadBase && localHasContent && remoteHasContent &&
          (localContent !== remoteContent || attachmentsDiffer);
        if (unknownBaseConflict) {
          setDraftConflict({
            key,
            spaceId,
            roleId: role,
            localContent,
            remoteContent,
            localAttachments,
            remoteAttachments,
            remoteRevision: remote.revision,
            remoteUpdatedAt,
          });
          setDraftSyncStateFor(key, 'conflict');
        } else if (remoteIsNewer) {
          setDrafts((current) => ({ ...current, [key]: remoteContent }));
          setDraftAttachments((current) => ({ ...current, [key]: remoteAttachments }));
          draftBaseRef.current[key] = remoteBase;
          draftUpdatedAtRef.current[key] = remoteUpdatedAt || new Date().toISOString();
          setDraftSyncStateFor(key, 'saved');
        } else if (localIsNewer) {
          markDraftDirty(key);
          queueDraftSync(
            key,
            spaceId,
            role,
            localContent,
            localAttachments.map((item) => item.id),
          );
        } else if (!localHasContent && !remoteHasContent) {
          draftBaseRef.current[key] = remoteBase;
          setDraftSyncStateFor(key, 'idle');
        }
      } catch {
        if (!cancelled) setDraftSyncStateFor(key, 'offline');
      }
    };
    void restore();
    return () => {
      cancelled = true;
      clearDraftTimer(key);
    };
  }, [dataReady, draftCacheReady, draftKey, role, teamSpace?.id]);
  useEffect(() => {
    if (!draftCacheReady || !draftDirtyRef.current.has(draftKey)) return;
    queueDraftSync(
      draftKey,
      teamSpace?.id || null,
      role,
      draftsRef.current[draftKey] || '',
      (draftAttachmentsRef.current[attachmentDraftKey] || []).map((item) => item.id),
    );
  }, [attachmentDraftKey, draftCacheReady, draftKey, role, teamSpace?.id, drafts, draftAttachments]);
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
            [task.spaceId ? `${task.spaceId}:${task.role}` : task.role]: task.sessionId,
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
  function toggleReviewTask(taskId: string) {
    setSelectedReviewTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId],
    );
  }
  function toggleAllReviewTasks() {
    setSelectedReviewTaskIds((current) => {
      const ids = reviewTasks.map((task) => task.id);
      return ids.length > 0 && ids.every((id) => current.includes(id)) ? [] : ids;
    });
  }
  async function batchReview(decision: 'accept' | 'reject') {
    const selectedIds = selectedReviewTaskIds.filter((id) => reviewTasks.some((task) => task.id === id));
    if (!selectedIds.length) {
      setNotice('请先选择至少一项待处理交付。');
      return;
    }
    const note = batchReviewNote.trim();
    if (decision === 'reject' && !note) {
      setNotice('批量退回复核时需要填写统一的修改说明。');
      return;
    }
    setBatchReviewBusy(true);
    await action(async () => {
      const result = await api<{ succeeded: number; decision: string }>('tasks/batch-review', 'POST', {
        taskIds: selectedIds,
        decision,
        ...(note ? { note } : {}),
      });
      setSelectedReviewTaskIds([]);
      setBatchReviewNote('');
      setNotice(`已${decision === 'accept' ? '通过' : '退回'} ${result.succeeded || selectedIds.length} 项交付。`);
    });
    setBatchReviewBusy(false);
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
          ...((isTeamMember || isTeamConversation) && teamSpace?.id
            ? { teamId: teamSpace.id }
            : {}),
        }));
      }
      setDraftAttachments((current) => ({
        ...current,
        [attachmentDraftKey]: [...(current[attachmentDraftKey] || []), ...uploaded].slice(0, MAX_ATTACHMENTS),
      }));
      setDraftConflict((current) => current?.key === attachmentDraftKey
        ? {
            ...current,
            localAttachments: [...current.localAttachments, ...uploaded].slice(0, MAX_ATTACHMENTS),
          }
        : current);
      markDraftDirty(attachmentDraftKey);
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
    const content = drafts[draftKey] || '';
    const sentVersion = draftVersionRef.current[draftKey] || 0;
    if ((!content.trim() && !attachmentIds.length) || assistant.archived || !assistant.id) return;
    await action(async () => {
      // The single team-recruitment entry is the team's front door. Keep its messages in
      // the same space timeline so PM replies and delegated work stay linked.
      if (teamSpace?.pmRoleId === role) {
        const message = await api<TeamMessage & { sessionId?: string }>(
          `spaces/${teamSpace.id}/messages`,
          'POST',
          {
            clientMessageId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content,
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
          setSelected((s) => ({ ...s, [sessionSelectionKey]: message.sessionId }));
        }
        if (draftVersionRef.current[draftKey] === sentVersion) {
          await clearServerDraft(draftKey, teamSpace?.id || null, role, content, attachmentIds);
          setDrafts((s) => ({ ...s, [draftKey]: '' }));
          setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
        }
        return;
      }
      const task = await api<Task>('tasks', 'POST', {
        role,
        sessionId: currentSession,
        prompt: content,
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
      setSelected((s) => ({
        ...s,
        [task.spaceId ? `${task.spaceId}:${task.role}` : sessionSelectionKey]: task.sessionId,
      }));
      if (draftVersionRef.current[draftKey] === sentVersion) {
        await clearServerDraft(draftKey, teamSpace?.id || null, role, content, attachmentIds);
        setDrafts((s) => ({ ...s, [draftKey]: '' }));
        setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
      }
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
        setSelected((s) => ({ ...s, [sessionSelectionKey]: retried.sessionId }));
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
      setSelected((current) => ({ ...current, [`${saved.id}:${saved.pmRoleId}`]: undefined }));
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
        scope: task?.spaceId || teamSpace?.id ? 'team' : 'project',
        teamId: task?.spaceId || teamSpace?.id || null,
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
    setHandoffRole(handoffRoles(task)[0]?.id || '');
    setHandoffNote('');
    setModal('handoff');
  }
  function openTeamRename() {
    if (!teamSpace) return;
    setTeamRenameForm({ name: teamSpace.name });
    setModal('rename-team');
  }
  function openTeamSettings() {
    if (!teamSpace) return;
    const pm = activeRoles.find((item) => item.id === teamSpace.pmRoleId) || activeRoles[0];
    setEditingTeamId(teamSpace.id);
    setTeamForm({
      name: teamSpace.name,
      goal: teamSpace.goal,
      pmRoleId: teamSpace.pmRoleId || pm?.id || 'project_manager',
      memberRoleIds: teamSpace.memberRoleIds?.length
        ? [...teamSpace.memberRoleIds]
        : pm
          ? [pm.id]
          : [],
      allowedTeamIds: Array.isArray(teamSpace.collaboration?.allowedTeamIds)
        ? [...teamSpace.collaboration.allowedTeamIds]
        : [],
      workspace: teamSpace.workspace || data?.config.workspace || '',
      workspaceMode: teamSpace.workspaceMode || 'isolated',
      teamType: (teamSpace.teamType as TeamForm['teamType']) || 'custom',
      allowCollaboration: teamSpace.collaboration?.enabled !== false,
      autonomyMode: teamSpace.autonomy?.mode === 'assist' ? 'assist' : 'auto',
      model: teamSpace.model || '',
      providerId: teamSpace.providerId || '',
    });
    setTeamTemplateId('');
    setModal('team');
  }
  function openSaveTeamTemplate() {
    if (!teamSpace || teamSpace.recruitment?.phase !== 'confirmed') return;
    setTeamTemplateForm({
      name: `${teamSpace.name} 模板`,
      description: teamSpace.purpose || teamSpace.goal || '',
    });
    setModal('team-template');
  }
  function openCreateTeam(templateId = '') {
    const template = teamTemplates.find((item) => item.id === templateId);
    const pm = activeRoles.find((item) => item.id === (template?.pmRoleId || 'project_manager')) || activeRoles[0];
    const memberRoleIds = template?.memberRoleIds?.length
      ? [...template.memberRoleIds]
      : pm
        ? [pm.id]
        : [];
    setEditingTeamId(null);
    setTeamTemplateId(template?.id || '');
    setTeamForm({
      name: template ? `${template.name} · 新团队` : '',
      goal: template?.goal || '',
      pmRoleId: template?.pmRoleId || pm?.id || 'project_manager',
      memberRoleIds,
      allowedTeamIds: [],
      workspace: data?.config.workspace || '',
      workspaceMode: template?.workspaceMode || 'isolated',
      teamType: template?.teamType || 'custom',
      allowCollaboration: template?.collaboration?.enabled !== false,
      autonomyMode: template?.autonomy?.mode === 'assist' ? 'assist' : 'auto',
      model: template?.model || '',
      providerId: template?.providerId || '',
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
  async function loadOlderTeamTimeline() {
    const space = teamSpace;
    const earliest = teamTimeline[0];
    if (!space || !earliest || timelineLoading) return;
    setTimelineLoading(true);
    try {
      const cursor = encodeURIComponent(`${earliest.at}|${earliest.id}`);
      const page = await api<{ items: TeamTimelineItem[]; hasMore: boolean }>(
        `spaces/${space.id}/timeline?limit=60&before=${cursor}`,
      );
      setTimelineHistory((current) => {
        const existing = current[space.id] || [];
        const merged = new Map([...existing, ...(page.items || [])].map((item) => [item.id, item]));
        return {
          ...current,
          [space.id]: [...merged.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
        };
      });
      setTimelineHasMore((current) => ({ ...current, [space.id]: page.hasMore === true }));
    } catch (error) {
      setNotice(`加载更早团队动态失败：${(error as Error).message}`);
    } finally {
      setTimelineLoading(false);
    }
  }
  function selectTeam(id: string) {
    const next = data?.spaces?.find((space) => space.id === id);
    if (!next) return;
    setModal(null);
    // Execution records belong to the selected team. Never leave an open
    // inspector from Team A visible while the user is browsing Team B.
    setTaskDetail(null);
    setTimelineFilter('all');
    setSelectedSpaceId(next.id);
    setRole(next.pmRoleId);
  }
  function showTask(task: Task) {
    if (task.spaceId) setSelectedSpaceId(task.spaceId);
    setRole(task.role);
    setSelected((s) => ({
      ...s,
      [task.spaceId ? `${task.spaceId}:${task.role}` : task.role]: task.sessionId,
    }));
    setView('workspace');
  }
  function openRiskTeam(teamId: string) {
    selectTeam(teamId);
    setView('team');
    if (isMobile) setOpenMobile(false);
  }
  function openRiskTask(taskId: string) {
    const task = tasks.find((item) => item.id === taskId);
    if (task) showTask(task);
  }
  function handoffRoles(task: Task | null) {
    const team = task?.spaceId
      ? data?.spaces?.find((space) => space.id === task.spaceId)
      : null;
    return activeRoles.filter((item) =>
      item.id !== task?.role && (!team || team.memberRoleIds.includes(item.id)),
    );
  }
  function editRole() {
    setEditingAssistant(assistant);
  }
  const renderTeamTimelineItem = (item: TeamTimelineItem) => {
    const relatedTask = item.taskId
      ? tasks.find((task) => task.id === item.taskId)
      : null;
    if (item.type === 'message') {
      const outgoingCollaboration =
        item.kind === 'handoff' && item.fromTeamId === teamSpace?.id;
      const targetTeamName = data?.spaces?.find(
        (space) => space.id === item.toTeamId,
      )?.name;
      const author = item.senderType === 'owner'
        ? '你'
        : item.senderType === 'team'
          ? outgoingCollaboration
            ? `本团队 → ${targetTeamName || '协作团队'}`
            : data?.spaces?.find((space) => space.id === item.fromTeamId)?.name || '协作团队'
          : roles.find((roleItem) => roleItem.id === item.senderId)?.name || '项目经理';
      return (
        <div className={`team-message ${item.senderType === 'owner' ? 'from-user' : 'from-pm'} ${item.status === 'blocked' ? 'blocked' : ''}`} key={item.id}>
          <span className="message-label">
            {author} <small>{formatTime(item.at)}</small>
            {item.status === 'blocked' && <em className="team-message-state">未发送</em>}
          </span>
          <p>{item.content}</p>
          {!!item.attachments?.length && (
            <div className="attachment-list" aria-label="消息附件">
              {item.attachments.map((attachment) => (
                <span className="attachment-chip" key={attachment.id}>
                  <Paperclip size={13} />
                  {attachment.name}
                  <small>{formatBytes(attachment.size)}</small>
                </span>
              ))}
            </div>
          )}
          {item.kind === 'handoff' && relatedTask && (
            <small className="team-message-collab-status">
              跨团队任务 · {statusLabels[relatedTask.status] || relatedTask.status}
            </small>
          )}
          {item.status === 'blocked' && (
            <div className="team-message-blocked">
              <span>{item.error || '项目经理正在处理上一条消息。'}</span>
              {item.senderType === 'owner' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void retryTeamMessage({
                    id: item.messageId || item.id,
                    spaceId: teamSpace?.id || '',
                    clientMessageId: item.clientMessageId || null,
                    kind: item.kind || 'request',
                    senderType: 'owner',
                    senderId: item.senderId || 'owner',
                    content: item.content || '',
                    status: item.status || 'blocked',
                    error: item.error || null,
                    createdAt: item.at,
                    taskId: item.taskId || null,
                    attachmentIds: item.attachmentIds || [],
                    attachments: item.attachments || [],
                  })}
                >
                  重新发送
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    if (item.type === 'task') {
      const task = relatedTask;
      return (
        <button className="team-task-row" key={item.id} onClick={() => task && showTask(task)} disabled={!task}>
          <span className={`status-icon ${item.status || 'queued'}`}>
            {item.status === 'running' ? <LoaderCircle size={13} className="spin" /> : item.status === 'completed' ? <Check size={13} /> : <Circle size={13} />}
          </span>
          <span>
            <strong>{roles.find((roleItem) => roleItem.id === item.role)?.name || item.role}</strong>
            <small>{item.title} · {formatTime(item.at)}</small>
            {item.workspaceMode && <small className="team-task-mode">工作目录 · {item.workspaceMode === 'shared' ? '共享' : item.workspaceMode === 'worktree' ? 'Git worktree' : item.workspaceMode === 'snapshot' ? '快照' : '隔离'}</small>}
            {(item.result || item.error) && <small className="team-task-result">{(item.result || item.error || '').replace(/\s+/g, ' ').slice(0, 180)}</small>}
            {(item.deliveryStatus || item.verificationStatus) && <small className={`team-task-proof ${item.deliveryStatus || item.verificationStatus}`}>交付 · {task ? taskVerification(task) : (statusLabels[item.deliveryStatus || ''] || verificationLabels[item.deliveryStatus || ''] || item.deliveryStatus || item.verificationStatus)}{item.artifactCount ? ` · ${item.artifactCount} 项证据` : ''}</small>}
          </span>
          <em className={`status ${item.status || 'queued'}`}>{statusLabels[item.status || 'queued'] || item.status}</em>
        </button>
      );
    }
    if (item.type === 'acceptance') {
      const accepted = item.acceptanceDecision === 'accepted';
      const rejected = item.acceptanceDecision === 'rejected';
      const decisionLabel = accepted ? '所有者通过交付' : rejected ? '所有者退回复核' : '验收决定已更新';
      return (
        <button className={`team-timeline-record acceptance ${rejected ? 'rejected' : accepted ? 'accepted' : ''}`} key={item.id} onClick={() => relatedTask && showTask(relatedTask)} disabled={!relatedTask}>
          <span className="team-timeline-record-icon">{accepted ? <Check size={14} /> : <Undo2 size={14} />}</span>
          <span><strong>{decisionLabel}</strong><small>{item.acceptanceNote || '已记录所有者交付决定'} · v{item.currentRequirementVersion || 1} · {formatTime(item.at)}</small></span>
        </button>
      );
    }
    const title = item.type === 'task-event'
      ? `执行事件 · ${item.eventType || 'event'}`
      : item.type === 'verification'
        ? `验收证据 · ${item.name || '未命名验证'}`
        : `产物 · ${item.name || '未命名产物'}`;
    const detail = item.type === 'task-event'
      ? relatedTask?.title || '后台任务状态已更新'
      : item.status
        ? `状态：${statusLabels[item.status] || item.status}`
        : '已记录到交付证据';
    return (
      <button className={`team-timeline-record ${item.type}`} key={item.id} onClick={() => relatedTask && showTask(relatedTask)} disabled={!relatedTask}>
        <span className="team-timeline-record-icon">{item.type === 'task-event' ? <Workflow size={14} /> : item.type === 'verification' ? <Check size={14} /> : <FileText size={14} />}</span>
        <span><strong>{title}</strong><small>{detail} · {formatTime(item.at)}</small></span>
      </button>
    );
  };
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
        {taskVerification(task) && (
          <small className={`task-card-proof ${task.deliveryStatus || task.verificationStatus || ''}`}>
            交付 · {taskVerification(task)}{task.artifactCount ? ` · ${task.artifactCount} 项证据` : ''}
          </small>
        )}
      </div>
      <span className={`status ${task.status}`}>
        {statusLabels[task.status]}
      </span>
      <ArrowRight size={16} />
    </button>
  );
  const reviewTaskCard = (task: Task) => {
    const selected = selectedReviewTaskIds.includes(task.id);
    return (
      <div className={`task-card review-task-card ${selected ? 'selected' : ''}`} key={task.id}>
        <input
          type="checkbox"
          className="review-task-checkbox"
          aria-label={`选择交付验收任务 ${task.title}`}
          checked={selected}
          onChange={() => toggleReviewTask(task.id)}
        />
        <div className={`status-icon ${task.status}`}>
          {task.status === 'completed' ? <Check /> : <Circle />}
        </div>
        <button type="button" className="task-card-open" onClick={() => showTask(task)}>
          <strong>{task.title}</strong>
          <span>
            {roles.find((r) => r.id === task.role)?.name} ·{' '}
            {formatTime(task.createdAt)}
          </span>
          {taskVerification(task) && (
            <small className={`task-card-proof ${task.deliveryStatus || task.verificationStatus || ''}`}>
              交付 · {taskVerification(task)}{task.artifactCount ? ` · ${task.artifactCount} 项证据` : ''}
            </small>
          )}
        </button>
        <span className={`status ${task.status}`}>
          {statusLabels[task.status]}
        </span>
        <ArrowRight size={16} />
      </div>
    );
  };
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
                <button className="secondary-button" type="button" disabled={busy || !activeRoles.length} onClick={() => openCreateTeam()}><Copy size={14} /> 新建团队</button>
                <button className="secondary-button" type="button" disabled={busy || !activeRoles.length} onClick={() => void startRecruitment(true)}><Plus size={15} /> 发布新需求</button>
                <button className="text-button" type="button" disabled={busy || !teamSpace || teamSpace.recruitment?.phase !== 'confirmed'} onClick={openSaveTeamTemplate}><Copy size={13} /> 保存为模板</button>
                <button className="text-button" type="button" disabled={busy || !teamSpace} onClick={openTeamRename}><Pencil size={13} /> 重命名</button>
                <button className="text-button" type="button" onClick={openTeamSettings}>团队设置</button>
                <div className="team-health"><span className="live-dot" /> {rosterReady ? `${teamMembers.length} 位成员已配置` : recruitment?.phase === 'proposed' ? '方案待确认' : '正在招募'}</div>
              </div>
            </div>
            {confirmedSpaces.length > 0 && (
              <CrossTeamTimeline teams={confirmedSpaces} onOpenTeam={openRiskTeam} onOpenTask={openRiskTask} />
            )}
            {teamSpace?.recruitment?.phase === 'confirmed' && teamSpace && (
              <TeamCollaborationConsole
                team={teamSpace}
                teams={confirmedSpaces}
                tasks={tasks}
                onOpenTeam={openRiskTeam}
                onOpenTask={openRiskTask}
                onChanged={refresh}
              />
            )}
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
                  {timelineItems.length > 0 && (
                    <div className={`team-timeline ${teamTimeline.length === 0 ? 'team-timeline-fallback' : ''}`} aria-label={teamTimeline.length > 0 ? '团队统一时间线' : '团队动态'}>
                      <div className="team-timeline-toolbar">
                        <div className="team-activity-title"><History size={14} /> {teamTimeline.length > 0 ? '统一时间线' : '团队动态'}</div>
                        <div className="timeline-filters" role="tablist" aria-label="时间线筛选">
                          {timelineFilterOptions.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              role="tab"
                              aria-selected={timelineFilter === option.id}
                              className={`timeline-filter-button ${timelineFilter === option.id ? 'active' : ''}`}
                              onClick={() => setTimelineFilter(option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                          {teamTimelineHasMore && (
                            <button
                              type="button"
                              className="timeline-load-more"
                              onClick={() => void loadOlderTeamTimeline()}
                              disabled={timelineLoading}
                            >
                              {timelineLoading ? '加载中…' : '更早动态'}
                            </button>
                          )}
                        </div>
                      </div>
                      {visibleTeamTimeline.length > 0 ? visibleTeamTimeline.map(renderTeamTimelineItem) : (
                        <div className="timeline-filter-empty">当前筛选没有记录</div>
                      )}
                    </div>
                  )}
                  {!timelineItems.length && <div className="team-empty"><MessageSquare size={18} /> 还没有团队动态。完成一次任务后，进展会显示在这里。</div>}
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
                <div className="team-summary"><div className="team-summary-title"><ListChecks size={16} />任务总览</div><div className="team-metrics"><span><strong>{teamOpenTasks.length}</strong><small>进行中</small></span><span><strong>{teamReviewTasks.length}</strong><small>待处理</small></span><span><strong>{teamRiskTasks.length}</strong><small>风险/阻塞</small></span><span><strong>{teamTasks.filter((task) => task.status === 'completed').length}</strong><small>已完成</small></span></div><div className="team-summary-evidence">最近交付证据 {teamEvidenceCount} 项</div><div className="team-summary-actions"><button className="text-button" onClick={() => { setTaskFilter('all'); setView('tasks'); }}>查看全部任务 <ArrowRight size={13} /></button>{teamReviewTasks.length > 0 && <button className="text-button" onClick={() => { setTaskFilter('review'); setView('tasks'); }}>打开待处理 <ArrowRight size={13} /></button>}</div></div>
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
                  {isRecruitmentView && (
                    <small className={`recruitment-sync-status ${recruitmentSyncState}`}>
                      {recruitmentSyncState === 'syncing'
                        ? '正在同步招募会话'
                        : recruitmentSyncState === 'synced'
                          ? '招募会话已同步，可在其他设备继续'
                          : recruitmentSyncState === 'offline'
                            ? '暂时无法同步，会话内容会在恢复后继续同步'
                            : ''}
                    </small>
                  )}
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
                  {!isRecruitmentView && <button className="text-button" type="button" onClick={openTeamSettings}>团队设置</button>}
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
                      setSelected((s) => ({ ...s, [sessionSelectionKey]: undefined }))
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
                      setSelected((s) => ({ ...s, [sessionSelectionKey]: id }))
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
                  {charterExpanded && (
                    <div className="recruitment-proposal-body">
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
                          <button
                            className="primary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (recruitmentProposal.openQuestions?.length) {
                                composerRef.current?.focus();
                                setNotice('请在下方输入框中补充或确认上述问题，或直接回复“按方案创建”');
                              } else {
                                void confirmTeamRecruitment();
                              }
                            }}
                          >
                            <Check size={16} />{recruitmentProposal.openQuestions?.length ? '先补充信息' : '确认创建团队'}
                          </button>
                        )}
                        <button className="text-button" type="button" onClick={() => composerRef.current?.focus()}>
                          继续补充需求 <ArrowRight size={13} />
                        </button>
                      </div>
                    </div>
                  )}
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
                            (() => {
                              markDraftDirty(draftKey);
                              setDrafts((d) => ({ ...d, [draftKey]: p }));
                            })()
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
                    onChange={(e) => {
                      markDraftDirty(draftKey);
                      setDrafts((d) => ({ ...d, [draftKey]: e.target.value }));
                      setDraftConflict((current) => current?.key === draftKey
                        ? { ...current, localContent: e.target.value }
                        : current);
                    }}
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
                            onClick={() => {
                              markDraftDirty(attachmentDraftKey);
                              setDraftAttachments((current) => ({
                                ...current,
                                [attachmentDraftKey]: current[attachmentDraftKey].filter((item) => item.id !== attachment.id),
                              }));
                              setDraftConflict((current) => current?.key === attachmentDraftKey
                                ? {
                                    ...current,
                                    localAttachments: current.localAttachments.filter((item) => item.id !== attachment.id),
                                  }
                                : current);
                            }}
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
                                {option.providerHealth?.ok === false ? ' · 最近检查失败' : ''}
                                {option.providerHealth?.ok === true ? ' · 最近检查通过' : ''}
                              </option>
                            ))}
                          </select>
                          <small className="model-id" title={`实际请求模型 ID：${selectedModelOption.model.id}`}>
                            ID: {selectedModelOption.model.id}
                          </small>
                          {selectedModelOption.providerHealth?.ok === false && (
                            <small className="model-health-warning">
                              最近一次连通性检查失败{selectedModelOption.providerHealth.error ? `：${selectedModelOption.providerHealth.error}` : ''}，发送时仍会按当前选择尝试并在可恢复错误时自动切换。
                            </small>
                          )}
                          {selectedModelOption.providerHealth?.ok === true && (
                            <small className="model-health-ok">
                              最近一次连通性检查通过 · {selectedModelOption.providerHealth.latencyMs || 0} ms
                            </small>
                          )}
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
                {draftConflict?.key === draftKey && (
                  <div className="draft-conflict-panel" role="alert">
                    <div className="draft-conflict-copy">
                      <span>检测到其他设备同时修改了这份草稿，请选择要保留的版本。</span>
                      <div className="draft-conflict-versions">
                        <span><strong>本机版本：</strong>{draftConflict.localContent || '（空）'}</span>
                        <span><strong>远端版本：</strong>{draftConflict.remoteContent || '（空）'}</span>
                      </div>
                    </div>
                    <div className="draft-conflict-actions">
                      <button type="button" onClick={() => resolveDraftConflict('local')}>
                        保留本机并覆盖远端
                      </button>
                      <button type="button" onClick={() => resolveDraftConflict('remote')}>
                        使用其他设备版本
                      </button>
                    </div>
                  </div>
                )}
                <p className="composer-hint">
                  Enter 发送 · Shift + Enter 换行<span>{isRecruitmentView ? '先澄清需求，再确认团队方案' : '任务在后台执行'}</span>
                  <span className={`draft-sync-status ${draftSyncState}`}>
                    {draftSyncState === 'saving'
                      ? '草稿同步中…'
                      : draftSyncState === 'conflict'
                        ? '草稿存在并行修改，请选择版本'
                      : draftSyncState === 'offline'
                        ? '服务暂不可用，已保存在本机'
                        : draftSyncState === 'saved'
                          ? '草稿已同步'
                          : ''}
                  </span>
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
              <div className="page-heading-pills"><span className="count-pill">{running.length} 个进行中</span>{reviewTasks.length > 0 && <span className="count-pill needs-review">{reviewTasks.length} 项待处理</span>}</div>
            </div>
            <RiskInbox teams={confirmedSpaces} onOpenTeam={openRiskTeam} onOpenTask={openRiskTask} />
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
                    <div className="batch-review-toolbar" aria-label="批量交付复核">
                      <div className="batch-review-toolbar-head">
                        <button
                          type="button"
                          className="batch-review-select"
                          onClick={toggleAllReviewTasks}
                          disabled={batchReviewBusy}
                        >
                          {allReviewTasksSelected ? '取消全选' : '全选待处理'}
                        </button>
                        <span>已选 {selectedReviewTaskIds.length} / {reviewTasks.length} 项</span>
                      </div>
                      <div className="batch-review-actions">
                        <textarea
                          aria-label="批量复核说明"
                          value={batchReviewNote}
                          onChange={(event) => setBatchReviewNote(event.target.value)}
                          placeholder="退回复核时填写统一的修改说明；通过交付可选填备注。"
                          rows={2}
                          disabled={batchReviewBusy}
                        />
                        <div className="batch-review-buttons">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={batchReviewBusy || selectedReviewTaskIds.length === 0}
                            onClick={() => void batchReview('reject')}
                          >
                            {batchReviewBusy ? '处理中…' : '批量退回复核'}
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={batchReviewBusy || selectedReviewTaskIds.length === 0}
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
                  ...(teamSpace ? [{ id: 'team', label: `${teamSpace.name} · 团队知识` }] : []),
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
                (k) => k.scope === 'personal' ||
                  (k.scope === 'team' && k.teamId === teamSpace?.id) ||
                  (k.scope !== 'team' && k.projectPath === currentWorkspace),
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
                                  : k.scope === 'team'
                                    ? '团队共享'
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
                    : modal === 'team-template'
                      ? '保存团队模板'
                      : editingTeamId
                        ? '团队设置'
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
                  : modal === 'team-template'
                    ? '模板只保存团队配置，不会包含消息、任务、招募会话、草稿或附件。使用模板创建新团队时，需要重新确认名称、目标、目录和协作边界。'
                  : editingTeamId
                      ? '调整当前团队的职责、成员、执行目录和自驱模式；已有任务保持原来的执行快照。'
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
                      setKnowledgeForm((f) => ({
                        ...f,
                        scope,
                        teamId: scope === 'team' ? (f.teamId || teamSpace?.id || null) : null,
                      }))
                    }
                    options={[
                      { value: 'personal', label: '个人 · 所有项目' },
                      { value: 'project', label: '项目 · 所有助手共享' },
                      ...(teamSpace ? [{ value: 'team', label: `${teamSpace.name} · 团队成员共享` }] : []),
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
                  options={handoffRoles(handoffTask)
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
          {modal === 'team-template' && (
            <form
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
                  onChange={(e) => setTeamTemplateForm((form) => ({ ...form, name: e.target.value }))}
                  placeholder="例如：标准研发交付团队"
                />
              </label>
              <label>
                模板说明
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={teamTemplateForm.description}
                  onChange={(e) => setTeamTemplateForm((form) => ({ ...form, description: e.target.value }))}
                  placeholder="说明适用的工作类型、成员组合和交付边界。"
                />
              </label>
              <p className="team-template-boundary">会保存成员职责、成员模型/能力、团队模型、自治模式和执行目录模式；不会复制历史消息、任务、招募会话、草稿、附件或原团队协作白名单。</p>
              <button className="primary-button" type="submit" disabled={busy || !teamSpace}>
                <Copy size={15} /> 保存模板
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
                  const payload = {
                    name: teamForm.name,
                    goal: teamForm.goal,
                    purpose: teamForm.goal,
                    teamType: teamForm.teamType,
                    pmRoleId: teamForm.pmRoleId,
                    memberRoleIds: teamForm.memberRoleIds,
                    workspace: teamForm.workspace,
                    workspaceMode: teamForm.workspaceMode,
                    autonomy: { mode: teamForm.autonomyMode },
                    collaboration: {
                      ...(editingTeamId && teamSpace?.collaboration
                        ? teamSpace.collaboration
                        : { autoHandoff: true, sharedBoard: true, allowedTeamIds: [] }),
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
                          model: teamForm.model || null,
                          providerId: teamForm.providerId || null,
                          collaboration: payload.collaboration,
                        }
                      : payload,
                  );
                  setSelectedSpaceId(saved.id);
                  setRole(saved.pmRoleId);
                  setModal(null);
                  if (!editingTeamId) setView('workspace');
                  setNotice(editingTeamId ? `团队“${saved.name}”设置已保存` : teamTemplateId ? `已从模板创建团队“${saved.name}”` : `团队“${saved.name}”已创建`);
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
                      <option key={template.id} value={template.id}>{template.name}</option>
                    ))}
                  </select>
                  <small className="field-help">选择模板只会预填配置；创建时仍需重新确认团队名称、目标、目录、模型和协作权限。</small>
                </label>
              )}
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
                  默认模型
                  <select
                    value={teamForm.model && teamForm.providerId ? `${teamForm.providerId}::${teamForm.model}` : ''}
                    onChange={(e) => {
                      const [providerId = '', model = ''] = e.target.value.split('::');
                      setTeamForm((form) => ({ ...form, providerId, model }));
                    }}
                  >
                    <option value="">沿用工作空间模型</option>
                    {teamForm.model && teamForm.providerId && !modelOptions.some((item) => item.key === `${teamForm.providerId}::${teamForm.model}`) && (
                      <option value={`${teamForm.providerId}::${teamForm.model}`}>当前配置 · {teamForm.model}</option>
                    )}
                    {modelOptions.map((item) => (
                        <option key={item.key} value={item.key}>{item.providerName} · {item.model.name}</option>
                      ))}
                  </select>
                  <small className="field-help">模板中的模型会预填；可在这里重新选择。</small>
                </label>
                <label>
                  工作目录
                  <input
                    required
                    value={teamForm.workspace}
                    onChange={(e) => setTeamForm((form) => ({ ...form, workspace: e.target.value }))}
                    placeholder="沿用工作空间目录"
                  />
                </label>
                <div className="field-label">
                  默认执行目录
                  <Choice
                    label="默认执行目录"
                    value={teamForm.workspaceMode}
                    onChange={(workspaceMode) => setTeamForm((form) => ({ ...form, workspaceMode: workspaceMode as TeamForm['workspaceMode'] }))}
                    options={[
                      { value: 'isolated', label: '隔离目录（推荐）' },
                      { value: 'worktree', label: 'Git worktree' },
                      { value: 'snapshot', label: '快照目录' },
                      { value: 'shared', label: '共享源目录' },
                    ]}
                  />
                </div>
              </div>
              <label className="team-collaboration-toggle" aria-label="允许与其他团队协作">
                <input
                  type="checkbox"
                  checked={teamForm.allowCollaboration}
                  onChange={(e) => setTeamForm((form) => ({ ...form, allowCollaboration: e.target.checked }))}
                />
                <span><strong>允许与其他团队协作</strong><small>项目经理可以向其他团队请求支持，并共享任务状态。</small></span>
              </label>
              <fieldset className="team-member-picker team-collaborator-picker" disabled={!teamForm.allowCollaboration}>
                <legend>可协作团队</legend>
                <p className="team-picker-help">不勾选表示允许当前所有已确认团队；勾选后只允许向选中的团队发起协作。</p>
                <div className="team-member-options">
                  {(data?.spaces || [])
                    .filter((candidate) => candidate.id !== editingTeamId && candidate.status === 'active' && candidate.recruitment?.phase === 'confirmed')
                    .map((candidate) => (
                      <label key={candidate.id} className="team-member-option">
                        <input
                          type="checkbox"
                          aria-label={`允许协作：${candidate.name}`}
                          checked={teamForm.allowedTeamIds.includes(candidate.id)}
                          onChange={(event) => setTeamForm((form) => ({
                            ...form,
                            allowedTeamIds: event.target.checked
                              ? [...new Set([...form.allowedTeamIds, candidate.id])]
                              : form.allowedTeamIds.filter((id) => id !== candidate.id),
                          }))}
                        />
                        <span><strong>{candidate.name}</strong><small>{candidate.purpose || candidate.goal}</small></span>
                      </label>
                    ))}
                  {!(data?.spaces || []).some((candidate) => candidate.id !== editingTeamId && candidate.status === 'active' && candidate.recruitment?.phase === 'confirmed') && (
                    <small className="team-picker-empty">还没有其他已确认团队。创建并确认团队后，可以在这里限制协作范围。</small>
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
                <Plus size={16} /> {editingTeamId ? '保存团队设置' : '创建团队'}
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
