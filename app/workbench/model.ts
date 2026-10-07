import type { Attachment } from '../drafts/model';
import type { Assistant } from '../assistant-editor';

export type RoleId = string;
export type Task = {
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
  teamId?: string | null;
  artifactCount?: number;
  verificationStatus?: string | null;
  deliveryStatus?: string | null;
  acceptanceDecision?: string | null;
  acceptanceNote?: string | null;
  currentRequirementVersion?: number | null;
  attachmentIds?: string[];
  attachments?: Attachment[];
  knowledgeRefs?: Array<{
    id: string;
    version: number;
    source?: string;
    updatedAt?: string;
  }>;
};
export type RouteCache = {
  spaceId?: string;
  role?: string;
  view?: string;
};
export type Session = {
  id: string;
  role: RoleId;
  title: string;
  createdAt: string;
  workspace: string;
};
export type Knowledge = {
  id: string;
  title: string;
  content: string;
  scope: string;
  state: string;
  source: string;
  updatedAt: string;
  createdAt?: string;
  version?: number;
  expiresAt?: string | null;
  expired?: boolean;
  expiresSoon?: boolean;
  projectPath: string;
  teamId?: string | null;
};
export type Config = {
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
export type Profile = {
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
export type TeamMessage = {
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
export type TeamTimelineItem = {
  id: string;
  type:
    | 'message'
    | 'task'
    | 'task-event'
    | 'artifact'
    | 'verification'
    | 'acceptance'
    | 'attention';
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
export type TimelineFilter =
  | 'all'
  | 'messages'
  | 'execution'
  | 'evidence'
  | 'risk';
export type TeamRecruitmentMember = {
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
export type CapabilityApproval = {
  confirmed: true;
  digest: string;
  riskLevel: string;
  confirmedAt: string;
};
export type TeamRecruitmentProposal = {
  version?: number;
  teamName: string;
  goal: string;
  purpose?: string;
  size: number;
  members: TeamRecruitmentMember[];
  openQuestions?: string[];
  ready?: boolean;
};
export type TeamRecruitment = {
  phase: string;
  sessionId?: string | null;
  turns?: number;
  brief?: string;
  proposal?: TeamRecruitmentProposal | null;
  confirmedAt?: string | null;
};
export type TeamSpace = {
  id: string;
  planRevision?: number;
  name: string;
  goal: string;
  workspace: string;
  pmRoleId: string;
  memberRoleIds: string[];
  status: string;
  archivedAt?: string | null;
  archivedFromStatus?: string | null;
  model?: string | null;
  providerId?: string | null;
  workspaceMode?: 'shared' | 'isolated' | 'worktree' | 'snapshot';
  autonomy: {
    mode: string;
    maxDepth: number;
    maxJobs: number;
    budgetTokens: number;
  };
  autonomyUsage?: {
    usedTokens: number;
    budgetTokens: number;
    remainingTokens: number;
    percent: number;
    warning: boolean;
    exceeded: boolean;
  };
  teamType?: string;
  purpose?: string;
  collaboration?: {
    enabled?: boolean;
    autoHandoff?: boolean;
    sharedBoard?: boolean;
    allowedTeamIds?: string[];
  };
  memberSettings?: Record<
    string,
    {
      label?: string;
      responsibility?: string;
      modelHint?: string;
      providerIds?: string[];
    }
  >;
  recruitment?: TeamRecruitment;
  messages: TeamMessage[];
  timeline?: TeamTimelineItem[];
};
export type TeamPlan = {
  id: string;
  teamId: string;
  summary: string;
  status: 'active' | 'paused' | 'completed';
  dueAt?: string | null;
  riskPreference: 'conservative' | 'balanced' | 'aggressive';
  budgetTokens?: number | null;
  milestones: Array<{
    id: string;
    title: string;
    description: string;
    status: 'planned' | 'active' | 'blocked' | 'completed';
    dueAt?: string | null;
    ownerRoleId?: string | null;
    order: number;
    completedAt?: string | null;
  }>;
  revision: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};
export type TeamTemplate = {
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
export type TeamForm = {
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
  autonomyMaxDepth: string;
  autonomyMaxJobs: string;
  autonomyBudgetTokens: string;
  model: string;
  providerId: string;
};
export type Capability = {
  id: string;
  name: string;
  kind: string;
  version: string | null;
  revision?: number | null;
  digest?: string | null;
  enabled: boolean;
  description: string;
  tools: string[];
  risk?: { level?: string; requiresReview?: boolean; reasons?: string[] };
  health?: {
    ok?: boolean;
    checkedAt?: string | null;
    latencyMs?: number | null;
    toolCount?: number | null;
  } | null;
};
export type ProviderModel = {
  id: string;
  name: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number;
};
export type Provider = {
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
export type State = {
  roles: Assistant[];
  skillCatalog: { id: string; name: string }[];
  unreadNotificationCount: number;
  openAttentionCount: number;
  teamRiskCounts: Record<string, number>;
  capabilities: Capability[];
  providers: Provider[];
  tasks: Task[];
  sessions: Session[];
  knowledge: Knowledge[];
  spaces: TeamSpace[];
  teamTemplates: TeamTemplate[];
  config: Config;
};
export const modelDisplayName = (model: ProviderModel) =>
  model.name === model.id ? model.name : `${model.name} · ${model.id}`;
export const statusLabels: Record<string, string> = {
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
export const verificationLabels: Record<string, string> = {
  verified: '已验收',
  failed: '验证失败',
  'pending-review': '待验收',
  'needs-review': '需要复核',
  'awaiting-owner': '待你验收',
  accepted: '已交付',
  rejected: '已退回复核',
  stale: '验收已失效',
};
export const capabilityKindLabels: Record<string, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  plugin: 'Plugin',
};
export const isActive = (t: Task) => ['queued', 'running'].includes(t.status);
export const taskVerification = (task: Task) => {
  if (task.deliveryStatus)
    return (
      statusLabels[task.deliveryStatus] ||
      verificationLabels[task.deliveryStatus] ||
      task.deliveryStatus
    );
  return task.verificationStatus
    ? verificationLabels[task.verificationStatus] || task.verificationStatus
    : task.status === 'completed'
      ? '待验收'
      : '';
};
export const taskNeedsOwnerAction = (task: Task) =>
  ['pending-review', 'awaiting-owner', 'rejected'].includes(
    task.deliveryStatus || task.verificationStatus || '',
  );
export const taskNeedsAttention = (task: Task) =>
  [
    'blocked',
    'failed',
    'interrupted',
    'state_unknown',
    'budget-exceeded',
    'budget_exceeded',
  ].includes(task.status) ||
  (task.status !== 'completed' && Boolean(task.error));
export const formatTime = (s: string) =>
  new Date(s).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export const ROUTE_CACHE_KEY = 'ggb.workspace-route.v1';
export const ROUTE_VIEWS = new Set([
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
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export function readRouteCache(): RouteCache {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(
      window.localStorage.getItem(ROUTE_CACHE_KEY) || '{}',
    ) as RouteCache;
    return {
      ...(typeof value?.spaceId === 'string' ? { spaceId: value.spaceId } : {}),
      ...(typeof value?.role === 'string' ? { role: value.role } : {}),
      ...(typeof value?.view === 'string' && ROUTE_VIEWS.has(value.view)
        ? { view: value.view }
        : {}),
    };
  } catch {
    return {};
  }
}
