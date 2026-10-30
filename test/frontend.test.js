import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalDetails } from '../src/frontend/approval-details.js';

test('human review includes requester, expiry and exact untruncated operation payload', () => {
  const request = {
    requester: 'acct-requester', expiresAt: 60000, fingerprint: 'fixture-fingerprint',
    op: {
      kind: 'jira.issue.edit', targets: [{ issueId: '10000', issueKey: 'DEMO-1', projectId: '100', projectKey: 'DEMO' }],
      payload: { changes: { summary: '<untrusted text>', labels: { add: ['fixture'], remove: [] }, duedate: '2026-12-01' } },
    },
  };
  const displayed = JSON.parse(approvalDetails(request));
  assert.equal(displayed.requester, request.requester);
  assert.equal(displayed.expiresAt, '1970-01-01T00:01:00.000Z');
  assert.equal(displayed.operation, request.op.kind);
  assert.deepEqual(displayed.targets, request.op.targets);
  assert.deepEqual(displayed.payload, request.op.payload);
  assert.equal(displayed.fingerprint, request.fingerprint);
  request.op.payload = { body: 'x'.repeat(32000) };
  assert.deepEqual(JSON.parse(approvalDetails(request)).payload, request.op.payload);
});

import { changeSummary, countPending, operationLabel, relativeTime, statusAppearance, targetList, verdictAppearance } from '../src/frontend/format.js';

test('dashboard display helpers', () => {
  assert.equal(operationLabel('jira.issue.delete'), 'Delete');
  assert.equal(operationLabel('custom.kind'), 'custom.kind');
  assert.equal(statusAppearance('PENDING'), 'moved');
  assert.equal(statusAppearance('APPROVED'), 'success');
  assert.equal(statusAppearance('REJECTED'), 'removed');
  assert.equal(verdictAppearance('DENY'), 'removed');
  assert.equal(relativeTime(0, 30_000), 'just now');
  assert.equal(relativeTime(0, 5 * 60_000), '5 min ago');
  assert.equal(relativeTime(3 * 3_600_000, 0), 'in 3 h');
  assert.equal(targetList([{ issueKey: 'DEMO-1' }, { issueKey: null, projectKey: 'OPS' }]), 'DEMO-1, new issue in OPS');
  assert.equal(targetList([]), '—');
  assert.equal(changeSummary({ kind: 'jira.issue.transition', payload: { toStatus: 'Done' } }), 'Move to "Done"');
  assert.equal(changeSummary({ kind: 'jira.issue.assign', payload: { assignee: null } }), 'Unassign');
  assert.equal(changeSummary({ kind: 'jira.issue.edit', payload: { changes: { priority: 'High' } } }), 'Change priority');
  assert.equal(countPending([{ status: 'PENDING' }, { status: 'EXPIRED' }]), 1);
});
