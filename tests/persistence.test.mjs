import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, ROLES } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { migrate, backupDatabase } from '../server/migrations.mjs';
import { lockControl } from '../server/persistence.mjs';
import { restoreBackup } from '../scripts/restore.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persistence-'));
  const dataDir = path.join(dir, 'data');
  const store = new Store(dataDir, dir);
  return {
    dir,
    dataDir,
    store,
    close() {
      try {
        store.close();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('old schema migration makes a consistent backup and preserves user records', () => {
  const f = fixture();
  try {
    const task = f.store.createTask({
      role: 'developer',
      prompt: 'Preserve this task',
    });
    f.store.db.exec('DROP TABLE records; PRAGMA user_version=0');
    migrate(f.store.db, f.dataDir);
    assert.equal(f.store.task(task.id).prompt, 'Preserve this task');
    assert.equal(
      f.store.db.prepare('PRAGMA user_version').get().user_version,
      1,
    );
    const backup = fs
      .readdirSync(path.join(f.dataDir, 'backups'))
      .find((name) => name.includes('before-v1'));
    assert.ok(backup);
    const db = new DatabaseSync(path.join(f.dataDir, 'backups', backup), {
      readOnly: true,
    });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
      assert.equal(
        db.prepare('SELECT prompt FROM tasks WHERE id=?').get(task.id).prompt,
        'Preserve this task',
      );
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test('control lock refuses duplicate owners and pending restores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-'));
  try {
    const release = lockControl(dir);
    assert.throws(() => lockControl(dir), /已有控制端/);
    release();
    fs.writeFileSync(path.join(dir, 'restore.pending.json'), '{}');
    assert.throws(() => lockControl(dir), /恢复/);
    const recovery = lockControl(dir, { allowRecovery: true });
    recovery();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restore preserves legacy vault without companion and backs up current database', async () => {
  const f = fixture();
  const vault = new Vault(f.dataDir);
  try {
    const earlier = f.store.createTask({
      role: 'developer',
      prompt: 'Earlier task',
    });
    const assistant = f.store.saveRole({
      ...ROLES.product,
      name: 'Preserved assistant',
    });
    f.store.archiveRole(assistant.id, true);
    const knowledge = f.store.saveKnowledge({
      title: 'Project decision',
      content: 'Preserved decision',
      scope: 'project',
      state: 'confirmed',
      source: 'fixture',
    });
    const backup = backupDatabase(f.store.db, f.dataDir, 'restore-fixture');
    const later = f.store.createTask({
      role: 'assistant',
      prompt: 'Later task',
    });
    f.store.saveRole({ name: 'Later assistant name' }, assistant.id);
    f.store.saveKnowledge(
      { ...knowledge, content: 'Later decision' },
      knowledge.id,
    );
    await vault.initialize('fixture-passphrase');
    const secret = await vault.put({
      name: 'Preserved',
      value: 'do-not-print-this-secret',
    });
    const ciphertext = fs.readFileSync(vault.file);
    f.store.close();
    const result = restoreBackup({ backup: backup.path, dataDir: f.dataDir });
    assert.equal(result.vaultRestored, false);
    assert.match(result.note, /已保留/);
    assert.deepEqual(fs.readFileSync(vault.file), ciphertext);
    assert.equal(vault.get(secret.id), 'do-not-print-this-secret');
    const restored = new Store(f.dataDir, f.dir);
    try {
      assert.ok(restored.task(earlier.id));
      assert.equal(restored.task(later.id), null);
      assert.equal(restored.role(assistant.id).name, 'Preserved assistant');
      assert.equal(restored.role(assistant.id).archived, true);
      assert.equal(
        restored.knowledge().find((item) => item.id === knowledge.id).content,
        'Preserved decision',
      );
      assert.equal(restored.sessions().length, 1);
    } finally {
      restored.close();
    }
    const previous = new DatabaseSync(result.beforeBackup, { readOnly: true });
    try {
      assert.ok(
        previous.prepare('SELECT id FROM tasks WHERE id=?').get(later.id),
      );
    } finally {
      previous.close();
    }
    assert.ok(fs.existsSync(`${result.beforeBackup}.vault.json`));
    assert.equal(
      fs.existsSync(path.join(f.dataDir, 'restore.pending.json')),
      false,
    );
  } finally {
    vault.lock();
    f.close();
  }
});

test('restore rejects live control, invalid databases and malformed vault before replacement', () => {
  const f = fixture();
  try {
    const backup = backupDatabase(f.store.db, f.dataDir, 'valid');
    f.store.close();
    const original = fs.readFileSync(path.join(f.dataDir, 'workspace.sqlite'));
    const release = lockControl(f.dataDir);
    assert.throws(
      () => restoreBackup({ backup: backup.path, dataDir: f.dataDir }),
      /已有控制端/,
    );
    release();
    const bad = path.join(f.dir, 'bad.sqlite');
    fs.writeFileSync(bad, 'not a database');
    assert.throws(() => restoreBackup({ backup: bad, dataDir: f.dataDir }));
    const unrelated = path.join(f.dir, 'unrelated.sqlite');
    const db = new DatabaseSync(unrelated);
    db.exec('CREATE TABLE unrelated(id)');
    db.close();
    assert.throws(
      () => restoreBackup({ backup: unrelated, dataDir: f.dataDir }),
      /必要字段/,
    );
    fs.writeFileSync(
      `${backup.path}.vault.json`,
      '{"value":"plaintext-not-valid"}',
    );
    assert.throws(
      () => restoreBackup({ backup: backup.path, dataDir: f.dataDir }),
      /加密凭据/,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(f.dataDir, 'workspace.sqlite')),
      original,
    );
    assert.equal(fs.existsSync(path.join(f.dataDir, 'control.lock')), false);
  } finally {
    f.close();
  }
});

test('encrypted companion restores and failed replacement rolls both files back', async () => {
  const f = fixture();
  const vault = new Vault(f.dataDir);
  try {
    const task = f.store.createTask({
      role: 'developer',
      prompt: 'Backup task',
    });
    const backup = backupDatabase(f.store.db, f.dataDir, 'with-vault');
    await vault.initialize('fixture-passphrase');
    const secret = await vault.put({
      name: 'Version one',
      value: 'version-one-secret',
    });
    fs.copyFileSync(vault.file, `${backup.path}.vault.json`);
    await vault.put(
      { name: 'Version two', value: 'version-two-secret' },
      secret.id,
    );
    const originalVault = fs.readFileSync(vault.file);
    f.store.updateTask(task.id, { result: 'Current result' });
    f.store.close();
    vault.lock();
    let fail = true;
    assert.throws(
      () =>
        restoreBackup(
          { backup: backup.path, dataDir: f.dataDir },
          {
            renameSync(source, destination) {
              if (fail && source.endsWith('candidate.vault.json')) {
                fail = false;
                throw new Error('Fixture replacement failure');
              }
              fs.renameSync(source, destination);
            },
          },
        ),
      /Fixture replacement failure/,
    );
    assert.deepEqual(fs.readFileSync(vault.file), originalVault);
    const current = new DatabaseSync(path.join(f.dataDir, 'workspace.sqlite'), {
      readOnly: true,
    });
    try {
      assert.equal(
        current.prepare('SELECT result FROM tasks WHERE id=?').get(task.id)
          .result,
        'Current result',
      );
    } finally {
      current.close();
    }
    assert.equal(
      fs.existsSync(path.join(f.dataDir, 'restore.pending.json')),
      false,
    );
    fs.writeFileSync(
      path.join(f.dataDir, 'restore.pending.json'),
      JSON.stringify({ source: backup.path }),
    );
    const result = restoreBackup({ backup: backup.path, dataDir: f.dataDir });
    assert.equal(result.vaultRestored, true);
    await vault.unlock('fixture-passphrase');
    assert.equal(vault.get(secret.id), 'version-one-secret');
    assert.equal(
      fs.existsSync(path.join(f.dataDir, 'restore.pending.json')),
      false,
    );
    assert.ok(!JSON.stringify(result).includes('version-one-secret'));
  } finally {
    vault.lock();
    f.close();
  }
});
