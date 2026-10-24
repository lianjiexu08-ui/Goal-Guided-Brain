import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 代码指纹：server 目录内容的快速哈希。
 * CLI 用它判断常驻工作台是否在跑旧代码，需要自动重启。
 */
export function computeServerFingerprint(serverDir) {
  const hash = createHash('sha1');
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.mjs')) {
        const stat = fs.statSync(full);
        hash.update(item.name).update(String(stat.size)).update(String(Math.floor(stat.mtimeMs / 1000)));
      }
    }
  };
  walk(serverDir);
  return hash.digest('hex').slice(0, 12);
}
