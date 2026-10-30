import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ALICE, BOB } from './helpers.js';
import { makeHandlers } from '../src/actions.js';

test('allowed comment executes as the user and is audited', async () => {
  const { svc, writes, repo } = await setup();
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'hello' }, ALICE);
  assert.equal(r.status, 'EXECUTED');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].path, '/rest/api/3/issue/10000/comment');
  const audit = await repo.listAudit();
  assert.ok(audit.some((e) => e.outcome === 'EXECUTED'));
  assert.ok(audit.some((e) => e.outcome === 'EXECUTION_STARTED'));
  assert.equal((await repo.getUsage(ALICE, Date.UTC(2026, 10, 2, 9), 'UTC')).actorDay, 1);
});

test('denied change writes nothing', async () => {
  const { svc, writes } = await setup();
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: 'OPS-1', body: 'x' }, ALICE);
  assert.equal(r.status, 'DENIED');
  assert.equal(writes().length, 0);
});

test('project is taken from Jira, not from the issue key prefix', async () => {
  const { svc, writes } = await setup({ policy: { allowedProjects: ['DEMO', 'MOVED'] } });
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: 'MOVED-9', body: 'x' }, ALICE);
  assert.equal(r.status, 'DENIED');
  assert.equal(r.reasons[0].code, 'PROJECT_NOT_ALLOWED');
  assert.equal(writes().length, 0);
});

test('missing user context is refused', async () => {
  const { svc } = await setup();
  assert.equal((await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'x' }, null)).status, 'INVALID');
});

test('unknown issue and impossible transition are INVALID, nothing written', async () => {
  const { svc, writes } = await setup();
  assert.equal((await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-404', body: 'x' }, ALICE)).status, 'INVALID');
  assert.equal((await svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Archived' }, ALICE)).status, 'INVALID');
  assert.equal(writes().length, 0);
});

test('preview never writes or queues', async () => {
  const { svc, writes, repo } = await setup();
  const r = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE, { preview: true });
  assert.equal(r.status, 'PREVIEW');
  assert.equal(r.verdict, 'NEEDS_APPROVAL');
  assert.equal(writes().length, 0);
  assert.equal((await repo.listOpenRequests()).length, 0);
});

test('full approval flow: delete -> pending -> approve (other human) -> run once', async () => {
  const { svc, writes, as, jira } = await setup();
  const p = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-2' }, ALICE);
  assert.equal(p.status, 'PENDING_APPROVAL');
  assert.equal(writes().length, 0);

  // Same request again is deduplicated.
  const again = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-2' }, ALICE);
  assert.equal(again.approvalId, p.approvalId);

  // Running before approval is refused.
  assert.equal((await svc.runApproved(p.approvalId, ALICE)).code, 'NOT_APPROVED_YET');

  // Alice is not an approver (not a Jira admin); Bob is.
  as(ALICE);
  assert.equal((await svc.decideRequest(p.approvalId, true, '', ALICE)).code, 'NOT_APPROVER');
  as(BOB);
  assert.equal((await svc.decideRequest(p.approvalId, true, 'ok', BOB)).approvalStatus, 'APPROVED');
  assert.equal((await svc.approvalStatus(p.approvalId, ALICE)).approvalStatus, 'APPROVED');

  // Only the requester can run it.
  as(BOB);
  assert.equal((await svc.runApproved(p.approvalId, BOB)).code, 'NOT_REQUESTER');
  as(ALICE);
  const run = await svc.runApproved(p.approvalId, ALICE);
  assert.equal(run.status, 'EXECUTED');
  assert.equal(jira.state.issues['DEMO-2'], undefined);
  assert.equal((await svc.runApproved(p.approvalId, ALICE)).code, 'ALREADY_USED');
});

test('two-person rule with explicit approver list', async () => {
  const { svc } = await setup({ policy: { approvers: [ALICE, BOB] } });
  const p = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  assert.equal((await svc.decideRequest(p.approvalId, true, '', ALICE)).code, 'SELF_APPROVAL');
  assert.equal((await svc.decideRequest(p.approvalId, true, '', BOB)).approvalStatus, 'APPROVED');
});

test('approval never overrides a later DENY (kill switch)', async () => {
  const { svc, repo, as, writes } = await setup();
  const p = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  as(BOB);
  await svc.decideRequest(p.approvalId, true, '', BOB);
  const { policy } = await repo.loadPolicy();
  await repo.savePolicy({ ...policy, agentWritesPaused: true });
  as(ALICE);
  const r = await svc.runApproved(p.approvalId, ALICE);
  assert.equal(r.code, 'DENIED_NOW');
  assert.equal(writes().length, 0);
  assert.equal((await repo.getRequest(p.approvalId)).status, 'FAILED');
});

test('a new kind of risk at run time needs a new approval', async () => {
  const { svc, repo, as, writes } = await setup();
  const keys = 'DEMO-1,DEMO-2,DEMO-3,DEMO-4,DEMO-5,DEMO-6';
  const p = await svc.guardedChange('jira.issue.comment', { issueKeys: keys, body: 'x' }, ALICE);
  assert.deepEqual(p.reasons.map((r) => r.code), ['BULK_CHANGE']);
  as(BOB);
  await svc.decideRequest(p.approvalId, true, '', BOB);
  const { policy } = await repo.loadPolicy();
  await repo.savePolicy({ ...policy, operations: { ...policy.operations, 'jira.issue.comment': 'approve' } });
  as(ALICE);
  const r = await svc.runApproved(p.approvalId, ALICE);
  assert.equal(r.code, 'NEW_RISK');
  assert.equal(writes().length, 0);
});

test('approvals expire', async () => {
  const { svc, advance, as } = await setup({ policy: { approvalTtlMinutes: 10 } });
  const p = await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  advance(11 * 60_000);
  as(BOB);
  assert.equal((await svc.decideRequest(p.approvalId, true, '', BOB)).code, 'EXPIRED');
});

test('hourly cap turns the next write into an approval request', async () => {
  const { svc } = await setup({ policy: { perActorHourlyLimit: 3 } });
  for (const k of ['DEMO-1', 'DEMO-2', 'DEMO-3']) {
    assert.equal((await svc.guardedChange('jira.issue.comment', { issueKeys: k, body: 'x' }, ALICE)).status, 'EXECUTED');
  }
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-4', body: 'x' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  assert.equal(r.reasons[0].code, 'HOURLY_LIMIT');
  // Another user is unaffected.
  assert.equal((await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-4', body: 'x' }, BOB)).status, 'EXECUTED');
});

test('partial failure is reported per issue and all attempted targets are reserved', async () => {
  const { svc, jira, repo } = await setup();
  jira.state.failWrites.add('DEMO-2');
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1,DEMO-2', body: 'x' }, ALICE);
  assert.equal(r.status, 'PARTIAL');
  assert.deepEqual(r.results.map((x) => x.ok), [true, false]);
  assert.equal((await repo.getUsage(ALICE, Date.UTC(2026, 10, 2, 9), 'UTC')).actorDay, 2);
});

test('transition into Done (protected) needs approval; In Review runs', async () => {
  const { svc, jira } = await setup();
  assert.equal((await svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Finish' }, ALICE)).status, 'PENDING_APPROVAL');
  assert.equal((await svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'in review' }, ALICE)).status, 'EXECUTED');
  assert.equal(jira.state.issues['DEMO-1'].status, 'In Review');
});

test('oversized call is denied without reading every issue', async () => {
  const { svc, jira } = await setup();
  const keys = Array.from({ length: 30 }, (_, i) => `DEMO-${i + 1}`).join(',');
  const r = await svc.guardedChange('jira.issue.comment', { issueKeys: keys, body: 'x' }, ALICE);
  assert.equal(r.status, 'DENIED');
  assert.equal(jira.state.calls.length, 0);
});

test('only Jira admins can save policy; invalid policy is rejected', async () => {
  const { svc, as } = await setup();
  as(ALICE);
  assert.equal((await svc.savePolicy({ allowedProjects: ['X'] }, ALICE)).code, 'NOT_ADMIN');
  as(BOB);
  assert.equal((await svc.savePolicy({ maxTargetsPerCall: -1 }, BOB)).status, 'INVALID');
  assert.equal((await svc.savePolicy({ allowedProjects: ['OPS'] }, BOB)).status, 'OK');
});

test('dashboard hides other users\' requests from non-approvers', async () => {
  const { svc, as } = await setup();
  await svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, BOB);
  as(ALICE);
  const d = await svc.dashboard(ALICE);
  assert.equal(d.isApprover, false);
  assert.equal(d.requests.length, 0);
  as(BOB);
  assert.equal((await svc.dashboard(BOB)).requests.length, 1);
});

test('handlers take identity from context, not inputs, and fall back to the issue in view', async () => {
  const { svc, writes } = await setup();
  const h = makeHandlers(() => svc);
  const r = await h.commentIssues(
    { body: 'from context', accountId: 'acct-mallory', context: { jira: { issueKey: 'DEMO-3' } } },
    { accountId: ALICE },
  );
  assert.equal(r.status, 'EXECUTED');
  assert.equal(writes()[0].path, '/rest/api/3/issue/10002/comment');
  assert.equal((await h.myActivity({}, { accountId: ALICE })).entries[0].actor, ALICE);
  assert.equal((await h.commentIssues({ issueKeys: 'DEMO-1', body: 'x' }, {})).status, 'INVALID');
});

test('dashboard makes a single Jira permission call and returns the full page in one payload', async () => {
  const env = await setup();
  const before = env.jira.state.calls.filter((c) => c.path.includes('mypermissions')).length;
  const d = await env.svc.dashboard(ALICE);
  const after = env.jira.state.calls.filter((c) => c.path.includes('mypermissions')).length;
  assert.equal(after - before, 1);
  for (const k of ['actor', 'isApprover', 'isAdmin', 'policy', 'policyErrors', 'requests', 'audit', 'siteUsageToday']) assert.ok(k in d, k);
});


test('dashboard preserves explicit approver semantics even for Jira administrators', async () => {
  const env = await setup({ policy: { approvers: [ALICE] } });
  env.as(BOB);
  const admin = await env.svc.dashboard(BOB);
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.isApprover, false);
  env.as(ALICE);
  const approver = await env.svc.dashboard(ALICE);
  assert.equal(approver.isAdmin, false);
  assert.equal(approver.isApprover, true);
  assert.deepEqual(Object.keys(approver).sort(), [
    'actor', 'isApprover', 'isAdmin', 'policy', 'policyErrors', 'requests', 'audit', 'siteUsageToday',
  ].sort());
});
