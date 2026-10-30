import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, Verdict } from '../src/policy/gate.js';
import { normalizePolicy } from '../src/policy/policy.js';
import { buildOperation } from '../src/policy/ops.js';

const policy = normalizePolicy({ allowedProjects: ['DEMO'], blockedProjects: ['SEC'] }).policy;
const op = (kind, input) => buildOperation(kind, input).op;
const codes = (d) => d.reasons.map((r) => r.code);

test('small comment in allowed project is allowed', () => {
  const d = evaluate(policy, op('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'hi' }));
  assert.equal(d.verdict, Verdict.ALLOW);
  assert.equal(d.units, 1);
});

test('project not on allowlist or blocked is denied', () => {
  assert.deepEqual(codes(evaluate(policy, op('jira.issue.comment', { issueKeys: 'OPS-1', body: 'x' }))), ['PROJECT_NOT_ALLOWED']);
  assert.deepEqual(codes(evaluate(policy, op('jira.issue.comment', { issueKeys: 'SEC-1', body: 'x' }))), ['PROJECT_BLOCKED']);
});

test('kill switch denies everything', () => {
  const p = { ...policy, agentWritesPaused: true };
  assert.equal(evaluate(p, op('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'x' })).verdict, Verdict.DENY);
});

test('invalid stored policy denies everything', () => {
  const d = evaluate(policy, op('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'x' }), {}, { policyErrors: ['bad'] });
  assert.deepEqual(codes(d), ['POLICY_INVALID']);
});

test('operation mode deny', () => {
  const p = { ...policy, operations: { ...policy.operations, 'jira.issue.assign': 'deny' } };
  assert.ok(codes(evaluate(p, op('jira.issue.assign', { issueKeys: 'DEMO-1', assigneeAccountId: 'none' }))).includes('OPERATION_DENIED'));
});

test('delete always needs approval', () => {
  const d = evaluate(policy, op('jira.issue.delete', { issueKeys: 'DEMO-1' }));
  assert.equal(d.verdict, Verdict.NEEDS_APPROVAL);
  assert.deepEqual(codes(d), ['OPERATION_NEEDS_APPROVAL']);
});

test('bulk above threshold needs approval; above hard max is denied', () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => `DEMO-${i + 1}`).join(',');
  assert.deepEqual(codes(evaluate(policy, op('jira.issue.comment', { issueKeys: keys(6), body: 'x' }))), ['BULK_CHANGE']);
  assert.equal(evaluate(policy, op('jira.issue.comment', { issueKeys: keys(5), body: 'x' })).verdict, Verdict.ALLOW);
  assert.deepEqual(codes(evaluate(policy, op('jira.issue.comment', { issueKeys: keys(21), body: 'x' }))), ['TOO_MANY_TARGETS']);
});

test('protected field and protected status need approval', () => {
  assert.deepEqual(codes(evaluate(policy, op('jira.issue.edit', { issueKeys: 'DEMO-1', priority: 'Highest' }))), ['PROTECTED_FIELD']);
  assert.equal(evaluate(policy, op('jira.issue.edit', { issueKeys: 'DEMO-1', summary: 'x' })).verdict, Verdict.ALLOW);
  const t = op('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Finish' });
  t.targets[0].toStatus = 'Done'; // resolved by the service from the transition name
  assert.deepEqual(codes(evaluate(policy, t)), ['PROTECTED_STATUS']);
  assert.equal(evaluate(policy, op('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' })).verdict, Verdict.ALLOW);
});

test('rate caps count units, including this call', () => {
  const o = op('jira.issue.comment', { issueKeys: 'DEMO-1,DEMO-2', body: 'x' });
  assert.equal(evaluate(policy, o, { actorHour: 28 }).verdict, Verdict.ALLOW);
  assert.deepEqual(codes(evaluate(policy, o, { actorHour: 29 })), ['HOURLY_LIMIT']);
  assert.deepEqual(codes(evaluate(policy, o, { actorDay: 99 })), ['DAILY_LIMIT']);
  assert.deepEqual(codes(evaluate(policy, o, { siteDay: 499 })), ['SITE_DAILY_LIMIT']);
});

test('deny reasons win over approval reasons', () => {
  const d = evaluate({ ...policy, agentWritesPaused: true }, op('jira.issue.delete', { issueKeys: 'DEMO-1' }));
  assert.equal(d.verdict, Verdict.DENY);
  assert.ok(!codes(d).includes('OPERATION_NEEDS_APPROVAL'));
});

test('overlong comment is denied', () => {
  const d = evaluate(policy, op('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'x'.repeat(5001) }));
  assert.deepEqual(codes(d), ['COMMENT_TOO_LONG']);
});

test('unknown or missing op is denied', () => {
  assert.equal(evaluate(policy, null).verdict, Verdict.DENY);
  assert.equal(evaluate(policy, { kind: 'x', targets: [] }).verdict, Verdict.DENY);
});
