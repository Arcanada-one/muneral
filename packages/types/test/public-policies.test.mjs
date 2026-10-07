import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRole, isValidTransition, TASK_STATUSES } from '../dist/index.js';

test('a viewer cannot satisfy any editing or administrative role', () => {
  assert.equal(hasRole('viewer', 'viewer'), true);
  for (const required of /** @type {const} */ (['developer', 'manager', 'owner'])) {
    assert.equal(hasRole('viewer', required), false, required);
  }
});

test('a developer retains reading rights without gaining management rights', () => {
  assert.equal(hasRole('developer', 'viewer'), true);
  assert.equal(hasRole('developer', 'developer'), true);
  assert.equal(hasRole('developer', 'manager'), false);
  assert.equal(hasRole('developer', 'owner'), false);
});

test('a manager cannot act as the workspace owner', () => {
  assert.equal(hasRole('manager', 'developer'), true);
  assert.equal(hasRole('manager', 'manager'), true);
  assert.equal(hasRole('manager', 'owner'), false);
});

test('the legitimate workspace owner satisfies all declared role requirements', () => {
  for (const required of /** @type {const} */ (['viewer', 'developer', 'manager', 'owner'])) {
    assert.equal(hasRole('owner', required), true, required);
  }
});

// Exercise invalid JavaScript caller inputs without weakening the declared
// role/status types or changing the exported runtime policy implementation.
test('an unknown role never grants or defines authority', () => {
  for (const unknown of ['', 'administrator', 'constructor', undefined, null]) {
    assert.equal(Reflect.apply(hasRole, undefined, [unknown, 'viewer']), false);
    assert.equal(Reflect.apply(hasRole, undefined, ['owner', unknown]), false);
  }
});

test('completion requires review rather than a direct transition from live work', () => {
  assert.equal(isValidTransition('review', 'done'), true);
  for (const from of /** @type {const} */ (['todo', 'in_progress', 'blocked'])) {
    assert.equal(isValidTransition(from, 'done'), false, from);
  }
});

test('only settled done or cancelled cards can enter the archive', () => {
  assert.equal(isValidTransition('done', 'archived'), true);
  assert.equal(isValidTransition('cancelled', 'archived'), true);
  for (const from of TASK_STATUSES.filter(value => value !== 'done' && value !== 'cancelled')) {
    assert.equal(isValidTransition(from, 'archived'), false, from);
  }
});

test('restoring an archived card does not inherit a completion claim', () => {
  assert.equal(isValidTransition('archived', 'todo'), true);
  for (const to of TASK_STATUSES.filter(value => value !== 'todo')) {
    assert.equal(isValidTransition('archived', to), false, to);
  }
});

test('unsupported status values do not authorize a transition', () => {
  assert.equal(Reflect.apply(isValidTransition, undefined, ['not-a-task-status', 'done']), false);
  assert.equal(Reflect.apply(isValidTransition, undefined, ['review', 'not-a-task-status']), false);
});

test('the public status list exposes archival without duplicates or a verified alias', () => {
  assert.equal(TASK_STATUSES.includes('archived'), true);
  assert.equal(Reflect.apply(TASK_STATUSES.includes, TASK_STATUSES, ['verified']), false);
  assert.equal(new Set(TASK_STATUSES).size, TASK_STATUSES.length);
});
