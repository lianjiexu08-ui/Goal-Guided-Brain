import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/control-helpers.mjs';

for (const childFinished of [false, true]) {
  void test(`budget recovery resumes parent summary without duplicate delegation (child finished: ${childFinished})`, async (t) => {
    const { control, store, request } = setup(t);
    const parent = control.createJob({ role: 'product', prompt: 'Deliver' });
    const claim = control.claimLocal(store.task(parent.taskId));
    const child = control.createJob(
      { role: 'developer', prompt: 'Implement' },
      control.validateInstanceToken(claim.token),
    );
    control.claimLocal(store.task(child.taskId));
    control.finishLocal(parent.taskId, 1, {
      status: 'completed',
      result: 'Delegated',
    });
    store.records.save(
      'jobs',
      {
        ...store.records.get('jobs', parent.id),
        status: 'budget-exceeded',
        budgetExceeded: true,
      },
      parent.id,
    );
    assert.equal((await request(`jobs/${parent.id}/resume`)).status, 409);
    assert.equal(
      (
        await request(
          `jobs/${parent.id}`,
          { budgetTokens: 300000 },
          undefined,
          'PUT',
        )
      ).status,
      200,
    );
    if (childFinished)
      control.finishLocal(child.taskId, 1, {
        status: 'completed',
        result: 'Code ready',
      });
    const resumed = await request(`jobs/${parent.id}/resume`);
    assert.equal(resumed.status, 200);
    if (!childFinished) {
      assert.equal(resumed.body.status, 'waiting_children');
      assert.equal(store.tasks().length, 2);
      control.finishLocal(child.taskId, 1, {
        status: 'completed',
        result: 'Code ready',
      });
    }
    const summary = store.records.get('jobs', parent.id);
    assert.equal(summary.summaryTaskId, summary.taskId);
    assert.notEqual(summary.taskId, parent.taskId);
    assert.match(store.task(summary.taskId).prompt, /不得再次分派/);
    assert.equal(store.tasks().length, 3);
    assert.equal(store.records.list('jobs').length, 2);
    assert.equal((await request(`jobs/${parent.id}/resume`)).status, 409);
    assert.equal(store.tasks().length, 3);
  });
}
