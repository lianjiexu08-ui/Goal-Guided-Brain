import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-mcp-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
};

test('team MCP can discover and delegate to an allowed long-lived team', async () => {
  const fixture = sandbox();
  const runs = [];
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
    runtimeFactory: (options) => ({
      options,
      start(prompt) {
        this.prompt = prompt;
        runs.push(this);
      },
      cancel() {
        options.onDone('cancelled', '');
      },
      complete(result = '目标团队已完成协作') {
        options.onResult(result);
        options.onDone('completed', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const clients = [];
  try {
    const source = (await request('teams')).body[0];
    const target = (
      await request(
        'teams',
        {
          name: '资料团队',
          goal: '整理资料并输出证据摘要。',
          memberRoleIds: ['project_manager', 'assistant'],
          model: 'team-default-model',
          memberSettings: {
            project_manager: { modelHint: 'pm-routing-model' },
          },
        },
        'POST',
      )
    ).body;
    const pending = (
      await request(
        'teams',
        {
          name: '待招募资料团队',
          goal: '尚未确认成员的资料团队。',
          memberRoleIds: ['project_manager', 'assistant'],
          recruitment: { phase: 'discovery' },
        },
        'POST',
      )
    ).body;
    await request(
      `teams/${source.id}`,
      { collaboration: { allowedTeamIds: [target.id, pending.id] } },
      'PUT',
    );
    await request(
      `teams/${source.id}/messages`,
      { clientMessageId: 'mcp-source', content: '准备一次跨团队资料协作。' },
      'POST',
    );
    await waitFor(
      () => runs.length === 1,
      '团队消息对应的项目经理任务没有在测试窗口内启动。',
    );
    const patch = runs[0].options.capabilityPatch.find(
      (item) => item.id === 'workbench-orchestration',
    );
    const client = new Client({ name: 'team-mcp-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(patch.config.url), {
        requestInit: { headers: patch.config.headers },
      }),
    );
    const listed = JSON.parse(
      (await client.callTool({ name: 'list_teams', arguments: {} })).content[0]
        .text,
    );
    assert.equal(listed.items.length, 1);
    assert.equal(
      listed.items.find((item) => item.id === target.id).memberCount,
      2,
    );
    assert.equal(
      listed.items.find((item) => item.id === pending.id),
      undefined,
    );
    const delegated = JSON.parse(
      (
        await client.callTool({
          name: 'delegate_to_team',
          arguments: {
            teamId: target.id,
            prompt: '整理资料并提交来源清单。',
            acceptance: '输出带来源的摘要。',
            idempotencyKey: 'mcp-handoff-1',
          },
        })
      ).content[0].text,
    );
    assert.equal(delegated.sourceTeamId, source.id);
    assert.equal(delegated.targetTeamId, target.id);
    assert.ok(delegated.taskId);
    assert.ok(delegated.sourceMessageId);
    assert.equal(
      app.platform.control.records.get('task-meta', delegated.taskId)
        .modelOverride,
      'pm-routing-model',
    );
    const sourceHandoff = app.store
      .teamMessages(source.id)
      .find(
        (message) =>
          message.kind === 'handoff' &&
          message.toTeamId === target.id &&
          message.taskId === delegated.taskId,
      );
    assert.equal(sourceHandoff.id, delegated.sourceMessageId);
    assert.equal(sourceHandoff.relatedMessageId, delegated.messageId);
    await waitFor(() => runs.length === 2, '目标团队执行实例未启动。');
    const duplicate = JSON.parse(
      (
        await client.callTool({
          name: 'delegate_to_team',
          arguments: {
            teamId: target.id,
            prompt: '整理资料并提交来源清单。',
            idempotencyKey: 'mcp-handoff-1',
          },
        })
      ).content[0].text,
    );
    assert.equal(duplicate.duplicate, true);

    runs[1].complete('资料团队已整理来源清单并提交摘要。');
    await tick();
    const sourceReply = app.store
      .teamMessages(source.id)
      .find(
        (message) =>
          message.kind === 'reply' && message.taskId === delegated.taskId,
      );
    assert.ok(sourceReply);
    assert.equal(sourceReply.senderType, 'team');
    assert.equal(sourceReply.fromTeamId, target.id);
    assert.equal(sourceReply.relatedMessageId, sourceHandoff.id);
    assert.match(sourceReply.content, /已整理来源清单/);
    assert.equal(
      app.store.records.get('space-messages', sourceHandoff.id).status,
      'answered',
    );
    const read = JSON.parse(
      (
        await client.callTool({
          name: 'read_team_task',
          arguments: { taskId: delegated.taskId },
        })
      ).content[0].text,
    );
    assert.equal(read.delivery.deliveryStatus, 'pending-review');
    assert.equal(read.delivery.acceptanceDecision, null);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
