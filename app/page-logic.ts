// 工作台主界面的纯逻辑函数与展示映射。
// 从 page.tsx（5500+ 行）抽出（无 React/DOM 依赖），使其可被单元测试直接覆盖；
// 延续 management-logic.ts 的做法，继续分解大文件。
//
// 这里只放「给定输入就有确定输出」的东西。读 localStorage 的薄包装留在
// page.tsx，它们的解析/校验内核以 parseDraftCache / parseRouteCache 的形式
// 放在本模块，这样多设备草稿同步的合并语义可以脱离浏览器被测试。

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
};

export type DraftBase = {
  content: string;
  attachmentIds: string[];
};

export type DraftCache = {
  drafts?: Record<string, string>;
  attachments?: Record<string, Attachment[]>;
  updatedAt?: Record<string, string>;
  revisions?: Record<string, number>;
  bases?: Record<string, DraftBase>;
};

export type DraftTextChange = {
  start: number;
  end: number;
  replacement: string;
};

export type RouteCache = {
  spaceId?: string;
  role?: string;
  view?: string;
};

export type ProviderModel = {
  id: string;
  name: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number;
};

/**
 * 任务辅助函数只关心状态字段，用结构化类型声明最小依赖，
 * 这样 page.tsx 里完整的 Task 不必搬家就能直接传进来。
 */
export type TaskStatusFields = {
  status: string;
  error?: string;
  verificationStatus?: string | null;
  deliveryStatus?: string | null;
};

export const DRAFT_CACHE_KEY = 'ggb.composer-drafts.v1';
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
export const MAX_ATTACHMENTS = 20;

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

export const modelDisplayName = (model: ProviderModel) =>
  model.name === model.id ? model.name : `${model.name} · ${model.id}`;

export const isActive = (t: { status: string }) => ['queued', 'running'].includes(t.status);

/**
 * 交付状态优先于验证状态；`completed` 自身只代表执行结束，显示为「待验收」。
 */
export const taskVerification = (task: TaskStatusFields) => {
  if (task.deliveryStatus)
    return statusLabels[task.deliveryStatus] || verificationLabels[task.deliveryStatus] || task.deliveryStatus;
  return task.verificationStatus
    ? verificationLabels[task.verificationStatus] || task.verificationStatus
    : task.status === 'completed'
      ? '待验收'
      : '';
};

export const taskNeedsOwnerAction = (task: TaskStatusFields) =>
  ['pending-review', 'awaiting-owner', 'rejected'].includes(
    task.deliveryStatus || task.verificationStatus || '',
  );

export const taskNeedsAttention = (task: TaskStatusFields) =>
  ['blocked', 'failed', 'interrupted', 'state_unknown', 'budget-exceeded', 'budget_exceeded'].includes(task.status) ||
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

/**
 * 校验并归一化草稿缓存。缓存来自 localStorage，可能被用户、旧版本或其他
 * 标签页写坏，所以每个字段都要确认形状后才接受。
 */
export function parseDraftCache(raw: string): DraftCache {
  try {
    const value = JSON.parse(raw || '{}') as DraftCache;
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

export function parseRouteCache(raw: string): RouteCache {
  try {
    const value = JSON.parse(raw || '{}') as RouteCache;
    return {
      ...(typeof value?.spaceId === 'string' ? { spaceId: value.spaceId } : {}),
      ...(typeof value?.role === 'string' ? { role: value.role } : {}),
      ...(typeof value?.view === 'string' && ROUTE_VIEWS.has(value.view) ? { view: value.view } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 把 base → next 的差异压缩成单个「替换区间」：掐掉公共前缀和公共后缀，
 * 剩下的就是实际改动。三路合并据此判断两端是否动了同一片文本。
 */
export function draftChangeFromBase(base: string, next: string): DraftTextChange | null {
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

export function draftRangesOverlap(a: DraftTextChange, b: DraftTextChange) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * 多设备草稿同步的三路合并：不重叠的改动自动合并，重叠的回退到本机内容
 * 并标记 conflict，由界面展示两个版本让用户选择。
 */
export function mergeDraftText(base: string, local: string, remote: string) {
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

export function mergeDraftAttachments(local: Attachment[], remote: Attachment[]) {
  const merged = new Map<string, Attachment>();
  for (const attachment of [...local, ...remote]) merged.set(attachment.id, attachment);
  return [...merged.values()].slice(0, MAX_ATTACHMENTS);
}
