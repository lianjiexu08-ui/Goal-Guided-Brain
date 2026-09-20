import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lockControl } from '../server/persistence.mjs';
import { backupDatabase } from '../server/migrations.mjs';

function validateDatabase(db) {
  db.exec('PRAGMA trusted_schema=OFF');
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok')
    throw new Error('备份数据库完整性检查失败。');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1].includes(version))
    throw new Error('备份数据库版本不受支持，请使用匹配版本的应用。');
  for (const [table, columns] of Object.entries({
    settings: ['id', 'data'],
    sessions: ['id', 'role', 'workspace', 'title', 'createdAt'],
    tasks: [
      'id',
      'sessionId',
      'role',
      'workspace',
      'prompt',
      'status',
      'result',
      'createdAt',
      'updatedAt',
    ],
    knowledge: ['id', 'title', 'content', 'scope', 'state', 'projectPath'],
  })) {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (columns.some((column) => !existing.includes(column)))
      throw new Error(`备份缺少工作台数据表或必要字段：${table}。`);
  }
  if (
    version === 1 &&
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='records'",
      )
      .get()
  )
    throw new Error('备份缺少版本对应的记录表。');
}

function validateCompanion(filename) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('加密凭据备份不是有效的 JSON 文件。');
  }
  const binary = (name, size) =>
    typeof value[name] === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value[name]) &&
    (size
      ? Buffer.from(value[name], 'base64').length === size
      : Buffer.from(value[name], 'base64').length > 0);
  if (
    value.version !== 1 ||
    value.kdf?.algorithm !== 'argon2id' ||
    value.kdf.memorySize !== 65536 ||
    value.kdf.iterations !== 3 ||
    value.kdf.parallelism !== 1 ||
    value.kdf.hashLength !== 32 ||
    !binary('salt', 16) ||
    !binary('iv', 12) ||
    !binary('tag', 16) ||
    !binary('ciphertext')
  )
    throw new Error('加密凭据备份格式或版本不受支持。');
}

function privateCopy(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
  const fd = fs.openSync(destination, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(dirname) {
  const directory = fs.openSync(dirname, 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
function clearMarker(filename) {
  syncDirectory(path.dirname(filename));
  fs.rmSync(filename, { force: true });
  syncDirectory(path.dirname(filename));
}
function writeMarker(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

export function restoreBackup(
  { backup, dataDir },
  { renameSync = fs.renameSync } = {},
) {
  if (!backup || !dataDir) throw new Error('需要 --backup 和 --data-dir。');
  const source = fs.realpathSync(path.resolve(backup));
  const directory = path.resolve(dataDir);
  if (!source.endsWith('.sqlite') || !fs.statSync(source).isFile())
    throw new Error('请选择 .sqlite 备份文件。');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = path.join(directory, 'workspace.sqlite');
  if (
    source === (fs.existsSync(database) ? fs.realpathSync(database) : database)
  )
    throw new Error('备份不能是当前工作台数据库本身。');
  const unlock = lockControl(directory, { allowRecovery: true });
  const marker = path.join(directory, 'restore.pending.json');
  let previousMarker = null;
  const staging = path.join(directory, `.restore-${randomUUID()}`);
  const vaultFile = path.join(directory, 'vault.json');
  const companion = `${source}.vault.json`;
  let sourceDb,
    currentDb,
    before = null,
    vaultBackup = null;
  let originalDatabaseMoved = false,
    restoredDatabase = false,
    originalVaultMoved = false,
    restoredVault = false,
    keepStaging = false,
    markerWritten = false;
  try {
    previousMarker = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
    sourceDb = new DatabaseSync(source, { readOnly: true });
    validateDatabase(sourceDb);
    const restoreVault = fs.existsSync(companion);
    if (restoreVault) validateCompanion(companion);
    fs.mkdirSync(staging, { mode: 0o700 });
    const candidate = backupDatabase(
      sourceDb,
      staging,
      'validated-source',
    ).path;
    sourceDb.close();
    sourceDb = null;
    if (restoreVault)
      privateCopy(companion, path.join(staging, 'candidate.vault.json'));
    if (fs.existsSync(database)) {
      currentDb = new DatabaseSync(database);
      const checkpoint = currentDb
        .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
        .get();
      if (checkpoint.busy)
        throw new Error(
          '数据库仍被其他进程占用，请停止所有使用此数据目录的进程。',
        );
      before = backupDatabase(currentDb, directory, 'before-restore');
      currentDb.exec('BEGIN EXCLUSIVE; COMMIT');
      currentDb.close();
      currentDb = null;
    }
    if (fs.existsSync(vaultFile)) {
      const backupDir = path.join(directory, 'backups');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      vaultBackup = before
        ? `${before.path}.vault.json`
        : path.join(
            backupDir,
            `${Date.now()}-before-restore-${randomUUID()}.vault.json`,
          );
      privateCopy(vaultFile, vaultBackup);
    }
    writeMarker(
      marker,
      JSON.stringify({
        version: 1,
        source,
        sourceVault: restoreVault ? companion : null,
        beforeBackup: before?.path ?? null,
        vaultBackup,
        staging,
        startedAt: new Date().toISOString(),
        previousRecovery: previousMarker
          ? previousMarker.toString('utf8')
          : null,
      }),
    );
    markerWritten = true;
    // The controller lock is held and checkpoint completed before stale sidecars
    // are removed. Each file swap can be rolled back, but two renames are not a
    // single crash-atomic transaction; the before-restore backup remains durable.
    for (const suffix of ['-wal', '-shm'])
      fs.rmSync(`${database}${suffix}`, { force: true });
    if (fs.existsSync(database)) {
      renameSync(database, path.join(staging, 'previous.sqlite'));
      originalDatabaseMoved = true;
    }
    renameSync(candidate, database);
    restoredDatabase = true;
    fs.chmodSync(database, 0o600);
    if (restoreVault) {
      if (fs.existsSync(vaultFile)) {
        renameSync(vaultFile, path.join(staging, 'previous.vault.json'));
        originalVaultMoved = true;
      }
      renameSync(path.join(staging, 'candidate.vault.json'), vaultFile);
      restoredVault = true;
    }
    clearMarker(marker);
    return {
      database,
      beforeBackup: before?.path ?? null,
      vaultBackup,
      vaultRestored: restoreVault,
      note: restoreVault
        ? '已恢复加密凭据备份，启动后使用该备份对应的口令解锁。'
        : '此备份不含凭据文件；现有凭据库已保留。数据库中的凭据引用可能需要重新关联。',
    };
  } catch (error) {
    const failures = [];
    try {
      if (restoredVault) fs.rmSync(vaultFile, { force: true });
      if (originalVaultMoved)
        renameSync(path.join(staging, 'previous.vault.json'), vaultFile);
    } catch (failure) {
      failures.push(failure.message);
    }
    try {
      if (restoredDatabase) fs.rmSync(database, { force: true });
      if (originalDatabaseMoved)
        renameSync(path.join(staging, 'previous.sqlite'), database);
    } catch (failure) {
      failures.push(failure.message);
    }
    if (failures.length) {
      keepStaging = true;
      throw new Error(
        `恢复失败且自动回滚未完成。请保留 ${staging} 并使用 before-restore 备份恢复。`,
      );
    }
    if (markerWritten) {
      if (previousMarker) writeMarker(marker, previousMarker);
      else clearMarker(marker);
    }
    throw error;
  } finally {
    try {
      sourceDb?.close();
      currentDb?.close();
      if (!keepStaging) fs.rmSync(staging, { recursive: true, force: true });
    } finally {
      unlock();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (
        !['--backup', '--data-dir'].includes(args[index]) ||
        !args[index + 1] ||
        args[index + 1].startsWith('--')
      )
        throw new Error(
          '用法：node scripts/restore.mjs --backup <备份.sqlite> --data-dir <数据目录>',
        );
      options[args[index] === '--backup' ? 'backup' : 'dataDir'] =
        args[index + 1];
    }
    const result = restoreBackup(options);
    console.log(`恢复完成：${result.database}\n${result.note}`);
    if (result.beforeBackup) console.log(`恢复前备份：${result.beforeBackup}`);
    console.log(
      '下一步：使用相同 WORKBENCH_DATA_DIR 启动工作台（npm start 或对应 systemd 服务），然后检查任务、助手和凭据连接。',
    );
  } catch (error) {
    console.error(`恢复失败：${error.message}`);
    process.exitCode = 1;
  }
}
