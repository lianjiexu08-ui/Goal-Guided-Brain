#!/usr/bin/env node
/**
 * 工作台重启助手：独立进程完成 杀旧 → 等死 → 等端口释放 → 拉新 → 确认健康。
 * CLI 用 detached 模式启动本助手后立即退出，时序不受 CLI 退出影响。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [, , oldPidArg, portArg, dataDirArg, serverPathArg] = process.argv;
const oldPid = Number(oldPidArg);
const port = Number(portArg) || 3089;
const dataDir = dataDirArg || path.join(os.homedir(), '.dsh-workbench');
const serverPath = serverPathArg || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const base = `http://127.0.0.1:${port}`;
const log = message => process.stderr.write(`${message}\n`);

const portFree = async () => {
  try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) }); return false; }
  catch { return true; }
};

if (oldPid) {
  log(`· 结束旧工作台实例（PID ${oldPid}）…`);
  try { process.kill(oldPid, 'SIGTERM'); } catch {}
  // 等进程死透
  for (let index = 0; index < 40; index += 1) {
    let alive = true;
    try { process.kill(oldPid, 0); } catch { alive = false; }
    if (!alive) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // 等端口释放（垂死实例可能仍在响应）
  for (let index = 0; index < 40; index += 1) {
    if (await portFree()) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // 仍占用 → SIGKILL 升级
  if (!(await portFree())) {
    try {
      const { execFileSync } = await import('node:child_process');
      const listeners = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 }).trim();
      for (const pid of listeners.split('\n').filter(Boolean)) {
        log(`· 强制结束占用端口的孤儿（PID ${pid}）…`);
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
      for (let index = 0; index < 20; index += 1) {
        if (await portFree()) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch {}
  }
}

log('· 拉起新工作台…');
const out = fs.openSync(path.join(dataDir, 'autostart.log'), 'a');
let child = null;
for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
  child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, WORKBENCH_API_PORT: String(port), WORKBENCH_DATA_DIR: dataDir },
  });
  child.unref();
  let ready = false;
  for (let index = 0; index < 60; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (child.exitCode !== null) break;
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (health.ok) { ready = true; break; }
    } catch {}
  }
  if (ready) { log('· 工作台重启完成。'); break; }
  log(`· 第 ${attemptNo} 次启动未就绪，重试…`);
  if (attemptNo === 3) { log('· 重启失败，请查看 autostart.log。'); process.exit(1); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
fs.closeSync(out);
process.exit(0);
