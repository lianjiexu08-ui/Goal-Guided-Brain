import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { IntegrationService } from '../server/integrations.mjs';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import { DatabaseSync } from 'node:sqlite';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-integr-'));
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const records = new Records(db);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { records, directory };
}

// 可控的 fetch 替身：记录请求并返回预设响应。
function fakeFetch(t, responder) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    return responder(url, body, options);
  };
  t.after(() => {});
  return { calls, impl };
}

test('集成配置：类型校验、密钥掩码与更新时保留旧密钥', t => {
  const { records } = setup(t);
  const service = new IntegrationService({ records, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.throws(() => service.save({ type: 'nope', config: { url: 'https://x' } }), /集成类型/);
  assert.throws(() => service.save({ type: 'webhook', config: {} }), /需要配置 URL/);
  const created = service.save({ type: 'webhook', name: '我的出口', config: { url: 'https://example.com/hook', secret: 'super-secret' }, events: ['attention', 'bogus'] });
  assert.equal(created.config.secret, '*** ret'.replace(' ret', 'cret').slice(0, 0) + `***${'super-secret'.slice(-4)}`);
  assert.deepEqual(created.events, ['attention']); // 非法事件被过滤
  // GET→PUT 回传掩码不会覆盖真实密钥。
  const updated = service.save({ type: 'webhook', config: { url: 'https://example.com/hook2', secret: created.config.secret } }, created.id);
  assert.ok(updated.config.secret.startsWith('***'));
  const raw = records.get('integrations', created.id);
  assert.equal(raw.config.secret, 'super-secret');
  assert.equal(raw.config.url, 'https://example.com/hook2');
});

test('webhook 出站：HMAC 签名头与事件过滤', async t => {
  const { records } = setup(t);
  const { calls, impl } = fakeFetch(t, () => ({ ok: true, status: 200 }));
  const service = new IntegrationService({ records, fetchImpl: impl });
  const enabled = service.save({ type: 'webhook', config: { url: 'https://example.com/hook', secret: 's1' }, events: ['task.completed'] });
  service.save({ type: 'webhook', config: { url: 'https://example.com/other' }, events: ['attention'], enabled: false });
  await service.dispatch('task.completed', { title: '任务完成', status: 'completed' });
  await service.dispatch('attention', { title: '不应投递（未订阅）' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/hook');
  const expected = createHmac('sha256', 's1').update(calls[0].options.body).digest('hex');
  assert.equal(calls[0].options.headers['X-GGB-Signature'], expected);
  assert.equal(calls[0].body.event, 'task.completed');
  const logs = service.deliveries(enabled.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'sent');
});

test('wecom-bot 与 qq-onebot 出站适配器', async t => {
  const { records } = setup(t);
  const { calls, impl } = fakeFetch(t, (url) => ({
    ok: true, status: 200,
    json: async () => (/weixin/.test(url) ? { errcode: 0 } : { status: 'async' }),
  }));
  const service = new IntegrationService({ records, fetchImpl: impl });
  service.save({ type: 'wecom-bot', name: '企微群', config: { url: 'https://qyapi.weixin.qq.com/cgi-webhook/send?key=k1' }, events: ['attention'] });
  service.save({ type: 'qq-onebot', name: 'QQ群', config: { url: 'http://127.0.0.1:3000', qqTargetType: 'group', qqTargetId: '123456', accessToken: 'tok' }, events: ['attention'] });
  await service.dispatch('attention', { title: '需要确认', detail: '高风险操作待评审' });
  assert.equal(calls.length, 2);
  const wecom = calls.find(call => /weixin/.test(call.url));
  assert.equal(wecom.body.msgtype, 'text');
  assert.ok(wecom.body.text.content.includes('需要确认'));
  const qq = calls.find(call => /send_group_msg/.test(call.url));
  assert.equal(qq.body.group_id, 123456);
  assert.equal(qq.options.headers.Authorization, 'Bearer tok');
  assert.ok(qq.body.message[0].data.text.includes('高风险操作'));
});

test('出站失败留痕且不抛出', async t => {
  const { records } = setup(t);
  const { impl } = fakeFetch(t, () => { throw new Error('ECONNREFUSED'); });
  const service = new IntegrationService({ records, fetchImpl: impl });
  const created = service.save({ type: 'webhook', config: { url: 'https://unreachable' } });
  const results = await service.dispatch('task.completed', { title: 'x' });
  assert.equal(results[0].ok, false);
  assert.ok(/ECONNREFUSED/.test(results[0].error));
  assert.equal(service.deliveries(created.id)[0].status, 'failed');
});

test('自定义渠道适配器可以注册并参与投递', async t => {
  const { records } = setup(t);
  const service = new IntegrationService({ records, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const sent = [];
  service.registerChannel('feishu', { send: async (payload) => { sent.push(payload.event); return { ok: true }; } });
  assert.throws(() => service.registerChannel('bad', {}), /send 函数/);
  service.save({ type: 'webhook', config: { url: 'https://x' }, channel: 'feishu', events: ['attention'] });
  await service.dispatch('attention', { title: '走自定义渠道' });
  assert.deepEqual(sent, ['attention']);
});

test('入站校验：webhook HMAC 与 QQ token', t => {
  const { records } = setup(t);
  const service = new IntegrationService({ records, fetchImpl: async () => ({}) });
  const hook = service.save({ type: 'webhook', config: { url: 'https://x', secret: 'sec' } });
  const body = JSON.stringify({ text: '帮我看看测试' });
  const good = createHmac('sha256', 'sec').update(body).digest('hex');
  assert.equal(service.verifyInbound(records.get('integrations', hook.id), { headers: { 'x-ggb-signature': good }, rawBody: body }).ok, true);
  assert.equal(service.verifyInbound(records.get('integrations', hook.id), { headers: { 'x-ggb-signature': 'bad' }, rawBody: body }).ok, false);
  const qq = service.save({ type: 'qq-onebot', config: { url: 'http://q', accessToken: 'tok', qqTargetId: '1' } });
  assert.equal(service.verifyInbound(records.get('integrations', qq.id), { headers: { authorization: 'Bearer tok' } }).ok, true);
  assert.equal(service.verifyInbound(records.get('integrations', qq.id), { headers: { authorization: 'Bearer nope' } }).ok, false);
});

test('飞书与钉钉机器人出站', async t => {
  const { records } = setup(t);
  const { calls, impl } = fakeFetch(t, (url) => ({
    ok: true, status: 200,
    json: async () => (/feishu/.test(url) ? { code: 0 } : { errcode: 0 }),
  }));
  const service = new IntegrationService({ records, fetchImpl: impl });
  service.save({ type: 'feishu-bot', name: '飞书群', config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' }, events: ['task.completed'] });
  service.save({ type: 'dingtalk-bot', name: '钉钉群', config: { url: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SEC' }, events: ['task.completed'] });
  const results = await service.dispatch('task.completed', { title: '交付完成', status: 'completed' });
  assert.ok(results.every(result => result.ok));
  const feishu = calls.find(call => /feishu/.test(call.url));
  assert.equal(feishu.body.msg_type, 'text');
  assert.ok(feishu.body.content.text.includes('交付完成'));
  const dingtalk = calls.find(call => /dingtalk/.test(call.url));
  assert.ok(/timestamp=\d+&sign=/.test(dingtalk.url), '钉钉签名参数已附加');
  assert.equal(dingtalk.body.msgtype, 'text');
});

test('bridge 渠道：仅入站可不配 URL，Bearer token 校验', async t => {
  const { records } = setup(t);
  const service = new IntegrationService({ records, fetchImpl: async () => ({ ok: true, status: 200 }) });
  // 仅入站的桥：不配 URL 也能创建。
  const bridge = service.save({ type: 'bridge', name: '微信桥', config: { accessToken: 'wx-token', teamId: 'team-1' } });
  assert.equal(bridge.type, 'bridge');
  const headers = { authorization: 'Bearer wx-token' };
  assert.equal(service.verifyInbound(records.get('integrations', bridge.id), { headers }).ok, true);
  assert.equal(service.verifyInbound(records.get('integrations', bridge.id), { headers: { authorization: 'Bearer wrong' } }).ok, false);
  // 配了 URL 时出站走 JSON 信封。
  const { calls, impl } = fakeFetch(t, () => ({ ok: true, status: 200 }));
  const outbound = new IntegrationService({ records, fetchImpl: impl });
  outbound.save({ type: 'bridge', name: '双向往返', config: { url: 'http://bridge.local/push', accessToken: 't' } });
  await outbound.dispatch('task.completed', { title: 'x' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer t');
  assert.equal(calls[0].body.event, 'task.completed');
});

test('入站限流：滑动窗口与失败加速冷却', t => {
  const { records } = setup(t);
  const service = new IntegrationService({ records, fetchImpl: async () => ({}) });
  const created = service.save({ type: 'webhook', config: { url: 'https://x', secret: 'sec' } });
  const id = created.id;
  // 小窗口限制（便于测试）：每分钟 3 次。
  const limits = { limit: 3, windowMs: 60_000 };
  for (let index = 0; index < 3; index++)
    assert.equal(service.checkInboundRate(id, limits).ok, true);
  const blocked = service.checkInboundRate(id, limits);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /过于频繁/);
  assert.ok(blocked.retryAfterMs > 0);
  // 失败计数让后续窗口额度减半（3 → 1）。
  service.noteInboundFailure(id);
  const state = service.inboundHits.get(id);
  state.hits.length = 0; // 模拟窗口流逝
  assert.equal(service.checkInboundRate(id, limits).ok, true); // 减半后额度 1
  const second = service.checkInboundRate(id, limits);
  assert.equal(second.ok, false);
  assert.match(second.reason, /校验失败记录/);
});
