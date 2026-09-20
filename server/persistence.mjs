import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function lockControl(dataDir, { allowRecovery = false } = {}) {
  if (
    !allowRecovery &&
    fs.existsSync(path.join(dataDir, 'restore.pending.json'))
  )
    throw new Error(
      '上一次恢复尚未完成，请使用恢复工具和已保存的备份完成恢复后启动。',
    );
  const filename = path.join(dataDir, 'control.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token)
            fs.unlinkSync(filename);
        } catch {
          /* Another process may already have removed a stale lock. */
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
      } catch {
        throw new Error('控制端锁文件不可读取，请确认其他服务已停止。');
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1)
        throw new Error('控制端锁文件无效，请先检查已有服务。');
      try {
        process.kill(owner.pid, 0);
      } catch (failure) {
        if (failure.code === 'ESRCH' && attempt === 0) {
          fs.unlinkSync(filename);
          continue;
        }
        if (failure.code !== 'EPERM') throw failure;
      }
      throw new Error('同一数据目录已有控制端运行，请先停止原服务。');
    }
  }
  throw new Error('无法取得控制端锁。');
}
