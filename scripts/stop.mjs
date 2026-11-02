import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../server/runtime.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const startScriptPath = path.join(repoRoot, 'scripts', 'start.mjs');

export function defaultDataDir(env = process.env) {
  return env.WORKBENCH_DATA_DIR || path.join(os.homedir(), '.dsh-workbench');
}

const normalize = (value) => String(value).trimEnd().toLowerCase().replaceAll('\\', '/');

/**
 * Read the command line of a running process, or '' when it is gone.
 *
 * `ps` is not available in a normal Windows shell. PowerShell ships with
 * supported Windows versions and lets us retain the same PID ownership check
 * before sending SIGTERM.
 */
export function processCommand(pid, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'win32') {
    const query = `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CommandLine }`;
    try {
      return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
        encoding: 'utf8',
      }).trim();
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Windows PowerShell 不可用，无法安全检查服务进程。');
      throw error;
    }
  }
  try {
    return run('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** The supervisor recorded in service.pid runs `scripts/start.mjs`. */
export function isSupervisorCommand(command, { startScript = startScriptPath } = {}) {
  const value = normalize(command);
  const script = normalize(startScript);
  return (
    value.includes('node scripts/start.mjs') ||
    value.includes('/node scripts/start.mjs') ||
    value.endsWith(` ${script}`) ||
    value.endsWith(script)
  );
}

/**
 * The control-lock owner is the API child the supervisor spawns as
 * `node server/index.mjs` with cwd set to the repository root, so accept both
 * the relative form `ps` may report and the resolved absolute path.
 */
export function isControlOwnerCommand(command, { root = repoRoot } = {}) {
  const value = normalize(command);
  const absolute = normalize(path.join(root, 'server', 'index.mjs'));
  // Accept the bare relative form exactly as spawned (cwd is the repo root),
  // but never a same-named script living under some other directory.
  return value.endsWith(absolute) || /(^|\s)server\/index\.mjs$/.test(value);
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Stop the workbench.
 *
 * Two independent records can point at a live service:
 *
 *  - `service.pid` — written by the supervisor (`scripts/start.mjs`).
 *  - `control.lock` — written by the API process itself, holding its own pid.
 *
 * The supervisor deletes `service.pid` from its `exit` handler, but that
 * handler does not run when it is killed abruptly (terminal closed, SIGKILL,
 * host reboot of the parent shell).  Its children are then re-parented to init
 * and keep running, so the pid file is gone while the API still holds the data
 * directory lock and its port.  Recovering from that state used to be
 * impossible with the documented commands: `npm run stop` reported "没有找到
 * 运行中的常驻服务" and `npm start` refused with "同一数据目录已有控制端运行".
 * Falling back to the lock owner closes that dead end, with the same
 * command-line ownership check used for the supervisor so we never terminate
 * an unrelated process that happens to reuse the pid.
 */
/**
 * Reap children recorded by the supervisor in service.children.json.
 *
 * Only the API child writes control.lock, so the UI child would otherwise be
 * invisible after an abnormal supervisor exit and keep holding the UI port.
 * Each pid is verified against the absolute script path the supervisor
 * recorded before anything is terminated, so a recycled pid cannot get an
 * unrelated process killed.
 */
function reapRecordedChildren(dataDir, { command, terminate }) {
  const childrenFile = path.join(dataDir, 'service.children.json');
  const recorded = readJson(childrenFile);
  if (!Array.isArray(recorded)) return [];
  const stopped = [];
  for (const entry of recorded) {
    if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 1) continue;
    if (typeof entry.script !== 'string' || !entry.script) continue;
    const running = command(entry.pid);
    if (!running) continue;
    if (!normalize(running).includes(normalize(entry.script))) continue;
    terminate(entry.pid);
    stopped.push(entry.pid);
  }
  try {
    fs.unlinkSync(childrenFile);
  } catch {
    /* Already gone. */
  }
  return stopped;
}

export function stopWorkbench({
  dataDir = defaultDataDir(),
  platform = process.platform,
  command = (pid) => processCommand(pid, { platform }),
  terminate = terminateProcessTree,
  root = repoRoot,
  startScript = startScriptPath,
} = {}) {
  const pidFile = path.join(dataDir, 'service.pid');
  const lockFile = path.join(dataDir, 'control.lock');
  let clearedStaleSupervisor = false;

  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('无效的服务 PID。');
    const running = command(pid);
    if (!running) {
      // A dead supervisor does not mean the service is down: its children may
      // still be alive, so drop the record and fall through to the lock.
      fs.unlinkSync(pidFile);
      clearedStaleSupervisor = true;
    } else if (!isSupervisorCommand(running, { startScript })) {
      throw new Error('PID 已被其他进程使用，未终止该进程。');
    } else {
      terminate(pid);
      // Killing the supervisor's tree takes the children with it; clear the
      // recovery record so a later run does not reconsider dead pids.
      reapRecordedChildren(dataDir, { command, terminate });
      return {
        status: 'stopped',
        pid,
        message: '正在停止工作台；本机任务将停止，远程任务等待节点对账。',
      };
    }
  }

  // No live supervisor.  Whatever it spawned may still be running, so reap the
  // recorded children first — this is the only record of the UI child.
  const orphans = reapRecordedChildren(dataDir, { command, terminate });

  // An orphaned API child also keeps the data-directory lock.
  const owner = readJson(lockFile);
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 1) {
    const running = command(owner.pid);
    if (!running) {
      fs.unlinkSync(lockFile);
      return {
        status: orphans.length ? 'stopped-orphan' : 'stale-lock',
        pids: orphans,
        message: orphans.length
          ? `停止了 ${orphans.length} 个遗留进程（PID ${orphans.join('、')}），并清理了控制端锁。`
          : '清理了上次异常退出遗留的控制端锁。',
      };
    }
    if (!isControlOwnerCommand(running, { root }))
      throw new Error('控制端锁记录的 PID 已被其他进程使用，未终止该进程。');
    if (!orphans.includes(owner.pid)) {
      terminate(owner.pid);
      orphans.push(owner.pid);
    }
    return {
      status: 'stopped-orphan',
      pid: owner.pid,
      pids: orphans,
      message:
        `停止了 ${orphans.length} 个遗留进程（PID ${orphans.join('、')}）——` +
        '上次的管理进程异常退出，留下了未被回收的子进程。',
    };
  }

  if (orphans.length)
    return {
      status: 'stopped-orphan',
      pids: orphans,
      message:
        `停止了 ${orphans.length} 个遗留进程（PID ${orphans.join('、')}）——` +
        '上次的管理进程异常退出，留下了未被回收的子进程。',
    };

  return {
    status: clearedStaleSupervisor ? 'already-stopped' : 'not-running',
    pids: [],
    message: clearedStaleSupervisor ? '服务已经停止。' : '没有找到运行中的常驻服务。',
  };
}

// Only act when executed directly, so the functions above stay importable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(stopWorkbench().message);
}
