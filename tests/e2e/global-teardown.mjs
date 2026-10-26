import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown() {
  const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');
  // Windows 上 dev server 进程退出与文件句柄释放之间有时间差，重试删除；
  // 失败不阻塞测试结论，残留临时目录由系统 temp 策略回收。
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`[e2e-teardown] fixture 清理失败（无碍结论）：${error.message}`);
  }
}
