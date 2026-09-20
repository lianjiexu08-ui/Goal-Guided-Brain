import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RECORDS_SCHEMA } from './records.mjs';

export function backupDatabase(db, dataDir, label = 'manual') {
  const directory = path.join(dataDir, 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${randomUUID().slice(0, 8)}.sqlite`;
  const destination = path.join(directory, filename);
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  fs.chmodSync(destination, 0o600);
  return { filename, path: destination, bytes: fs.statSync(destination).size };
}

export function migrate(db, dataDir) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('数据库版本比当前应用新，请使用更新版本。');
  if (version === 1) return;
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    )
    .get();
  if (exists) {
    const backup = backupDatabase(db, dataDir, 'before-v1');
    const vault = path.join(dataDir, 'vault.json');
    if (fs.existsSync(vault))
      fs.copyFileSync(vault, `${backup.path}.vault.json`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(RECORDS_SCHEMA);
    db.exec('PRAGMA user_version=1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
