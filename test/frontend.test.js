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

import { simulationMessage, sourceLabel } from '../src/frontend/format.js';

test('simulation labels and feedback', () => {
  assert.equal(sourceLabel({ source: 'simulated', dryRun: true }), 'Simulated (dry run)');
  assert.equal(sourceLabel({ source: 'simulated', simulation: { mode: 'live' } }), 'Simulated (live)');
  assert.equal(sourceLabel({ source: 'simulated', simulation: { mode: 'dry-run' } }), 'Simulated (dry run)');
  assert.equal(sourceLabel({ kind: 'policy.update' }), 'Admin');
  assert.equal(sourceLabel({}), 'Agent');
  assert.match(simulationMessage({ status: 'EXECUTED', dryRun: true }).text, /Dry run/);
  assert.equal(simulationMessage({ status: 'DENIED', reasons: [{ message: 'too many' }] }).tone, 'error');
  assert.equal(simulationMessage({ status: 'PENDING_APPROVAL', reasons: [] }).tone, 'information');
  assert.equal(simulationMessage({ status: 'REFUSED', code: 'NOT_ADMIN', message: 'only admins' }).text, 'only admins');
  assert.match(simulationMessage({ status: 'INVALID', errors: ['bad key'] }).text, /bad key/);
});

import { capsSummary, currentSimulationMessage } from '../src/frontend/format.js';

test('caps summary matches the gate: approval only for MORE than the bulk threshold', () => {
  const policy = { bulkApprovalThreshold: 5, maxTargetsPerCall: 20, perActorHourlyLimit: 30, perActorDailyLimit: 100, siteDailyLimit: 500 };
  const text = capsSummary(policy);
  assert.match(text, /^More than 5 issues in one call need approval/);
  assert.doesNotMatch(text, /5\+/);
  assert.match(text, /max 20 per call/);
  assert.match(capsSummary({ ...policy, bulkApprovalThreshold: 1 }), /^More than 1 issue in one call/);
});

test('approved simulated run says it ran once, not "Gate verdict ALLOW"', () => {
  const dry = simulationMessage({ status: 'EXECUTED', approvalId: 'a1', approvedBy: 'u2', dryRun: true, results: [] });
  assert.equal(dry.tone, 'success');
  assert.equal(dry.text, 'Approved change ran once (dry run): Jira was not changed.');
  assert.doesNotMatch(dry.text, /ALLOW/);
  assert.equal(simulationMessage({ status: 'EXECUTED', approvalId: 'a1', approvedBy: 'u2', results: [] }).text, 'Approved change ran once and was written to Jira.');
  // A direct ALLOW (no approval involved) keeps the verdict wording.
  assert.match(simulationMessage({ status: 'EXECUTED', dryRun: true }).text, /^Gate verdict ALLOW/);
});

test('NEEDS APPROVAL banner is replaced once the simulated request is decided', () => {
  const queued = simulationMessage({ status: 'PENDING_APPROVAL', approvalId: 'a1', reasons: [{ message: 'protected status' }] });
  assert.equal(queued.approvalId, 'a1');
  assert.equal(currentSimulationMessage(queued, [{ id: 'a1', status: 'PENDING' }]), queued);
  assert.equal(currentSimulationMessage(queued, []), queued);
  const approved = currentSimulationMessage(queued, [{ id: 'a1', status: 'APPROVED' }]);
  assert.equal(approved.tone, 'success');
  assert.doesNotMatch(approved.text, /NEEDS APPROVAL/);
  assert.match(approved.text, /Run approved change/);
  assert.match(currentSimulationMessage(queued, [{ id: 'a1', status: 'REJECTED' }]).text, /rejected/);
  // Both a pending and an approved-but-never-run request can expire; the text must fit both.
  assert.equal(currentSimulationMessage(queued, [{ id: 'a1', status: 'EXPIRED' }]).text, 'This request expired before it ran. Nothing was changed.');
  assert.equal(currentSimulationMessage(queued, [{ id: 'a1', status: 'EXECUTED' }]), null);
  // Messages without an approval id (allow / deny / run results) pass through unchanged.
  const ran = simulationMessage({ status: 'EXECUTED', approvalId: 'a1', approvedBy: 'u2', dryRun: true });
  assert.equal(currentSimulationMessage(ran, [{ id: 'a1', status: 'EXECUTED' }]), ran);
});
