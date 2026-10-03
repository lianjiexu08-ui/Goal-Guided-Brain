'use client';

import {
  Archive,
  Clock3,
  Cpu,
  GitBranch,
  Inbox,
  Network,
  Plug,
  Server,
} from 'lucide-react';

export { AuthenticationGate } from './management/authentication-gate';
export { ExecutionInspector } from './management/execution-inspector';
export { JobDetail } from './management/job-detail';
export { Management } from './management/management-workspace';

export const managementNavigation = [
  { id: 'jobs', label: '协作任务', icon: GitBranch },
  { id: 'models', label: '模型管理', icon: Cpu },
  { id: 'resources', label: '资源与凭据', icon: Server },
  { id: 'nodes', label: '执行节点', icon: Network },
  { id: 'capabilities', label: '能力中心', icon: Plug },
  { id: 'schedules', label: '定时与监控', icon: Clock3 },
  { id: 'attention', label: '需要你处理', icon: Inbox },
  { id: 'backups', label: '备份与恢复', icon: Archive },
];
