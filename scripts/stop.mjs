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
try {
  command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
} catch {
  fs.unlinkSync(file);
  console.log('服务已经停止。');
  process.exit(0);
}
if (
  !command.includes('node scripts/start.mjs') &&
  !command.includes('/node scripts/start.mjs') &&
  !command
    .trimEnd()
    .endsWith(` ${fileURLToPath(new URL('./start.mjs', import.meta.url))}`)
)
  throw new Error('PID 已被其他进程使用，未终止该进程。');
process.kill(pid, 'SIGTERM');
console.log('正在停止工作台；本机任务将停止，远程任务等待节点对账。');
