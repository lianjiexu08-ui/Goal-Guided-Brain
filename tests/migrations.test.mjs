import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../server/migrations.mjs';

for (const failing of [false, true])
  test(`legacy WAL data survives ${failing ? 'failed' : 'successful'} migration with a consistent backup`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migration-'));
    const db = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    t.after(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE tasks(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE roles(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE knowledge(id TEXT PRIMARY KEY, content TEXT);',
    );
    db.prepare('INSERT INTO tasks VALUES(?,?)').run(
      'historic-task',
      'Original result',
    );
    db.prepare('INSERT INTO roles VALUES(?,?)').run(
      'custom-agent',
      JSON.stringify({ archived: true, instructions: 'Owner instructions' }),
    );
    db.prepare('INSERT INTO knowledge VALUES(?,?)').run(
      'memory',
      'Saved address',
    );
    if (failing) db.exec('CREATE TABLE records(collection TEXT)');
    if (failing) assert.throws(() => migrate(db, dir), /column|schema/);
    else migrate(db, dir);
    assert.equal(
      db.prepare('PRAGMA user_version').get().user_version,
      failing ? 0 : 1,
    );
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(dir, 'backups', backups[0]), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare('PRAGMA integrity_check').get().integrity_check,
        'ok',
      );
      for (const table of ['tasks', 'roles', 'knowledge'])
        assert.deepEqual(
          db.prepare(`SELECT * FROM ${table}`).all(),
          backup.prepare(`SELECT * FROM ${table}`).all(),
        );
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 0);
    } finally {
      backup.close();
    }
  });
