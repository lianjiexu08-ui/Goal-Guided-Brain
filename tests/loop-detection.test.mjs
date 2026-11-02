import test from 'node:test';
import assert from 'node:assert/strict';
import { loopDetected, toolCallSignature } from '../server/platform.mjs';

// The loop circuit breaker paused a task after the same tool call repeated
// LOOP_WINDOW times. It read the window from the tail of a newest-first list,
// so it compared the current call against the *oldest* events of the task and
// effectively never fired. These tests pin the ordering contract.

const call = (name, args) => ({ data: { name, arguments: args } });

test('toolCallSignature is stable across the accepted argument field names', () => {
  const a = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const b = toolCallSignature({ tool: 'read', args: { path: 'x' } });
  const c = toolCallSignature({ toolName: 'read', input: { path: 'x' } });
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('toolCallSignature separates different tools and different arguments', () => {
  const base = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  assert.notEqual(base, toolCallSignature({ name: 'write', arguments: { path: 'x' } }));
  assert.notEqual(base, toolCallSignature({ name: 'read', arguments: { path: 'y' } }));
});

test('toolCallSignature returns null when the call has no tool name', () => {
  assert.equal(toolCallSignature({}), null);
  assert.equal(toolCallSignature(null), null);
  assert.equal(toolCallSignature({ arguments: { a: 1 } }), null);
});

test('loopDetected fires on the newest window of identical calls', () => {
  // Newest first, as records.listByTask returns them.
  const signature = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const recent = [
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
  ];
  assert.equal(loopDetected(recent, signature, 4), true);
});

test('loopDetected takes the head of a newest-first list, not the tail', () => {
  // The regression this guards: with the bug, a list whose *oldest* entries
  // were identical and whose newest differ still tripped, and a genuine run of
  // four identical recent calls did not.
  const signature = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const genuineLoop = [
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('search', { q: 'older' }),
    call('search', { q: 'older' }),
    call('search', { q: 'older' }),
    call('search', { q: 'older' }),
  ];
  assert.equal(loopDetected(genuineLoop, signature, 4), true);

  const notALoop = [
    call('search', { q: 'a' }),
    call('search', { q: 'b' }),
    call('search', { q: 'c' }),
    call('search', { q: 'd' }),
  ];
  assert.equal(loopDetected(notALoop, signature, 4), false);
});

test('loopDetected needs a full window before tripping', () => {
  const signature = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const three = [call('read', { path: 'x' }), call('read', { path: 'x' }), call('read', { path: 'x' })];
  assert.equal(loopDetected(three, signature, 4), false);
  assert.equal(loopDetected(three, signature, 3), true);
});

test('loopDetected ignores a missing signature', () => {
  const recent = [call('read', { path: 'x' }), call('read', { path: 'x' })];
  assert.equal(loopDetected(recent, null, 2), false);
});

test('one different call inside the window keeps the task running', () => {
  const signature = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const recent = [
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    call('read', { path: 'y' }),
    call('read', { path: 'x' }),
  ];
  assert.equal(loopDetected(recent, signature, 4), false);
});

test('a nameless call inside the window does not count as a match', () => {
  const signature = toolCallSignature({ name: 'read', arguments: { path: 'x' } });
  const recent = [
    call('read', { path: 'x' }),
    call('read', { path: 'x' }),
    { data: { arguments: {} } },
    call('read', { path: 'x' }),
  ];
  assert.equal(loopDetected(recent, signature, 4), false);
});
