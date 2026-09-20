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
    throw new Error(error);
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
