import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

void test('recruitment rejects descriptive model names without overwriting drafts and rechecks changed providers at confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-model-contract-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const runs = [];
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace,
    requireCredential: false,
    runtimeFactory: (options) => ({
      start() {
        runs.push(options);
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  try {
    await app.platform.ready;
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const provider = app.platform.providers.save({
      name: 'Fixture',
      protocol: 'openai-completions',
      baseUrl: 'https://fixture.invalid/v1',
      models: [{ id: 'exact-model', tools: true }],
      enabled: true,
    });
    for (const role of app.store.roles())
      app.store.saveRole(
        { ...role, model: 'exact-model', providerIds: [provider.id] },
        role.id,
      );
    const team = app.store.saveTeamSpace({
      name: '招募',
      goal: '测试可执行模型配置',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'discovery' },
    });
    // Use the real recruitment guard through an active manager execution.
    const sent = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/teams/${team.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '设计团队',
          clientMessageId: 'model-contract',
        }),
      },
    );
    assert.equal(sent.status, 201);
    const deadline = Date.now() + 3000;
    while (!runs.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      runs.length,
      1,
      JSON.stringify(
        app.store.tasks().map(({ status, error }) => ({ status, error })),
      ),
    );
    const patch = runs[0].capabilityPatch.find(
      (item) => item.id === 'workbench-orchestration',
    );
    const principal = app.platform.control.validateInstanceToken(
      patch.config.headers.Authorization.replace(/^Bearer\s+/i, ''),
    );
    const draft = {
      teamName: '家庭账本开发团队',
      goal: '交付账本',
      purpose: '实现导入汇总',
      members: [
        {
          roleId: 'developer',
          memberId: 'dev',
          responsibility: '交付实现和测试',
          providerIds: [provider.id],
          modelHint: 'exact-model',
        },
      ],
    };
    app.platform.control.proposeTeam(draft, principal);
    const saved = app.store.teamSpace(team.id).recruitment.proposal;
    for (const modelHint of [
      '沿用当前已配置的 GPT 5.6',
      'Exact Model',
      'missing',
    ]) {
      assert.throws(
        () =>
          app.platform.control.proposeTeam(
            { ...draft, members: [{ ...draft.members[0], modelHint }] },
            principal,
          ),
        /精确 model.id/,
      );
      assert.deepEqual(
        app.store.teamSpace(team.id).recruitment.proposal,
        saved,
      );
    }
    app.platform.control.proposeTeam(
      { ...draft, members: [{ ...draft.members[0], modelHint: '' }] },
      principal,
    );
    assert.equal(
      app.store.teamSpace(team.id).recruitment.proposal.members[1].modelHint,
      '',
    );
    app.platform.control.proposeTeam(draft, principal);
    app.store.records.save(
      'providers',
      { ...provider, models: [{ id: 'replacement', tools: true }] },
      provider.id,
    );
    assert.throws(
      () => app.platform.control.confirmTeamRecruitment(team.id),
      /模型未在可用供应商中配置/,
    );
    assert.equal(app.store.teamSpace(team.id).recruitment.phase, 'proposed');
    app.store.records.save('providers', provider, provider.id);
    const confirmed = app.platform.control.confirmTeamRecruitment(team.id);
    const dev = confirmed.recruitment.proposal.members.find(
      (member) => member.memberId === 'dev',
    );
    assert.equal(app.store.role(dev.agentId).model, 'exact-model');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
