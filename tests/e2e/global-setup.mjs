import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 全局 setup：只确保 fixture 目录存在。
//
// 注意：不要在这里删除目录。Playwright 的 webServer 先于 globalSetup
// 启动——server 进程此刻已打开 workspace.sqlite；若删除重建目录，
// Linux 上 server 的句柄会指向已被 unlink 的旧文件（inode 分裂），
// worker 随后新建的新库与 server 的隐形旧库完全隔离，所有依赖
// "直接写库 fixture" 的测试都会失败（Windows 上删除会 EBUSY 失败
// 反而掩盖了这一问题的存在）。
//
// 残留数据清理由 scripts/e2e.mjs 的 mkdtemp（每次运行新目录）保证；
// 本地 teardown 失败的残留目录可手动删除。
export default async function globalSetup() {
  const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
