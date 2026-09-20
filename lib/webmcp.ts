type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean };
  execute: (input: unknown) => Promise<unknown>;
};
type ModelContext = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerWorkbenchTools(actions: {
  assistants: () => Promise<{ id: string; name: string }[]>;
  list: () => Promise<unknown>;
  create: (input: { role: string; prompt: string }) => Promise<unknown>;
}) {
  const context = (document as Document & { modelContext?: ModelContext })
    .modelContext;
  if (!context?.registerTool) return () => {};
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    {
      name: 'list_background_tasks',
      title: '查看后台任务',
      description: '读取所有助手的任务标题、状态和结果。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        if (!input || typeof input !== 'object' || Object.keys(input).length)
          throw new Error('此工具不接受参数。');
        return actions.list();
      },
    },
    {
      name: 'list_assistants',
      title: '查看可用助手',
      description: '读取当前可用助手的 ID 和名称。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async () => actions.assistants(),
    },
    {
      name: 'create_assistant_task',
      title: '向助手提交任务',
      description: '向 list_assistants 返回的助手提交任务，切换到该会话。',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1, maxLength: 32000 },
        },
        required: ['role', 'prompt'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('参数必须是对象。');
        const value = input as Record<string, unknown>;
        if (
          Object.keys(value).some((k) => !['role', 'prompt'].includes(k)) ||
          typeof value.role !== 'string' ||
          !value.role ||
          typeof value.prompt !== 'string' ||
          !value.prompt.trim() ||
          value.prompt.length > 32000
        )
          throw new Error('需要有效的助手和任务内容。');
        return actions.create({
          role: String(value.role),
          prompt: value.prompt,
        });
      },
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* This optional browser capability must not affect the workbench. */
    }
  }
  return () => lifecycle.abort();
}
