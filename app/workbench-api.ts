export async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.status === 502 ? '服务暂时不可用' : '服务返回了无效响应',
    );
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith('auth/') &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event('workbench-auth-required'));
    }
    const error =
      typeof data === 'object' && data !== null && 'error' in data
        ? String(data.error)
        : '请求失败，请稍后重试';
    const failure = new Error(error) as Error & {
      status?: number;
      data?: unknown;
    };
    failure.status = response.status;
    failure.data = data;
    throw failure;
  }
  return data as T;
}

export type Entity = { id: string; name?: string; [key: string]: unknown };
export type ManagementState = {
  providers: Entity[];
  resources: Entity[];
  nodes: Entity[];
  jobs: Entity[];
  messages: Entity[];
  capabilities: Entity[];
  schedules: Entity[];
  monitors: Entity[];
  notifications: Entity[];
  attention: Entity[];
  backups: Entity[];
  roles: Entity[];
  workflows: Entity[];
  integrations: Entity[];
  vault: { initialized?: boolean; unlocked?: boolean; configured?: boolean };
};

export const entityText = (
  item: Record<string, unknown>,
  key: string,
  fallback = '',
) => {
  const value = item[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
};

export function entityList(value: unknown): Entity[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Entity => typeof item === 'object' && item !== null,
      )
    : [];
}

// 首次配置向导使用的供应商预设（与 scripts/cli.mjs 的 PRESETS 对齐）。
export type ProviderPreset = {
  id: string;
  label: string;
  protocol: 'openai-completions' | 'anthropic-messages' | 'openai-responses';
  baseUrl: string;
  model: string;
  contextWindow: number;
  keyHint: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-completions', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', contextWindow: 128000, keyHint: 'DEEPSEEK_API_KEY' },
  { id: 'claude', label: 'Claude', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', contextWindow: 200000, keyHint: 'ANTHROPIC_API_KEY' },
  { id: 'codex', label: 'Codex / OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex', contextWindow: 400000, keyHint: 'OPENAI_API_KEY' },
  { id: 'gemini', label: 'Gemini', protocol: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', contextWindow: 1048576, keyHint: 'GEMINI_API_KEY' },
  { id: 'kimi', label: 'Kimi', protocol: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', contextWindow: 128000, keyHint: 'KIMI_API_KEY' },
];
