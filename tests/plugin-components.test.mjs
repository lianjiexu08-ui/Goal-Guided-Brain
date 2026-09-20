import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { CapabilityService, inspectBundle } from '../server/capabilities.mjs';

function fixture(t, format = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-components-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const store = new Store(path.join(dir, 'data'), source);
  const service = new CapabilityService({ store, vault: { get: () => 'fixture-secret' }, dataDir: path.join(dir, 'data') });
  const write = (relative, data) => {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  write(format === 'portable' ? 'plugin.json' : `.${format}-plugin/plugin.json`, JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, source, store, service, write };
}

test('Claude commands expand quoted arguments once and preserve original permission boundaries', async t => {
  const f = fixture(t);
  f.write('commands/review.md', '---\ndescription: Review a change\nargument-hint: "[subject] [format]"\nallowed-tools: Bash(git *)\n---\nReview $0 as $ARGUMENTS[1]. Full: $ARGUMENTS. Literal: \\$1.');
  const installed = await f.service.install({ path: f.source });
  f.service.action(installed.id, 'enable');
  const command = f.service.components(installed.id).commands[0];
  const input = f.service.commandTask(installed.id, command.id, { role: 'assistant', arguments: '"hello world" "$ARGUMENTS"' });
  assert.match(input.prompt, /Review hello world as \$ARGUMENTS/);
  assert.match(input.prompt, /Full: "hello world" "\$ARGUMENTS"/);
  assert.match(input.prompt, /Literal: \$1/);
  assert.equal(input.assistantSnapshot.tools.terminal, false);
  assert.ok(input.assistantSnapshot.capabilityIds.includes(installed.id));
  assert.equal(input.capabilityCommand.digest, installed.digest);
  assert.throws(() => f.service.commandTask(installed.id, command.id, { arguments: 'one | two' }), /操作符/);
});

test('host shell preprocessing and fork commands are identified without executing them', async t => {
  const f = fixture(t);
  f.write('commands/shell.md', '---\ndescription: Dynamic context\n---\n!`touch /tmp/never-run-this`\nSummarize.');
  f.write('commands/fork.md', '---\ndescription: Review\ncontext: fork\n---\nReview the changes.');
  const installed = await f.service.install({ path: f.source });
  f.service.action(installed.id, 'enable');
  for (const command of f.service.components(installed.id).commands) {
    assert.equal(command.runnable, false);
    assert.throws(() => f.service.commandTask(installed.id, command.id, {}), /尚未适配/);
  }
});

test('agent template imports are idempotent and preserve model and tool hints without implicit privilege', async t => {
  const f = fixture(t);
  f.write('agents/reviewer.md', '---\nname: reviewer\ndescription: Review source\nmodel: sonnet\ntools: Read, Grep, Bash\ndisallowedTools: Write\nisolation: worktree\n---\nReview carefully and cite evidence.');
  const installed = await f.service.install({ path: f.source });
  const template = f.service.components(installed.id).agents[0];
  assert.equal(template.modelHint, 'sonnet');
  const role = f.service.importAgent(installed.id, template.id);
  assert.equal(role.tools.terminal, false);
  assert.equal(role.model, '');
  assert.equal(role.workspaceMode, 'isolated');
  assert.match(role.instructions, /Review carefully/);
  f.store.saveRole({ name: 'My customized reviewer' }, role.id);
  assert.equal(f.service.importAgent(installed.id, template.id).name, 'My customized reviewer');
  assert.equal(f.store.records.list('capability-imports').length, 1);
});

test('portable OpenAI plugin discovers MCP and commands are explicitly workbench imports', async t => {
  const f = fixture(t, 'portable');
  f.write('mcp.json', JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    docs: { type: 'streamable-http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  } }));
  f.write('commands/explain.md', 'Explain $ARGUMENTS');
  const installed = await f.service.install({ path: f.source });
  assert.equal(installed.format, 'codex');
  assert.ok(installed.diagnostics.some(message => /不代表 Codex/.test(message)));
  const entry = f.service.components(installed.id).mcp[0];
  const connection = f.service.importMcp(installed.id, entry.id);
  assert.equal(connection.enabled, false);
  assert.equal(connection.configurationRequired, true);
  assert.throws(() => f.service.action(connection.id, 'enable'), /凭据/);
  f.service.save({ credentialId: 'docs-key' }, connection.id);
  assert.equal(f.service.action(connection.id, 'enable').enabled, true);
  assert.equal(f.service.importMcp(installed.id, entry.id).id, connection.id);
});

test('plugin MCP imports resolve plugin root and preserve only independently configured credential references', async t => {
  const f = fixture(t, 'codex');
  f.write('.mcp.json', JSON.stringify({ mcpServers: { database: {
    command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'], env: { DATABASE_PASSWORD: '${DATABASE_PASSWORD}' },
  } } }));
  f.write('server.mjs', 'export {};\n');
  const installed = await f.service.install({ path: f.source });
  const entry = f.service.components(installed.id).mcp[0];
  const connection = f.service.importMcp(installed.id, entry.id, { envRefs: { DATABASE_PASSWORD: 'db-password-ref' } });
  assert.equal(connection.enabled, false);
  assert.deepEqual(connection.envRefs, { DATABASE_PASSWORD: 'db-password-ref' });
  assert.equal(connection.args[0], path.join(installed.path, 'server.mjs'));
  assert.equal(connection.configurationRequired, false);
  assert.equal(JSON.stringify(f.service.list()).includes('fixture-secret'), false);
});

test('inline MCP credentials are rejected before any installed bundle is persisted', async t => {
  const f = fixture(t);
  for (const server of [
    { command: 'node', env: { TOKEN: 'private-inline-value' } },
    { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private-inline-value' } },
    { command: 'node', args: ['--token', 'private-inline-value'] },
    { command: 'node', env: { TOKEN: '${TOKEN:-private-inline-value}' } },
    { url: 'https://example.test/mcp?token=private-inline-value' },
  ]) {
    f.write('.mcp.json', JSON.stringify({ mcpServers: { secret: server } }));
    await assert.rejects(f.service.install({ path: f.source }), /内联|凭据/);
    assert.equal(f.store.records.list('capabilities').length, 0);
  }
});

test('custom manifest component paths cannot escape a pinned bundle', async t => {
  const f = fixture(t);
  f.write('.claude-plugin/plugin.json', JSON.stringify({ name: 'fixture', commands: ['../../outside.md'] }));
  assert.throws(() => inspectBundle(f.source), /越界/);
});

test('explicit unsupported portable hooks never fall back to a different default hook file', t => {
  const f = fixture(t, 'portable');
  f.write('plugin.json', JSON.stringify({ name: 'fixture', extensions: { 'com.openai': { hooks: ['./hooks/one.json', './hooks/two.json'] } } }));
  f.write('hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo default' }] }] } }));
  const inspected = inspectBundle(f.source);
  assert.equal(inspected.hooksPath, null);
  assert.ok(inspected.diagnostics.some(message => /不加载默认 Hook/.test(message)));
});
