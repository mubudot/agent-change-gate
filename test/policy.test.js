import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicy, DEFAULT_POLICY, dayKey, hourKey } from '../src/policy/policy.js';

test('defaults are safe: no project allowed, delete needs approval', () => {
  const { policy, errors } = normalizePolicy({});
  assert.deepEqual(errors, []);
  assert.deepEqual(policy.allowedProjects, []);
  assert.equal(policy.operations['jira.issue.delete'], 'approve');
  assert.equal(policy.requireDistinctApprover, true);
});

test('destructive floor: delete cannot be set to allow', () => {
  const { policy } = normalizePolicy({ operations: { 'jira.issue.delete': 'allow' } });
  assert.equal(policy.operations['jira.issue.delete'], 'approve');
});

test('project keys are uppercased, deduped and validated', () => {
  const { policy, errors } = normalizePolicy({ allowedProjects: ['demo', 'DEMO', 'bad key'] });
  assert.deepEqual(policy.allowedProjects, ['DEMO']);
  assert.equal(errors.length, 1);
});

test('rejects unknown operations, bad modes, bad numbers, bad timezone', () => {
  const { errors } = normalizePolicy({
    operations: { 'jira.issue.nuke': 'allow', 'jira.issue.edit': 'maybe' },
    maxTargetsPerCall: 0,
    perActorDailyLimit: 1.5,
    timezone: 'Mars/Base',
  });
  assert.equal(errors.length, 5);
});

test('cross-field checks', () => {
  assert.ok(normalizePolicy({ maxTargetsPerCall: 3, bulkApprovalThreshold: 5 }).errors.length);
  assert.ok(normalizePolicy({ perActorHourlyLimit: 50, perActorDailyLimit: 10 }).errors.length);
});

test('non-object policy falls back to defaults with an error', () => {
  const { policy, errors } = normalizePolicy([]);
  assert.equal(errors.length, 1);
  assert.deepEqual(policy.allowedProjects, DEFAULT_POLICY.allowedProjects);
});

test('day boundary follows the policy timezone', () => {
  const t = Date.UTC(2026, 9, 30, 20, 0, 0); // 20:00 UTC = 04:00 next day at UTC+8
  assert.equal(dayKey(t, 'UTC'), '2026-10-30');
  assert.equal(dayKey(t, 'Asia/Singapore'), '2026-10-31');
  assert.equal(hourKey(t), '2026-10-30T20');
});

test('strict schema rejects coercion, unknown properties, versions and malformed lists', () => {
  for (const input of [
    { agentWritesPaused: 'true' }, { requireDistinctApprover: 0 },
    { perActorHourlyLimit: '30' }, { perActorHourlyLimit: true },
    { version: 2 }, { allowedProject: ['DEMO'] },
    { allowedProjects: [null] }, { approvers: [123] },
    { protectedStatuses: [''] }, { protectedFields: [{}] },
  ]) assert.ok(normalizePolicy(input).errors.length, JSON.stringify(input));
});
