'use client';

import { type Entity, type ManagementState } from '../workbench-api';

export type FormValues = Record<string, unknown>;
export type FormProps = {
  collection: string;
  initial?: Entity;
  data: ManagementState;
  credentials: Entity[];
  onSave: (body: FormValues) => Promise<void>;
  onClose: () => void;
};

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
      notes: '',
    },
    credentials: { name: '', kind: 'api_key', value: '' },
    jobs: {
      name: '',
      role,
      prompt: '',
      workspace: '',
      nodeId: '',
      workspaceMode: 'isolated',
      budgetTokens: 200000,
      steps: [],
    },
    messages: {
      toAgentId: role,
      toTaskId: '',
      jobId: '',
      content: '',
      kind: 'question',
    },
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
  };
  return {
    ...(defaults[collection] || { name: '' }),
    ...(initial ? structuredClone(initial) : {}),
  };
}
