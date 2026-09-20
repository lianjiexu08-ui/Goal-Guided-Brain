import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import { WorkspaceManager, command } from '../server/workspaces.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspaces-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const store = { records: new Records(db) };
  const manager = new WorkspaceManager({
    store,
    dataDir: path.join(dir, 'data'),
  });
  return {
    dir,
    source,
    store,
    manager,
    async close() {
      manager.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function initializeGit(source, commit = true) {
  await command('git', ['init', '--initial-branch=main'], { cwd: source });
  for (const [key, value] of Object.entries({
    'user.name': 'Fixture',
    'user.email': 'fixture@localhost',
    'commit.gpgsign': 'false',
    'core.hooksPath': '/dev/null',
  }))
    await command('git', ['config', key, value], { cwd: source });
  if (commit) {
    fs.writeFileSync(path.join(source, 'base.txt'), 'base\n');
    await command('git', ['add', '--all'], { cwd: source });
    await command('git', ['commit', '-m', 'fixture base'], { cwd: source });
  }
}

test('command preserves raw whitespace and NUL output and rejects overflow', async () => {
  const original = process.env.WORKBENCH_TEST_PUBLISH_TOKEN;
  process.env.WORKBENCH_TEST_PUBLISH_TOKEN = 'sensitive-fixture-token';
  try {
    assert.equal(
      await command(process.execPath, [
        '-e',
        'process.stdout.write(process.env.WORKBENCH_TEST_PUBLISH_TOKEN || "not-inherited")',
      ]),
      'not-inherited',
    );
  } finally {
    if (original === undefined) delete process.env.WORKBENCH_TEST_PUBLISH_TOKEN;
    else process.env.WORKBENCH_TEST_PUBLISH_TOKEN = original;
  }
  assert.equal(
    await command(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.from([0,32,32,97,32,10,0]))',
    ]),
    '\0  a \n\0',
  );
  await assert.rejects(
    command(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(5000))'],
      { maxOutputBytes: 1024 },
    ),
    /截断|限制/,
  );
  await assert.rejects(
    command(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
      timeout: 20,
    }),
    /超时/,
  );
});

test('worktree preserves dirty source, unusual names and complete large diffs', async () => {
  const f = fixture();
  try {
    await initializeGit(f.source);
    fs.writeFileSync(path.join(f.source, 'base.txt'), 'staged\n');
    await command('git', ['add', 'base.txt'], { cwd: f.source });
    const large = Array.from(
      { length: 100000 },
      (_, index) => `Unstaged record ${index}\n`,
    ).join('');
    assert.ok(Buffer.byteLength(large) > 1_000_000);
    fs.writeFileSync(path.join(f.source, 'base.txt'), large);
    fs.writeFileSync(
      path.join(f.source, ' leading name '),
      'untracked exact name\n',
    );
    fs.writeFileSync(path.join(f.source, '.env'), 'TOKEN=do-not-copy');
    fs.writeFileSync(path.join(f.source, '.env.local'), 'TOKEN=do-not-copy');
    fs.symlinkSync(
      path.join(f.source, 'base.txt'),
      path.join(f.source, 'source-link'),
    );
    const before = await command('git', ['status', '--porcelain', '-z'], {
      cwd: f.source,
    });
    const stagedBefore = await command(
      'git',
      ['diff', '--cached', '--binary'],
      { cwd: f.source },
    );
    const row = await f.manager.prepare(
      { id: 'dirty-task', workspace: f.source },
      'isolated',
    );
    assert.equal(row.kind, 'worktree');
    assert.match(row.baseCommit, /^[a-f0-9]{40,64}$/);
    assert.equal(
      fs.readFileSync(path.join(row.path, 'base.txt'), 'utf8'),
      large,
    );
    assert.equal(
      fs.readFileSync(path.join(row.path, ' leading name '), 'utf8'),
      'untracked exact name\n',
    );
    for (const name of ['.env', '.env.local', 'source-link'])
      assert.equal(fs.existsSync(path.join(row.path, name)), false);
    assert.equal(
      await command('git', ['status', '--porcelain', '-z'], { cwd: f.source }),
      before,
    );
    assert.equal(
      await command('git', ['diff', '--cached', '--binary'], { cwd: f.source }),
      stagedBefore,
    );
    assert.match((await f.manager.diff(row.id)).diff, /base.txt/);
  } finally {
    await f.close();
  }
});

test('no-HEAD snapshot excludes secrets and symlinks and refuses explicit worktree', async () => {
  const f = fixture();
  try {
    await initializeGit(f.source, false);
    fs.writeFileSync(path.join(f.source, 'draft.txt'), 'unfinished project');
    fs.writeFileSync(path.join(f.source, '.env.production'), 'TOKEN=secret');
    fs.mkdirSync(path.join(f.source, 'nested'));
    fs.writeFileSync(path.join(f.source, 'nested', '.env'), 'TOKEN=secret');
    fs.symlinkSync('/tmp', path.join(f.source, 'outside'));
    const row = await f.manager.prepare(
      { id: 'snapshot-task', workspace: f.source },
      'isolated',
    );
    assert.equal(row.kind, 'snapshot');
    assert.equal(
      fs.readFileSync(path.join(row.path, 'draft.txt'), 'utf8'),
      'unfinished project',
    );
    for (const name of ['.git', '.env.production', 'nested/.env', 'outside'])
      assert.equal(fs.existsSync(path.join(row.path, name)), false);
    await assert.rejects(
      f.manager.prepare(
        { id: 'forced-worktree', workspace: f.source },
        'worktree',
      ),
      /基准提交/,
    );
    await assert.rejects(
      f.manager.prepare({ id: '../escaped', workspace: f.source }, 'isolated'),
      /实例/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.source, '.env.production'), 'utf8'),
      'TOKEN=secret',
    );
  } finally {
    await f.close();
  }
});

test('integration retains conflicts for review without modifying the source checkout', async () => {
  const f = fixture();
  try {
    await initializeGit(f.source);
    for (const id of ['first', 'second']) {
      const row = await f.manager.prepare(
        { id, workspace: f.source },
        'worktree',
      );
      fs.writeFileSync(path.join(row.path, 'base.txt'), `${id}\n`);
      const artifact = await f.manager.commit(id, `Fixture ${id}`);
      assert.match(artifact.commit, /^[a-f0-9]{40,64}$/);
    }
    const integration = await f.manager.integrate(['first', 'second']);
    assert.equal(integration.state, 'conflict');
    assert.equal(integration.verified, false);
    assert.match(
      await command('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: integration.path,
      }),
      /base.txt/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.source, 'base.txt'), 'utf8'),
      'base\n',
    );
    assert.equal(
      await command('git', ['status', '--porcelain'], { cwd: f.source }),
      '',
    );
  } finally {
    await f.close();
  }
});

test('port reservations are exclusive and restart rejects a conflicting port', async () => {
  const f = fixture();
  let occupant;
  try {
    const row = await f.manager.prepare(
      { id: 'port-task', workspace: f.source },
      'shared',
    );
    const conflict = net.createServer();
    await assert.rejects(
      new Promise((resolve, reject) => {
        conflict.once('error', reject);
        conflict.listen(row.port, '127.0.0.1', resolve);
      }),
      /EADDRINUSE/,
    );
    f.manager.releasePort(row.id);
    await new Promise((resolve) => setImmediate(resolve));
    occupant = net.createServer();
    await new Promise((resolve) =>
      occupant.listen(row.port, '127.0.0.1', resolve),
    );
    await assert.rejects(
      f.manager.prepare({ id: row.id, workspace: f.source }, 'shared'),
      /独占/,
    );
    assert.match(row.portPolicy, /EADDRINUSE/);
  } finally {
    if (occupant?.listening)
      await new Promise((resolve) => occupant.close(resolve));
    await f.close();
  }
});
