import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Store } from '../../server/store.mjs';

const dataDir = process.env.GGB_E2E_DATA_DIR;

// 诊断（observe）：定位 CI Linux 上"第二个 Store 连接写入的 fixture
// 对 server 进程不可见"的层级——直接写库后分别用 新连接 / HTTP API /
// 页面请求 三个途径观察同一份数据。
test('诊断：跨进程 SQLite 可见性', async ({ page }) => {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  const groupId = randomUUID();
  const jobId = `diag-job-${groupId.slice(0, 8)}`;
  const task = store.createTask({ role: 'developer', prompt: '诊断探针任务', workspace: process.cwd() });
  store.records.save(
    'jobs',
    {
      title: 'DIAG-PROBE-TITLE', goal: '诊断', role: 'developer', groupId,
      batchId: randomUUID(), status: 'failed', taskId: task.id, nodeId: 'local',
      workspace: process.cwd(), workspaceKey: 'default', requirementVersion: 1,
      depth: 0, maxDurationMinutes: 30, permissions: [],
    },
    jobId,
  );
  // 同进程立即可见？
  const sameConn = store.records.get('jobs', jobId);
  console.log(`[diag] same-connection sees: ${sameConn ? sameConn.title : 'MISSING'}`);
  // 新连接可见？（模拟 webServer 进程的读法）
  const fresh = new Store(dataDir, process.cwd());
  const freshRow = fresh.records.get('jobs', jobId);
  console.log(`[diag] fresh-connection sees: ${freshRow ? freshRow.title : 'MISSING'}`);
  fresh.close();

  // HTTP API（走真正的 server 进程）可见？
  await page.goto('/');
  await page.waitForTimeout(1500);
  const viaApi = await page.evaluate(async () => {
    const res = await fetch('/api/manage');
    const data = await res.json();
    return {
      jobTitles: (data.jobs || []).map((j) => j.title).slice(0, 10),
      hit: (data.jobs || []).some((j) => j.title === 'DIAG-PROBE-TITLE'),
    };
  });
  console.log(`[diag] http-api sees: hit=${viaApi.hit} jobs=${JSON.stringify(viaApi.jobTitles)}`);
  expect(viaApi.hit, 'HTTP API 应能看到直接写库的 fixture').toBe(true);
});


test('诊断：反向可见性——HTTP 写入的数据 worker Store 能否读到', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
  // 通过 HTTP 创建一个特征 provider
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'DIAG-HTTP-PROVIDER', protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9', models: [{ id: 'diag-model', name: 'diag-model', tools: true, contextWindow: 1000 }],
        enabled: false, priority: 999,
      }),
    });
    return res.json();
  });
  console.log(`[diag2] http-created provider id=${created?.id}`);
  // worker 的 Store 连接读
  const store = new Store(dataDir, process.cwd());
  const row = store.records.get('providers', created?.id || 'missing');
  console.log(`[diag2] worker-Store sees http-created provider: ${row ? row.name : 'MISSING'}`);
  console.log(`[diag2] worker-Store providers total: ${store.records.list('providers').length}`);
  // 同时列 worker Store 的 dataDir 与 jobs 计数，供比对
  console.log(`[diag2] worker Store dir: ${store.dir}`);
  store.close();
});
