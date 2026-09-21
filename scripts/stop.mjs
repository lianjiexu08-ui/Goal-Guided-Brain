import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const file = path.join(
  process.env.WORKBENCH_DATA_DIR || path.join(os.homedir(), '.dsh-workbench'),
  'service.pid',
);
if (!fs.existsSync(file)) {
  console.log('没有找到运行中的常驻服务。');
  process.exit(0);
}
const pid = Number(fs.readFileSync(file, 'utf8'));
if (!Number.isInteger(pid) || pid <= 1) throw new Error('无效的服务 PID。');
let command;
if (process.platform === 'win32') {
  // `ps` is not available in a normal Windows shell. PowerShell ships with
  // supported Windows versions and lets us retain the same PID ownership
  // check before sending SIGTERM.
  const query = `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CommandLine }`;
  try {
    command = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', query,
    ], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Windows PowerShell 不可用，无法安全检查服务进程。');
    throw error;
  }
  if (!command) {
    fs.unlinkSync(file);
    console.log('服务已经停止。');
    process.exit(0);
  }
} else {
  try {
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
  } catch {
    fs.unlinkSync(file);
    console.log('服务已经停止。');
    process.exit(0);
  }
}

const normalizedCommand = command.trimEnd().toLowerCase().replaceAll('\\', '/');
const startScript = fileURLToPath(new URL('./start.mjs', import.meta.url))
  .toLowerCase().replaceAll('\\', '/');
if (
  !normalizedCommand.includes('node scripts/start.mjs') &&
  !normalizedCommand.includes('/node scripts/start.mjs') &&
  !normalizedCommand.endsWith(` ${startScript}`) &&
  !normalizedCommand.endsWith(startScript)
)
  throw new Error('PID 已被其他进程使用，未终止该进程。');
process.kill(pid, 'SIGTERM');
console.log('正在停止工作台；本机任务将停止，远程任务等待节点对账。');
