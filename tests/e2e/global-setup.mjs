import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 全局 setup：清除上一次运行残留的 fixture 数据目录。
// Windows 上 teardown 的删除可能因句柄延迟释放而失败（EBUSY），
// 残留数据会让下一次运行看到重复草稿/旧团队，造成跨运行污染。
// 在这里用重试删除保证每次运行都从空目录开始。
export default async function globalSetup() {
  const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    // 残留无法删除时记录即可；目录会 被 config 的 mkdirSync 复用，
    // 种子脚本对已有数据幂等。
    console.warn(`[e2e-setup] 旧 fixture 清理失败，将在现有数据上运行：${dataDir}`);
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
