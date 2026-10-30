import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperation } from '../src/policy/ops.js';
import { fingerprintOperation, canonicalJson } from '../src/policy/fingerprint.js';

test('comment: parses, uppercases and dedupes keys', () => {
  const { op, errors } = buildOperation('jira.issue.comment', { issueKeys: 'demo-1, DEMO-1;DEMO-2', body: ' hi ' });
  assert.deepEqual(errors, []);
  assert.deepEqual(op.targets.map((t) => t.issueKey), ['DEMO-1', 'DEMO-2']);
  assert.equal(op.payload.body, 'hi');
});

test('rejects malformed keys instead of guessing', () => {
  const { op, errors } = buildOperation('jira.issue.comment', { issueKeys: 'DEMO-1, ../etc', body: 'x' });
  assert.equal(op, null);
  assert.match(errors[0], /not a valid issue key/);
});

test('rejects path-injection attempts in keys', () => {
  for (const k of ['DEMO-1/../../x', 'DEMO-1?expand=all', 'DEMO-0', 'demo']) {
    assert.equal(buildOperation('jira.issue.delete', { issueKeys: k }).op, null, k);
  }
});

test('edit: needs at least one supported field; labels add/remove conflict', () => {
  assert.equal(buildOperation('jira.issue.edit', { issueKeys: 'DEMO-1' }).op, null);
  assert.equal(buildOperation('jira.issue.edit', { issueKeys: 'DEMO-1', labelsAdd: 'a', labelsRemove: 'a' }).op, null);
  const { op } = buildOperation('jira.issue.edit', { issueKeys: 'DEMO-1', priority: 'High', dueDate: '2026-12-01' });
  assert.deepEqual(op.fields.sort(), ['duedate', 'priority']);
  assert.equal(buildOperation('jira.issue.edit', { issueKeys: 'DEMO-1', dueDate: 'tomorrow' }).op, null);
});

test('assign: "none" unassigns, invalid accountId rejected', () => {
  assert.equal(buildOperation('jira.issue.assign', { issueKeys: 'DEMO-1', assigneeAccountId: 'none' }).op.payload.assignee, null);
  assert.equal(buildOperation('jira.issue.assign', { issueKeys: 'DEMO-1', assigneeAccountId: 'a b' }).op, null);
});

test('create: validates project and summary', () => {
  assert.equal(buildOperation('jira.issue.create', { projectKey: 'demo', summary: 'x' }).op.payload.projectKey, 'DEMO');
  assert.equal(buildOperation('jira.issue.create', { projectKey: 'DEMO' }).op, null);
  assert.equal(buildOperation('jira.issue.create', { projectKey: '1X', summary: 'x' }).op, null);
});

test('unknown operation is rejected', () => {
  assert.equal(buildOperation('jira.project.delete', {}).op, null);
});

test('fingerprint ignores key order and target order, changes with payload', () => {
  const a = buildOperation('jira.issue.comment', { issueKeys: 'DEMO-1,DEMO-2', body: 'x' }).op;
  const b = buildOperation('jira.issue.comment', { issueKeys: 'DEMO-2,DEMO-1', body: 'x' }).op;
  const c = buildOperation('jira.issue.comment', { issueKeys: 'DEMO-1,DEMO-2', body: 'y' }).op;
  assert.equal(fingerprintOperation(a), fingerprintOperation(b));
  assert.notEqual(fingerprintOperation(a), fingerprintOperation(c));
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});
