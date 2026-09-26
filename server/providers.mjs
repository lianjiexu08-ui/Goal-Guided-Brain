const PROTOCOLS = [
  'deepseek',
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'typesafe-system-one',
];
const TEXT_PROTOCOLS = new Set(PROTOCOLS.filter(protocol => protocol !== 'typesafe-system-one'));
const text = (value, label, max = 160, required = true) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(`${label}无效。`);
  return value.trim();
};
const number = (value, fallback, max) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw new Error('模型数值配置无效。');
  return value;
};
export function providerUrl(value) {
  const url = new URL(text(value, '接口地址', 2048));
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new Error('接口地址必须为不含凭据或查询参数的 HTTP(S) 地址。');
  if (
    url.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('远程模型接口需要 HTTPS，本机接口可以使用 HTTP。');
  return url.toString().replace(/\/$/, '');
}
export function providerEndpoint(provider) {
  const base = provider.baseUrl.replace(/\/$/, '');
  if (provider.protocol === 'typesafe-system-one') {
    if (base.endsWith('/systemone')) return base;
    return `${base}${base.endsWith('/v1') ? '' : '/v1'}/systemone`;
  }
  const suffix =
    provider.protocol === 'anthropic-messages'
      ? '/messages'
      : provider.protocol === 'openai-responses'
        ? '/responses'
        : '/chat/completions';
  if (base.endsWith(suffix)) return base;
  return `${base}${provider.protocol === 'anthropic-messages' && !base.endsWith('/v1') ? '/v1' : ''}${suffix}`;
}

function modelsEndpoint(provider) {
  const base = provider.baseUrl.replace(/\/$/, '');
  if (provider.protocol === 'typesafe-system-one') return '';
  if (provider.protocol === 'anthropic-messages' && !base.endsWith('/v1')) return `${base}/v1/models`;
  return base.endsWith('/models') ? base : `${base}/models`;
}

function modelRows(data) {
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  return [];
}

function unsupportedModel(row) {
  const id = String(row?.id || row?.name || '').toLowerCase();
  const name = String(row?.name || '').toLowerCase();
  const dedicatedTerms = ['audio', 'image', 'realtime', 'embedding', 'moderation', 'transcription', 'text-to-speech', 'tts'];
  if (dedicatedTerms.some((term) => id.includes(term) || name.includes(term))) return true;
  const modalities = row?.modalities || row?.input_modalities || row?.output_modalities;
  if (!Array.isArray(modalities) || modalities.length === 0) return false;
  return modalities.every((modality) => dedicatedTerms.some((term) => String(modality).toLowerCase().includes(term)));
}

function modelSpecFromRemote(row, previous) {
  const id = String(row?.id || row?.name || '').trim();
  const contextWindow = Number(
    row?.context_window || row?.contextWindow || row?.max_context_length || previous?.contextWindow || 128000,
  );
  const tools = typeof row?.tools === 'boolean'
    ? row.tools
    : typeof row?.supports_tools === 'boolean'
      ? row.supports_tools
      : previous?.tools === true;
  const vision = typeof row?.vision === 'boolean'
    ? row.vision
    : typeof row?.supports_vision === 'boolean'
      ? row.supports_vision
      : previous?.vision === true;
  return {
    id,
    name: previous?.name || id,
    tools,
    vision,
    contextWindow: Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
    inputPrice: previous?.inputPrice ?? null,
    outputPrice: previous?.outputPrice ?? null,
  };
}

export class ProviderService {
  constructor({ store, vault }) {
    this.records = store.records;
    this.vault = vault;
  }
  list() {
    return this.records
      .list('providers')
      .sort((a, b) => a.priority - b.priority);
  }
  save(input, id) {
    const previous = id ? this.records.get('providers', id) : null;
    if (id && !previous) throw new Error('模型供应商不存在。');
    const value = { ...previous, ...input };
    if (!PROTOCOLS.includes(value.protocol))
      throw new Error('不支持的模型接口协议。');
    if (
      !Array.isArray(value.models) ||
      !value.models.length ||
      value.models.length > 100
    )
      throw new Error('请配置 1 至 100 个模型。');
    const models = value.models.map((model) => ({
      id: text(model.id, '模型 ID'),
      name: text(model.name ?? model.id, '模型名称'),
      tools: value.protocol !== 'typesafe-system-one' && model.tools === true,
      vision: value.protocol !== 'typesafe-system-one' && model.vision === true,
      contextWindow: number(model.contextWindow, 128000, 10_000_000),
      inputPrice: number(model.inputPrice, null, 1_000_000),
      outputPrice: number(model.outputPrice, null, 1_000_000),
    }));
    if (
      models.some(
        (model) =>
          model.contextWindow < 1 || !Number.isInteger(model.contextWindow),
      ) ||
      new Set(models.map((model) => model.id)).size !== models.length
    )
      throw new Error('模型 ID 不能重复，上下文长度必须为正整数。');
    const credentialId = text(value.credentialId ?? '', '凭据引用', 160, false);
    if (
      credentialId &&
      this.vault.status().unlocked &&
      !this.vault.list().some((entry) => entry.id === credentialId)
    )
      throw new Error('引用的凭据不存在。');
    const record = {
      name: text(value.name, '供应商名称'),
      protocol: value.protocol,
      baseUrl: providerUrl(value.baseUrl),
      credentialId,
      models,
      enabled: value.enabled !== false,
      priority: number(value.priority, 100, 10000),
    };
    const unchanged =
      previous &&
      ['protocol', 'baseUrl', 'credentialId'].every(
        (key) => previous[key] === record[key],
      ) &&
      JSON.stringify(previous.models) === JSON.stringify(models);
    record.health = unchanged ? previous.health : null;
    return this.records.save('providers', record, id);
  }
  remove(id) {
    return this.records.remove('providers', id);
  }
  async syncModels(id) {
    const provider = this.records.get('providers', id);
    if (!provider) throw new Error('模型供应商不存在。');
    const endpoint = modelsEndpoint(provider);
    if (!endpoint) throw new Error('结构化决策后端不提供聊天模型列表。');
    const secret = provider.credentialId ? this.vault.get(provider.credentialId) : '';
    if (provider.credentialId && !secret) throw new Error('供应商凭据不存在。');
    const headers = provider.protocol === 'anthropic-messages'
      ? { 'Content-Type': 'application/json', ...(secret ? { 'x-api-key': secret } : {}), 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
    let response;
    try {
      response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? '模型列表请求超时。' : `模型列表请求失败：${error.message}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`模型列表接口返回 HTTP ${response.status}。`);
    }
    const data = await response.json();
    const rows = modelRows(data).filter((row) => !unsupportedModel(row));
    const current = new Map((provider.models || []).map((model) => [model.id, model]));
    const models = rows
      .map((row) => modelSpecFromRemote(row, current.get(String(row?.id || row?.name || '').trim())))
      .filter((model) => model.id);
    if (!models.length) throw new Error('模型列表接口没有返回可用于聊天的模型。');
    const record = this.save({ ...provider, models }, id);
    return {
      provider: record,
      endpoint,
      discovered: models.length,
      previous: current.size,
      removed: [...current.keys()].filter((modelId) => !models.some((model) => model.id === modelId)),
    };
  }
  select(
    assistant = {},
    { exclude = [], modelOverride = '', exactModel = false, allowWithoutTools = false } = {},
  ) {
    const all = this.list();
    if (!all.length) return null;
    const ids = assistant.providerIds ?? [];
    const candidates = (
      ids.length
        ? ids.map((id) => all.find((p) => p.id === id)).filter(Boolean)
        : all
    ).filter((p) => p.enabled && TEXT_PROTOCOLS.has(p.protocol) && !exclude.includes(p.id));
    const needsTools = !allowWithoutTools && (
      assistant.requiredTools === true ||
      Object.values(assistant.tools ?? {}).some(Boolean) ||
      (assistant.capabilityIds?.length ?? 0) > 0
    );
    const requestedModel = modelOverride || '';
    const failures = [];
    const routingCandidates = candidates.map((provider) => {
      const model = [...provider.models].sort(
        (a, b) => Number(b.id === assistant.model) - Number(a.id === assistant.model),
      ).find((item) =>
        (!exactModel || !requestedModel || item.id === requestedModel) &&
        (!needsTools || item.tools) &&
        (!assistant.requiresVision || item.vision) &&
        item.contextWindow >= (assistant.requiredContextWindow ?? 1),
      );
      return {
        providerId: provider.id,
        providerName: provider.name,
        priority: provider.priority,
        models: provider.models.map((item) => item.id),
        ...(model ? { model: model.id, status: 'considered' } : {
          status: 'ineligible',
          reason: exactModel && requestedModel
            ? `没有满足模型 ${requestedModel} 能力要求的候选。`
            : '没有满足工具、视觉或上下文能力要求的候选。',
        }),
      };
    });
    for (const provider of candidates) {
      const candidate = routingCandidates.find((item) => item.providerId === provider.id);
      const models = [...provider.models].sort(
        (a, b) =>
          Number(b.id === assistant.model) - Number(a.id === assistant.model),
      );
      const model = models.find(
        (item) =>
          (!exactModel || !requestedModel || item.id === requestedModel) &&
          (!needsTools || item.tools) &&
          (!assistant.requiresVision || item.vision) &&
          item.contextWindow >= (assistant.requiredContextWindow ?? 1),
      );
      if (!model) {
        candidate.status = 'ineligible';
        candidate.reason = exactModel && requestedModel
          ? `没有满足模型 ${requestedModel} 能力要求的候选。`
          : '没有满足工具、视觉或上下文能力要求的候选。';
        continue;
      }
      candidate.model = model.id;
      try {
        const secret = provider.credentialId
          ? this.vault.get(provider.credentialId)
          : '';
        if (provider.credentialId && !secret)
          throw new Error('供应商凭据不存在。');
        candidate.status = 'selected';
        return {
          providerId: provider.id,
          providerName: provider.name,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          model: model.id,
          modelSpec: model,
          credentialId: provider.credentialId,
          secret: secret || 'local-keyless-endpoint',
          routingCandidates: routingCandidates.map(({ models: _models, ...item }) => ({ ...item })),
        };
      } catch (error) {
        candidate.status = 'unavailable';
        candidate.reason = error.message;
        failures.push(error.message);
      }
    }
    throw new Error(
      failures[0] ||
        '没有满足助手能力要求的可用模型，请检查供应商、工具调用能力和路由设置。',
    );
  }
  async evaluateDecision({ providerId = '', model: modelId = '', state, questions } = {}) {
    const candidates = this.list().filter(provider =>
      provider.enabled && provider.protocol === 'typesafe-system-one' &&
      (!providerId || provider.id === providerId),
    );
    if (!candidates.length) throw new Error('没有启用的 TypeSafe 决策供应商，请先在模型管理中配置。');
    const provider = candidates[0];
    if (!['string', 'object'].includes(typeof state) || state === null) {
      throw new Error('TypeSafe state 必须是字符串、对象或数组。');
    }
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length || Object.keys(questions).length > 100)
      throw new Error('TypeSafe questions 必须是 1 至 100 个问题的对象。');
    const serialized = JSON.stringify({ state, questions });
    if (serialized.length > 500_000) throw new Error('TypeSafe 请求内容不能超过 500 KB。');
    for (const [id, question] of Object.entries(questions)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !question || typeof question !== 'object' || Array.isArray(question))
        throw new Error(`TypeSafe 问题 ${id} 无效。`);
      if (!['choice', 'score', 'noul'].includes(question.type)) throw new Error(`TypeSafe 问题 ${id} 的类型不支持。`);
      if (typeof question.instructions !== 'string' || !question.instructions.trim()) throw new Error(`TypeSafe 问题 ${id} 缺少 instructions。`);
      if (question.type === 'choice' && (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 100))
        throw new Error(`TypeSafe 选择题 ${id} 必须包含 2 至 100 个 options。`);
    }
    const model = provider.models.find(item => item.id === (modelId || provider.models[0]?.id));
    if (!model) throw new Error('TypeSafe 模型不存在。');
    const secret = provider.credentialId ? this.vault.get(provider.credentialId) : '';
    if (provider.credentialId && !secret) throw new Error('供应商凭据不存在。');
    const headers = { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
    let status;
    let response;
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(providerEndpoint(provider), {
          method: 'POST', headers,
          body: JSON.stringify({ state, model: model.id, questions }),
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        status = response.status;
        if (!(status === 429 || status === 529 || status >= 500) || attempt === 2) break;
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`接口返回 HTTP ${status}`);
      }
      const data = await response.json();
      if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') throw new Error('TypeSafe 返回缺少 answers。');
      return { ...data, route: { providerId: provider.id, providerName: provider.name, model: model.id, protocol: provider.protocol, latencyMs: Date.now() - started } };
    } catch (error) {
      const message = String(error.message || error).split(secret || '\0').join('[隐藏]').slice(0, 500);
      throw new Error(status ? `TypeSafe 接口返回 HTTP ${status}：${message}` : message);
    }
  }
  async probe(id, { model: modelId, toolTest = false } = {}) {
    const provider = this.records.get('providers', id);
    if (!provider) throw new Error('模型供应商不存在。');
    const model = provider.models.find(
      (item) => item.id === (modelId || provider.models[0].id),
    );
    if (!model) throw new Error('模型不存在。');
    const secret = provider.credentialId
      ? this.vault.get(provider.credentialId)
      : '';
    if (provider.credentialId && !secret) throw new Error('供应商凭据不存在。');
    if (provider.protocol === 'typesafe-system-one') {
      if (toolTest) throw new Error('TypeSafe 是结构化决策接口，不支持工具调用测试。');
      const started = Date.now();
      let status;
      let health;
      try {
        const response = await fetch(providerEndpoint(provider), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
          body: JSON.stringify({ state: { check: 'connection' }, model: model.id, questions: { reachable: { type: 'noul', instructions: 'Is this connection reachable?' } } }),
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        status = response.status;
        if (!response.ok) { await response.body?.cancel(); throw new Error(`接口返回 HTTP ${status}`); }
        const data = await response.json();
        if (typeof data.answers?.reachable?.noul !== 'number') throw new Error('接口没有返回有效的 noul 结果。');
        health = { ok: true, status, model: model.id, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, toolTest: false, structured: true };
      } catch (error) {
        health = { ok: false, model: model.id, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, toolTest: false, status: status ?? null, structured: true, error: status && status !== 200 ? `接口返回 HTTP ${status}` : error.name === 'TimeoutError' ? '接口连接超时。' : String(error.message).split(secret || '\0').join('[隐藏]').slice(0, 500) };
      }
      const current = this.records.get('providers', id);
      if (current && current.revision === provider.revision) this.records.save('providers', { ...current, health, enabled: [401, 403].includes(status) ? false : current.enabled }, id);
      return health;
    }
    const fn = {
      name: 'connection_check',
      description: 'Return the connection test result.',
      parameters: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    };
    const prompt = toolTest
      ? 'Call connection_check with ok=true.'
      : 'Reply with OK.';
    const headers = {
      'Content-Type': 'application/json',
      ...(provider.protocol === 'anthropic-messages'
        ? {
            ...(secret ? { 'x-api-key': secret } : {}),
            'anthropic-version': '2023-06-01',
          }
        : secret
          ? { Authorization: `Bearer ${secret}` }
          : {}),
    };
    let body;
    if (provider.protocol === 'openai-responses')
      body = {
        model: model.id,
        input: prompt,
        max_output_tokens: 256,
        ...(toolTest
          ? {
              tools: [{ type: 'function', ...fn, strict: true }],
              tool_choice: { type: 'function', name: fn.name },
            }
          : {}),
      };
    else if (provider.protocol === 'anthropic-messages')
      body = {
        model: model.id,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
        ...(toolTest
          ? {
              tools: [
                {
                  name: fn.name,
                  description: fn.description,
                  input_schema: fn.parameters,
                },
              ],
              tool_choice: { type: 'tool', name: fn.name },
            }
          : {}),
      };
    else
      body = {
        model: model.id,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        ...(toolTest
          ? {
              tools: [{ type: 'function', function: fn }],
              tool_choice: { type: 'function', function: { name: fn.name } },
            }
          : {}),
      };
    const started = Date.now();
    let status;
    let health;
    try {
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(providerEndpoint(provider), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        status = response.status;
        if (!(status === 429 || status >= 500) || attempt === 2) break;
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`接口返回 HTTP ${status}`);
      }
      const data = await response.json();
      const calls =
        provider.protocol === 'openai-responses'
          ? data.output?.filter((item) => item.type === 'function_call')
          : provider.protocol === 'anthropic-messages'
            ? data.content?.filter((item) => item.type === 'tool_use')
            : data.choices?.[0]?.message?.tool_calls;
      const hasText =
        provider.protocol === 'openai-responses'
          ? data.output?.some((item) =>
              item.content?.some(
                (content) => content.type === 'output_text' && content.text,
              ),
            )
          : provider.protocol === 'anthropic-messages'
            ? data.content?.some((item) => item.type === 'text' && item.text)
            : !!data.choices?.[0]?.message?.content;
      if (
        toolTest &&
        !calls?.some((item) => (item.function?.name ?? item.name) === fn.name)
      )
        throw new Error('接口连通，但未返回要求的工具调用。');
      if (!toolTest && !hasText) throw new Error('接口没有返回有效文本响应。');
      health = {
        ok: true,
        status,
        model: model.id,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        toolTest,
        tools: toolTest ? true : null,
      };
    } catch (error) {
      health = {
        ok: false,
        model: model.id,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        toolTest,
        status: status ?? null,
        error:
          status && status !== 200
            ? `接口返回 HTTP ${status}`
            : error.name === 'TimeoutError'
              ? '接口连接超时。'
              : String(error.message)
                  .split(secret || '\0')
                  .join('[隐藏]')
                  .slice(0, 500),
      };
    }
    const current = this.records.get('providers', id);
    if (current && current.revision === provider.revision)
      this.records.save(
        'providers',
        {
          ...current,
          health,
          models: current.models.map((item) =>
            item.id === model.id && toolTest && status === 200
              ? { ...item, tools: health.ok }
              : item,
          ),
          enabled: [401, 403].includes(status) ? false : current.enabled,
        },
        id,
      );
    return health;
  }
}
