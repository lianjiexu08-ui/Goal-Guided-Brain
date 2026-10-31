import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

/**
 * 团队 SSE 流应推送 agent 事件（assistant/chunk、tool/call 等运行时事件增量），
 * 且新观察者连接时不回放历史事件（只推实时增量）。
 */
test('团队 SSE 流：hello 首帧 + agent 增量不回放历史', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-sse-agent-'));
  const app = createWorkbench({ dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const controller = new AbortController();
  let reader = null;
  t.after(async () => {
    // 先中断 SSE 客户端，再关服务器；否则 server.close 会等待连接关闭而死锁。
    controller.abort();
    try { await reader?.cancel(); } catch {}
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const api = async (endpoint, options = {}) => {
    const response = await fetch(`${base}/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const { body: team } = await api('/teams', {
    method: 'POST',
    body: { name: 'SSE流测试', goal: 'g', purpose: 'p', pmRoleId: 'project_manager', memberRoleIds: ['project_manager'] },
  });
  assert.ok(team?.id, '团队创建成功');

  // 产生一条历史消息；即使没有运行时事件，也不应影响 hello 首帧
  await api(`/teams/${team.id}/messages`, {
    method: 'POST',
    body: { clientMessageId: 'sse-agent-test-1', content: '测试' },
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  // 新观察者连接：首帧应是 hello
  const response = await fetch(`${base}/api/teams/${team.id}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const firstFrame = await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) return buffer.slice(0, boundary);
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  assert.ok(firstFrame, '5 秒内收到首帧');
  assert.match(firstFrame, /^event: hello$/m, '首帧是 hello');
});
