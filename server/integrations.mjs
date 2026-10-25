/**
 * 集成出口层（Integration Hub）。
 *
 * GGB 的"出口"：把工作台事件推送到外部渠道（Webhook、企业微信群机器人、
 * QQ OneBot），并允许外部渠道把消息发回团队空间（入站聊天）。
 *
 * 设计原则：
 * - 渠道是适配器：内置 webhook / wecom-bot / qq-onebot 三种，registerChannel
 *   可注册自定义渠道（NapCat、LLoneBot、微信公众号网关等），不需要改核心。
 * - 出站统一事件信封：{ event, at, data }；渠道适配器只负责把信封变成各自协议。
 * - 入站统一校验：每个集成有独立密钥（webhook 用 HMAC 签名，QQ 用 access token），
 *   校验通过后把文本作为 owner 消息送进指定团队空间的项目经理轮次。
 * - 投递留痕：每次投递写入 integration-events（状态、错误、响应码），可审计。
 * - 凭据最小化：secret 在列表输出中被掩码；密钥只用于签名/校验，不随事件外发。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const INTEGRATION_TYPES = new Set(['webhook', 'wecom-bot', 'qq-onebot', 'feishu-bot', 'dingtalk-bot', 'bridge']);
const DEFAULT_EVENTS = ['attention', 'task.completed'];
const ALLOWED_EVENTS = new Set(['attention', 'task.completed', 'verification.failed']);
const MAX_DELIVERY_LOG = 500;

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class IntegrationService {
  constructor({ records, now = () => Date.now(), fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    this.records = records;
    this.now = now;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.channels = new Map();
    this.registerBuiltinChannels();
  }

  /** 内置渠道适配器。send(payload, integration, event) 返回 { ok, status?, error? }。 */
  registerBuiltinChannels() {
    // 通用 Webhook：POST JSON 信封 + HMAC 签名头。
    this.registerChannel('webhook', { send: async (payload, integration) => {
      const url = integration.config?.url;
      if (!url) return { ok: false, error: '缺少 webhook URL。' };
      const body = JSON.stringify(payload);
      const headers = { 'Content-Type': 'application/json' };
      if (integration.config?.secret)
        headers['X-GGB-Signature'] = createHmac('sha256', integration.config.secret).update(body).digest('hex');
      const response = await this.fetchImpl(url, { method: 'POST', headers, body });
      return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
      } });
    // 企业微信群机器人：POST {"msgtype":"text"}。url 为完整机器人 webhook 地址。
    this.registerChannel('wecom-bot', { send: async (payload, integration) => {
      const url = integration.config?.url;
      if (!url || !/qyapi\.weixin\.qq\.com|webhook\/send/.test(url)) return { ok: false, error: '缺少有效的企业微信机器人 webhook URL。' };
      const content = this.renderText(payload);
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content } }),
      });
      const result = await response.json().catch(() => ({}));
      return { ok: response.ok && result?.errcode === 0, status: response.status, error: result?.errcode === 0 ? null : `企业微信返回 ${result?.errcode ?? response.status}` };
      } });
    // QQ OneBot v11 HTTP：POST /send_group_msg 或 /send_private_msg，access_token 鉴权。
    this.registerChannel('qq-onebot', { send: async (payload, integration) => {
      const base = (integration.config?.url || '').replace(/\/+$/, '');
      const targetId = integration.config?.qqTargetId;
      const targetType = integration.config?.qqTargetType === 'private' ? 'private' : 'group';
      if (!base || !targetId) return { ok: false, error: '缺少 OneBot 地址或目标 ID。' };
      const path = targetType === 'group' ? '/send_group_msg' : '/send_private_msg';
      const field = targetType === 'group' ? 'group_id' : 'user_id';
      const headers = { 'Content-Type': 'application/json' };
      if (integration.config?.accessToken) headers.Authorization = `Bearer ${integration.config.accessToken}`;
      const response = await this.fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ [field]: Number(targetId) || targetId, message: [{ type: 'text', data: { text: this.renderText(payload) } }] }),
      });
      const result = await response.json().catch(() => ({}));
      return { ok: response.ok && result?.status !== 'failed', status: response.status, error: result?.status === 'failed' ? 'OneBot 返回 failed' : null };
      } });
    // 飞书自定义机器人：POST {"msg_type":"text"}，url 为完整 webhook 地址。
    this.registerChannel('feishu-bot', { send: async (payload, integration) => {
      const url = integration.config?.url;
      if (!url || !/open\.feishu\.cn|webhook/.test(url)) return { ok: false, error: '缺少有效的飞书机器人 webhook URL。' };
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: this.renderText(payload) } }),
      });
      const result = await response.json().catch(() => ({}));
      const ok = response.ok && (result?.code === 0 || result?.StatusCode === 0);
      return { ok, status: response.status, error: ok ? null : `飞书返回 ${result?.code ?? result?.StatusCode ?? response.status}` };
      } });
    // 钉钉自定义机器人：POST {"msgtype":"text"}；配置 secret 时自动加时间戳签名。
    this.registerChannel('dingtalk-bot', { send: async (payload, integration) => {
      let url = integration.config?.url;
      if (!url || !/oapi\.dingtalk\.com|robot\/send/.test(url)) return { ok: false, error: '缺少有效的钉钉机器人 webhook URL。' };
      const secret = integration.config?.secret;
      if (secret) {
        const timestamp = Date.now();
        const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
        url = `${url}${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: this.renderText(payload) } }),
      });
      const result = await response.json().catch(() => ({}));
      const ok = response.ok && result?.errcode === 0;
      return { ok, status: response.status, error: ok ? null : `钉钉返回 ${result?.errcode ?? response.status}` };
      } });
    // 通用桥接渠道：为 QQ/个人微信等无原生 webhook 的平台预留标准入口。
    // 外部桥（NapCat、wechaty、WeChatFerry 等二开桥）用 Bearer token 调入站接口，
    // 出站则用与 webhook 相同的 JSON 信封 POST 到 config.url（可选）。
    this.registerChannel('bridge', { send: async (payload, integration) => {
      const url = integration.config?.url;
      if (!url) return { ok: false, error: '桥接渠道未配置出站 URL；仅入站时可留空。' };
      const headers = { 'Content-Type': 'application/json' };
      if (integration.config?.accessToken) headers.Authorization = `Bearer ${integration.config.accessToken}`;
      const response = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
      } });
  }

  registerChannel(type, adapter) {
    if (typeof adapter?.send !== 'function') throw new Error('渠道适配器需要 send 函数。');
    this.channels.set(type, adapter);
    return { registered: true, type };
  }

  renderText({ event, at, data }) {
    const lines = [`[GGB] ${event}`];
    if (data?.title) lines.push(String(data.title).slice(0, 200));
    if (data?.detail) lines.push(String(data.detail).slice(0, 800));
    if (!data?.title && !data?.detail && data) {
      try { lines.push(JSON.stringify(data).slice(0, 800)); } catch {}
    }
    lines.push(`(${at})`);
    return lines.join('\n');
  }

  // ---- 配置管理 ----

  list() {
    return this.records.list('integrations').map(integration => this.publicIntegration(integration));
  }

  get(id) {
    const integration = this.records.get('integrations', id);
    return integration ? this.publicIntegration(integration) : null;
  }

  /** 输出掩码：密钥只回显尾 4 位。 */
  publicIntegration(integration) {
    const config = { ...integration.config };
    for (const key of ['secret', 'accessToken'])
      if (config[key]) config[key] = `***${String(config[key]).slice(-4)}`;
    return { ...integration, config };
  }

  save(input = {}, id = null) {
    const type = text(input.type, 40);
    if (!INTEGRATION_TYPES.has(type)) throw new Error(`集成类型必须是 ${[...INTEGRATION_TYPES].join(' / ')}；其他渠道可通过 registerChannel 注册。`);
    const name = text(input.name, 120) || type;
    const events = (Array.isArray(input.events) ? input.events : DEFAULT_EVENTS)
      .map(event => text(event, 60)).filter(event => ALLOWED_EVENTS.has(event));
    const rawConfig = input.config && typeof input.config === 'object' ? input.config : {};
    const previous = id ? this.records.get('integrations', id) : null;
    if (id && !previous) throw new Error('集成不存在。');
    // 掩码密钥原样传回时保留旧值，避免 GET→PUT 把密钥改成 "***xxxx"。
    const config = {
      url: text(rawConfig.url, 1000) || previous?.config?.url || '',
      secret: this.mergeSecret(rawConfig.secret, previous?.config?.secret),
      accessToken: this.mergeSecret(rawConfig.accessToken, previous?.config?.accessToken),
      qqTargetType: rawConfig.qqTargetType === 'private' ? 'private' : 'group',
      qqTargetId: text(rawConfig.qqTargetId, 40) || previous?.config?.qqTargetId || '',
      teamId: text(rawConfig.teamId, 160) || previous?.config?.teamId || '',
    };
    if (!config.url && type !== 'bridge')
      throw new Error('集成需要配置 URL（webhook / 机器人地址 / OneBot 地址）；桥接渠道可仅入站。');
    const record = {
      type, name, config,
      events: events.length ? events : [...DEFAULT_EVENTS],
      enabled: input.enabled !== false,
      channel: text(input.channel, 60) || null,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const saved = this.records.save('integrations', record, id || undefined);
    return this.publicIntegration(saved);
  }

  mergeSecret(incoming, previous) {
    const value = text(incoming, 500);
    if (!value) return previous || '';
    if (value.startsWith('***')) return previous || '';
    return value;
  }

  remove(id) {
    const existing = this.records.get('integrations', id);
    if (!existing) return false;
    this.records.remove('integrations', id);
    return true;
  }

  // ---- 出站 ----

  /** 把事件投递给所有启用且订阅了该事件的集成。fire-and-forget：错误只落日志。 */
  async dispatch(event, data = {}) {
    const targets = this.records.list('integrations')
      .filter(integration => integration.enabled && (integration.events || []).includes(event));
    const results = [];
    for (const integration of targets) {
      results.push(await this.deliver(integration, { event, at: new Date(this.now()).toISOString(), data }));
    }
    return results;
  }

  async deliver(integration, payload) {
    // channel 字段可覆盖默认内置适配器（例如 webhook 类型走自定义 feishu 适配器）。
    const adapter = (integration.channel && this.channels.get(integration.channel))
      || this.channels.get(integration.type);
    let outcome = { ok: false, error: `没有可用的 ${integration.type} 渠道适配器。` };
    if (adapter) {
      if (!this.fetchImpl) outcome = { ok: false, error: '当前运行环境没有可用的 fetch。' };
      else {
        try {
          outcome = await adapter.send(payload, integration, payload.event);
        } catch (error) {
          outcome = { ok: false, error: text(error.message, 400) };
        }
      }
    }
    this.logDelivery(integration, payload.event, outcome);
    return { integrationId: integration.id, ...outcome };
  }

  logDelivery(integration, event, outcome) {
    try {
      // 留痕上限：超过容量时删除最旧的一条，保证日志不无限增长。
      const existing = this.records.list('integration-events');
      if (existing.length >= MAX_DELIVERY_LOG) {
        const oldest = existing[existing.length - 1];
        if (oldest) this.records.remove('integration-events', oldest.id);
      }
      this.records.save('integration-events', {
        integrationId: integration.id,
        type: integration.type,
        event,
        status: outcome.ok ? 'sent' : 'failed',
        responseStatus: outcome.status ?? null,
        error: outcome.error || null,
        at: new Date(this.now()).toISOString(),
      });
    } catch {}
  }

  deliveries(integrationId = null, { limit = 50 } = {}) {
    return this.records.list('integration-events')
      .filter(item => !integrationId || item.integrationId === integrationId)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  // ---- 入站 ----

  /**
   * 校验入站请求。webhook：HMAC 签名头；qq-onebot：Bearer access token。
   * 返回 { ok } 或 { ok: false, reason }。
   */
  verifyInbound(integration, { headers = {}, rawBody = '' } = {}) {
    if (integration.type === 'webhook') {
      const secret = integration.config?.secret;
      if (!secret) return { ok: false, reason: '该集成未配置签名密钥，入站已禁用。' };
      const signature = headers['x-ggb-signature'] || headers['X-GGB-Signature'] || '';
      const expected = createHmac('sha256', secret).update(String(rawBody)).digest('hex');
      return safeEqual(String(signature), expected) ? { ok: true } : { ok: false, reason: '签名校验失败。' };
    }
    if (integration.type === 'qq-onebot' || integration.type === 'bridge') {
      const token = integration.config?.accessToken;
      if (!token) return { ok: false, reason: '该集成未配置 access token，入站已禁用。' };
      const provided = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
      return safeEqual(provided, token) ? { ok: true } : { ok: false, reason: 'access token 校验失败。' };
    }
    return { ok: false, reason: `${integration.type} 暂不支持入站。` };
  }

  static verifyHelper() {
    return { safeEqual };
  }
}
