// 管理界面的纯逻辑函数与展示映射。
// 从 management.tsx 抽出（无 React/DOM 依赖），使其可被单元测试直接覆盖；
// management.tsx 5400+ 行的持续分解从这里开始。

import { entityList, entityText as txt, type Entity, type ManagementState } from './workbench-api';

export type FormValues = Record<string, unknown>;

export const labels: Record<string, string> = {
  providers: '供应商',
  resources: '资源',
  credentials: '凭据',
  nodes: '执行节点',
  jobs: '协作任务',
  messages: '消息',
  capabilities: '能力',
  integrations: '集成出口',
  schedules: '定时任务',
  monitors: '监控规则',
  notifications: '通知',
  attention: '待处理事项',
  backups: '备份',
  workflows: '工作流',
};

export const statuses: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  paused: '已暂停',
  blocked: '等待处理',
  interrupted: '已中断',
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
  unknown: '状态未知',
  pending: '待处理',
  resolved: '已处理',
  dismissed: '已拒绝',
  budget_exceeded: '预算超限',
  'budget-exceeded': '预算超限',
  read: '已读',
  unread: '未读',
  sent: '已发送',
  delivered: '已送达',
  received: '已接收',
  processed: '已处理',
  active: '已启用',
  enabled: '已启用',
  disabled: '已停用',
  installed: '已安装',
  healthy: '正常',
  unhealthy: '异常',
  ok: '正常',
  error: '异常',
  compatible: '可直接使用',
  partial: '部分兼容',
  unsupported: '不支持',
  needs_configuration: '需要配置',
  needs_config: '需要配置',
  stopped: '已停止',
  open: '待处理',
  state_unknown: '状态未知',
  waiting_children: '等待子任务',
  'pending-review': '待验证',
  'needs-review': '需要复核',
  verified: '验证通过',
  accepted: '已交付',
  'awaiting-owner': '待你验收',
  rejected: '已退回复核',
  stale: '验收已失效',
  skipped: '已跳过',
  selected: '已选用',
  considered: '候选',
  unavailable: '不可用',
  ineligible: '能力不满足',
  'risk-low': '低风险',
  'risk-medium': '中风险',
  'risk-high': '高风险',
  confirmed: '已确认',
  recorded: '已记录',
};

export const time = (value: unknown) =>
  typeof value === 'string' && value
    ? new Date(value).toLocaleString('zh-CN')
    : '-';

export const title = (item: Entity) =>
  txt(item, 'name') ||
  txt(item, 'title') ||
  txt(item, 'filename') ||
  txt(item, 'content').slice(0, 80) ||
  item.id;

export const status = (item: Entity) =>
  txt(item, 'status') ||
  txt(item, 'state') ||
  (item.enabled === false
    ? 'disabled'
    : item.lastResult &&
        typeof item.lastResult === 'object' &&
        'ok' in item.lastResult
      ? item.lastResult.ok
        ? 'healthy'
        : 'unhealthy'
      : item.enabled === true
        ? 'enabled'
        : typeof item.read === 'boolean'
          ? item.read
            ? 'read'
            : 'unread'
          : '');

export function initialForm(
  collection: string,
  initial: Entity | undefined,
  data: ManagementState,
): FormValues {
  const role = data.roles.find((item) => !item.archived)?.id || '';
  const defaults: Record<string, FormValues> = {
    providers: {
      name: '',
      protocol: 'openai-completions',
      baseUrl: '',
      credentialId: '',
      enabled: true,
      priority: 10,
      models: [
        { id: '', name: '', tools: true, vision: false, contextWindow: 64000 },
      ],
    },
    resources: {
      name: '',
      kind: 'server',
      host: '',
      port: 22,
      username: '',
      credentialId: '',
      path: '',
    },
    credentials: { name: '', kind: 'api-key', value: '' },
    nodes: { name: '', workspaces: '' },
    jobs: {
      name: '',
      role,
      prompt: '',
      acceptance: '',
      dependencies: '',
      nodeId: '',
      enabled: true,
    },
    messages: { jobId: '', toAgentId: '', content: '' },
    capabilities: {
      name: '',
      kind: 'mcp',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      credentialId: '',
      enabled: true,
    },
    schedules: {
      name: '',
      mode: 'cron',
      cron: '0 9 * * *',
      intervalSeconds: 3600,
      timezone: 'Asia/Shanghai',
      role,
      prompt: '',
      workflowId: '',
      nodeId: '',
      enabled: true,
      misfire: 'skip',
    },
    monitors: {
      name: '',
      kind: 'http',
      url: '',
      intervalSeconds: 300,
      enabled: true,
      webhookUrl: '',
      nodeId: '',
    },
    workflows: { name: '', steps: [{ role, prompt: '' }] },
    integrations: {
      type: 'webhook',
      name: '',
      url: '',
      secret: '',
      accessToken: '',
      qqTargetType: 'group',
      qqTargetId: '',
      teamId: '',
      events: ['attention', 'task.completed'],
      enabled: true,
    },
  };
  const merged = {
    ...(defaults[collection] || { name: '' }),
    ...(initial ? structuredClone(initial) : {}),
  };
  if (collection === 'integrations' && initial?.config && typeof initial.config === 'object')
    Object.assign(merged, initial.config);
  return merged;
}

export const integrationTypeLabels: Record<string, string> = {
  webhook: 'Webhook',
  'wecom-bot': '企业微信群机器人',
  'qq-onebot': 'QQ OneBot',
  'feishu-bot': '飞书机器人',
  'dingtalk-bot': '钉钉机器人',
  bridge: '通用桥接',
};

export const integrationEventLabels: Record<string, string> = {
  attention: '待处理事项',
  'verification.failed': '验证失败',
  'task.completed': '任务完成/失败',
};

export function description(collection: string, item: Entity, data: ManagementState) {
  const roleName = (id: string) =>
    data.roles.find((role) => role.id === id)?.name || id;
  switch (collection) {
    case 'providers':
      return [
        txt(item, 'protocol'),
        txt(item, 'baseUrl'),
        entityList(item.models)
          .map((model) => model.id)
          .join(', '),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'resources':
      return item.kind === 'project'
        ? txt(item, 'path')
        : `${txt(item, 'username') ? `${txt(item, 'username')}@` : ''}${txt(item, 'host')}:${txt(item, 'port', '22')}`;
    case 'credentials':
      return [txt(item, 'kind'), time(item.updatedAt || item.createdAt)].join(
        ' · ',
      );
    case 'nodes':
      return [
        txt(item, 'platform'),
        txt(item, 'hostname'),
        item.lastSeenAt ? `最近心跳 ${time(item.lastSeenAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'jobs':
      return [
        roleName(txt(item, 'role')),
        time(item.createdAt),
        txt(item, 'workspace'),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'messages':
      return [
        roleName(txt(item, 'fromAgentId', '用户')),
        '→',
        roleName(txt(item, 'toAgentId')),
        time(item.createdAt),
      ].join(' ');
    case 'capabilities':
      return [
        txt(item, 'kind'),
        txt(item, 'source'),
        txt(item, 'version'),
        txt(item, 'transport'),
        typeof item.boundAssistantCount === 'number' ? `${item.boundAssistantCount} 个助手` : '',
        typeof item.boundTeamCount === 'number' ? `${item.boundTeamCount} 个团队成员` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'integrations':
      return [
        integrationTypeLabels[txt(item, 'type')] || txt(item, 'type'),
        txt((item.config as Record<string, unknown>) || {}, 'url'),
        Array.isArray(item.events)
          ? (item.events as string[])
              .map((event) => integrationEventLabels[event] || event)
              .join(' / ')
          : '',
        item.enabled === false ? '已停用' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'schedules':
      return [
        item.mode === 'interval'
          ? `每 ${txt(item, 'intervalSeconds', '3600')} 秒`
          : txt(item, 'cron'),
        txt(item, 'timezone'),
        item.nextRunAt ? `下次 ${time(item.nextRunAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'monitors':
      return [
        txt(item, 'kind').toUpperCase(),
        txt(item, 'url') ||
          txt(item, 'providerId') ||
          txt(item, 'capabilityId'),
        `每 ${txt(item, 'intervalSeconds', '300')} 秒`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'attention':
      return [
        txt(item, 'kind'),
        txt(item, 'taskTitle') ? `任务 · ${txt(item, 'taskTitle')}` : '',
        txt(item, 'deliveryStatus')
          ? `交付 · ${statuses[txt(item, 'deliveryStatus')] || txt(item, 'deliveryStatus')}`
          : '',
        txt(item, 'detail') || txt(item, 'message'),
        time(item.createdAt),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'backups':
      return [
        item.size || item.bytes
          ? `${Math.round(Number(item.size || item.bytes) / 1024)} KB`
          : '',
        time(item.createdAt),
      ]
        .filter(Boolean)
        .join(' · ');
    default:
      return (
        txt(item, 'description') ||
        txt(item, 'detail') ||
        txt(item, 'message') ||
        txt(item, 'goal') ||
        txt(item, 'reason') ||
        txt(item, 'prompt') ||
        time(item.createdAt)
      );
  }
}
