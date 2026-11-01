import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalDetails } from '../src/frontend/approval-details.js';
import { loadDemoState } from '../src/frontend/demo-load.js';

test('guided demo load can be retried after rejection without resetting stored progress', async () => {
  const progress = { nextStep: 4, results: { 3: { status: 'APPROVED' } } };
  const calls = [];
  const invoke = async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error('temporary failure');
    return { status: 'OK', demo: progress };
  };
  const failed = await loadDemoState(invoke, null);
  assert.equal(failed.loadFailed, true);
  assert.match(failed.message.text, /temporary failure/);
  const retried = await loadDemoState(invoke, failed.demo);
  assert.deepEqual(retried, { demo: progress, message: null, loadFailed: false });
  assert.deepEqual(calls, [['demoState'], ['demoState']], 'retry only reads progress');
  const laterFailure = await loadDemoState(async () => ({ status: 'INVALID', errors: ['unavailable'] }), progress);
  assert.equal(laterFailure.demo, progress);
  assert.equal(laterFailure.loadFailed, true);
  assert.equal(laterFailure.message.text, 'unavailable');
});

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

import { contextRulesSummary, graphStatusLabel, isContextReason, signalLabel, sourceAppearance, sourceNames } from '../src/frontend/format.js';
import { normalizePolicy } from '../src/policy/policy.js';
import { approvalReasonText } from '../src/frontend/format.js';
import { DEMO_STEPS, adminToolsExpanded, demoResult, demoStepButton, showGuidedDemoHint } from '../src/frontend/demo-format.js';

test('guided demo display: only the next step is primary and enabled, results keep verdict and refusal codes', () => {
  assert.equal(DEMO_STEPS.length, 5);
  assert.deepEqual(demoStepButton({ nextStep: 3 }, 3), { appearance: 'primary', isDisabled: false });
  for (const step of [1, 2, 4, 5]) assert.equal(demoStepButton({ nextStep: 3 }, step).isDisabled, true);
  assert.equal(demoStepButton({ nextStep: 3 }, 3, true).isDisabled, true);
  assert.equal(demoStepButton(null, 1).isDisabled, true);
  assert.equal(demoStepButton({ nextStep: null }, 5).isDisabled, true);
  assert.deepEqual(demoResult({ status: 'EXECUTED', verdict: 'ALLOW', dryRun: true }), { label: 'ALLOW', detail: 'EXECUTED (dry run)', codes: [] });
  assert.deepEqual(demoResult({ status: 'PENDING_APPROVAL', verdict: 'NEEDS_APPROVAL', reasons: [{ code: 'CONTEXT_RELEASE_SOON' }, { code: 'CONTEXT_LINKED_GOAL' }] }), { label: 'NEEDS APPROVAL', detail: '', codes: ['CONTEXT_RELEASE_SOON', 'CONTEXT_LINKED_GOAL'] });
  assert.equal(demoResult({ status: 'APPROVED' }).label, 'APPROVED');
  assert.equal(demoResult({ status: 'EXECUTED', dryRun: true }).detail, '(dry run)');
  assert.equal(demoResult({ status: 'DENIED', verdict: 'DENY' }).label, 'DENY');
  assert.deepEqual(demoResult({ status: 'REFUSED', approvalStatus: 'EXECUTED', code: 'ALREADY_USED' }), { label: 'REFUSED', detail: '', codes: ['ALREADY_USED'] });
  assert.equal(demoResult(null), null);
  assert.equal(statusAppearance('NEEDS APPROVAL'), 'moved');
  assert.equal(statusAppearance('REFUSED'), 'removed');
});

test('guided demo hint is only shown to admins with an empty project allowlist', () => {
  assert.equal(showGuidedDemoHint({ isAdmin: true, policy: { allowedProjects: [] } }), true);
  assert.equal(showGuidedDemoHint({ isAdmin: false, policy: { allowedProjects: [] } }), false);
  assert.equal(showGuidedDemoHint({ isAdmin: true, policy: { allowedProjects: ['DEMO'] } }), false);
  assert.equal(showGuidedDemoHint(null), false);
});

test('guided demo and real review dialog share the stored approver-safe reason text', () => {
  assert.equal(approvalReasonText({ reasons: [{ message: 'release in 3 days' }, { message: 'linked to 1 active goal' }] }), 'release in 3 days · linked to 1 active goal');
  assert.equal(approvalReasonText({ reasons: [] }), 'Policy requires approval.');
});

test('context display helpers', () => {
  const { policy } = normalizePolicy({ contextRisk: { signals: { HIGH_PRIORITY: 'off', LINKED_GOAL: 'deny' } } });
  assert.deepEqual(sourceNames('teamwork-graph+jira'), ['Teamwork Graph', 'Jira']);
  assert.equal(sourceAppearance('teamwork-graph'), 'new');
  assert.equal(sourceAppearance('jira'), 'inprogress');
  assert.equal(signalLabel('RELEASE_SOON'), 'Release due soon');
  assert.ok(contextRulesSummary(policy).includes('Linked to a goal (block)'));
  assert.ok(!contextRulesSummary(policy).includes('High priority'));
  assert.equal(isContextReason({ code: 'CONTEXT_LINKED_GOAL' }), true);
  assert.equal(graphStatusLabel(policy, { ok: true }).text, 'Teamwork Graph API reachable');
  assert.equal(graphStatusLabel(policy, { ok: false }).text, 'Teamwork Graph API not reachable');
  assert.match(graphStatusLabel(policy, { ok: false, error: 'HTTP 401' }).detail, /HTTP 401/);
  assert.equal(graphStatusLabel(normalizePolicy({ contextRisk: { enabled: false } }).policy).text, 'Context checks off');
});

test('admin demo tools: expanded on a fresh install, on demand once the gate is configured', () => {
  assert.equal(adminToolsExpanded({ isAdmin: true, policy: { allowedProjects: [] } }), true);
  assert.equal(adminToolsExpanded({ isAdmin: true, policy: { allowedProjects: ['KAN'] } }), false);
});
