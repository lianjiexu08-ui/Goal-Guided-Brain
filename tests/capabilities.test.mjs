import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import {
  CapabilityService,
  inspectBundle,
  fetchLimited,
} from '../server/capabilities.mjs';

const skill = (version) =>
  `---\nname: fixture-skill\ndescription: Local capability fixture.\n---\n\nVERSION_${version}\n`;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capabilities-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const records = new Records(db);
  const credentials = new Map([
    ['fixture-credential', 'fixture-capability-secret'],
  ]);
  const service = new CapabilityService({
    store: { records },
    vault: { get: (id) => credentials.get(id) ?? null },
    dataDir: path.join(dir, 'data'),
  });
  return {
    dir,
    source,
    records,
    service,
    write(relative, content) {
      const target = path.join(source, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('bundle inspection distinguishes unsupported hooks, LSP and OpenClaw dependencies', () => {
  const f = fixture();
  try {
    f.write(
      '.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'fixture-plugin',
        version: '1.0.0',
        lspServers: { fixture: {} },
      }),
    );
    f.write(
      'skills/check/SKILL.md',
      '---\nname: fixture-check\ndescription: Check fixture.\nmetadata:\n  openclaw:\n    requires:\n      bins: [unavailable-fixture]\n---\nCheck.',
    );
    f.write(
      'hooks/hooks.json',
      JSON.stringify({
        hooks: {
          Notification: [
            { hooks: [{ type: 'command', command: 'echo fixture' }] },
          ],
          PreToolUse: [
            { hooks: [{ type: 'prompt', prompt: 'Check the action' }] },
          ],
        },
      }),
    );
    f.write(
      '.mcp.json',
      JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }),
    );
    const result = inspectBundle(f.source);
    assert.equal(result.kind, 'plugin');
    assert.equal(result.format, 'claude');
    assert.equal(result.compatibility, 'partial');
    for (const pattern of [
      /Hook Notification/,
      /Hook PreToolUse/,
      /LSP/,
      /OpenClaw/,
    ])
      assert.ok(result.diagnostics.some((message) => pattern.test(message)));
    assert.deepEqual(result.mcpNames, ['fixture']);
    assert.deepEqual(result.skills[0].dependencies, {
      bins: ['unavailable-fixture'],
    });
  } finally {
    f.close();
  }
});

test('bundle inspection rejects malformed manifests, YAML and hook shapes', () => {
  const f = fixture();
  try {
    f.write('.codex-plugin/plugin.json', '{not-json');
    assert.throws(() => inspectBundle(f.source));
    f.write('.codex-plugin/plugin.json', JSON.stringify({ name: 'fixture' }));
    f.write('SKILL.md', '---\nname: [unterminated\n---\nBody');
    assert.throws(() => inspectBundle(f.source));
    for (const invalid of [
      'Missing frontmatter.',
      '---\nname: Invalid Name\ndescription: Fixture\n---\nBody',
      '---\nname: fixture-skill\n---\nBody',
    ]) {
      f.write('SKILL.md', invalid);
      assert.throws(() => inspectBundle(f.source), /Skill 元数据/);
    }
    f.write('SKILL.md', skill(1));
    for (const hook of [
      { hooks: { PreToolUse: {} } },
      { hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } },
      { hooks: [] },
    ]) {
      f.write('hooks/hooks.json', JSON.stringify(hook));
      assert.throws(() => inspectBundle(f.source), /Hook/);
    }
  } finally {
    f.close();
  }
});

test('local capability install pins exact skill version and rollback, detects tampering', async () => {
  const f = fixture();
  try {
    f.write('SKILL.md', skill(1));
    const first = await f.service.install({ path: f.source });
    assert.equal(first.enabled, false);
    assert.equal(first.skills.length, 1);
    assert.equal(path.basename(first.path), 'package');
    f.write('SKILL.md', skill(2));
    const second = await f.service.install({ path: f.source, id: first.id });
    assert.notEqual(second.digest, first.digest);
    assert.equal(second.history[0].digest, first.digest);
    f.service.action(second.id, 'enable');
    const bound = f.service.patch({ capabilityIds: [second.id] });
    assert.equal(bound.selected[0].digest, second.digest);
    const roots = bound.patches.find((item) => item.id === 'skill-filesystem')
      .config.customSkillDirs;
    const discovered = roots.flatMap((root) =>
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(root, entry.name, 'SKILL.md')),
        )
        .map((entry) =>
          fs.readFileSync(path.join(root, entry.name, 'SKILL.md'), 'utf8'),
        ),
    );
    assert.equal(discovered.length, 1);
    assert.match(discovered[0], /VERSION_2/);
    assert.doesNotMatch(discovered[0], /VERSION_1/);
    const rollback = f.service.action(second.id, 'rollback');
    assert.equal(rollback.digest, first.digest);
    assert.equal(rollback.enabled, false);
    f.service.action(first.id, 'enable');
    fs.appendFileSync(
      path.join(rollback.path, 'SKILL.md'),
      '\nUnexpected change',
    );
    assert.throws(
      () => f.service.patch({ capabilityIds: [first.id] }),
      /发生变化/,
    );
    assert.match(
      fs.readFileSync(path.join(f.source, 'SKILL.md'), 'utf8'),
      /VERSION_2/,
    );
  } finally {
    f.close();
  }
});

test('capability install refuses path traversal, symlinks and inline credentials', async () => {
  const f = fixture();
  try {
    f.write('SKILL.md', skill(1));
    await assert.rejects(
      f.service.install({ path: f.source, id: '../../escaped' }),
      /ID|标识|无效|路径|越界/,
    );
    assert.equal(f.records.list('capabilities').length, 0);
    fs.symlinkSync('/tmp', path.join(f.source, 'outside'));
    assert.throws(() => inspectBundle(f.source), /符号链接/);
    await assert.rejects(f.service.install({ path: f.source }), /符号链接/);
    await assert.rejects(
      f.service.install({
        sourceUrl: 'https://user:secret@example.invalid/repo.git',
      }),
      /凭据|HTTPS/,
    );
    assert.throws(
      () =>
        f.service.save({
          name: 'Invalid auth',
          url: 'https://user:secret@example.invalid/mcp',
        }),
      /凭据/,
    );
  } finally {
    f.close();
  }
});

test('MCP metadata uses credential references and runtime namespaces fit native limits', () => {
  const f = fixture();
  try {
    const mcp = f.service.save({
      name: 'Local fixture',
      kind: 'mcp',
      url: 'http://127.0.0.1:12345/mcp',
      credentialId: 'fixture-credential',
      enabled: true,
    });
    assert.ok(
      !JSON.stringify(f.service.list()).includes('fixture-capability-secret'),
    );
    const runtime = f.service.patch({ capabilityIds: [mcp.id] });
    const config = runtime.patches[0].config;
    assert.match(config.serverName, /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(
      config.headers.Authorization,
      'Bearer fixture-capability-secret',
    );
    f.service.action(mcp.id, 'disable');
    assert.throws(() => f.service.patch({ capabilityIds: [mcp.id] }), /不可用/);
    f.service.save(
      { credentialId: 'missing-credential', enabled: true },
      mcp.id,
    );
    assert.throws(
      () => f.service.patch({ capabilityIds: [mcp.id] }),
      /凭据不存在/,
    );
    assert.throws(
      () =>
        f.service.save({
          name: 'Bad env',
          kind: 'mcp',
          transport: 'stdio',
          command: process.execPath,
          envRefs: { 'INVALID-NAME': 'fixture-credential' },
        }),
      /引用/,
    );
  } finally {
    f.close();
  }
});

test('bounded downloads reject oversized local fixture responses', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(4096));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/package`;
    assert.equal((await fetchLimited(url, {}, 8192)).length, 4096);
    await assert.rejects(fetchLimited(url, {}, 1024), /大小限制/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
