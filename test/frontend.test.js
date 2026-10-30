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
