// Admin "Simulate agent request": same gate path as Rovo/MCP actions, marked source 'simulated'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ALICE, BOB } from './helpers.js';
import { buildPreset, presetList } from '../src/simulation/presets.js';
import { DryRunJira } from '../src/simulation/dry-run-jira.js';
import { resolverDefinitions, buildResolver } from '../src/resolvers.js';
import { normalizePolicy } from '../src/policy/policy.js';

// BOB is the Jira admin in the fake site; ALICE is a second approver so the two-person rule can be met.
const twoApprovers = { policy: { approvers: [ALICE, BOB] } };
const simulated = (audit) => audit.filter((e) => e.source === 'simulated');

test('presets: three cases, dry run without an issue key, live with one', () => {
  const { policy } = normalizePolicy({ allowedProjects: ['DEMO'] });
  assert.deepEqual(presetList().map((p) => p.expect), ['ALLOW', 'NEEDS_APPROVAL', 'DENY']);
  const dry = buildPreset('allow-comment', policy).plan;
  assert.equal(dry.simulation.mode, 'dry-run');
  assert.equal(dry.input.issueKeys, 'DEMO-9001');
  const live = buildPreset('approval-transition', policy, ' demo-3 ').plan;
  assert.equal(live.simulation.mode, 'live');
  assert.equal(live.input.issueKeys, 'DEMO-3');
  assert.equal(live.input.toStatus, 'Done');
  assert.equal(buildPreset('blocked-bulk', policy).plan.input.issueKeys.split(',').length, policy.maxTargetsPerCall + 1);
  assert.match(buildPreset('nope', policy).error, /unknown preset/);
  assert.match(buildPreset('toString', policy).error, /unknown preset/);
  assert.match(buildPreset('allow-comment', policy, 'not a key').error, /not a valid issue key/);
});

test('non-admins cannot simulate or run simulated requests, and nothing is recorded', async () => {
  const env = await setup(twoApprovers);
  env.as(ALICE); // approver, but not a Jira admin
  const r = await env.svc.simulate('allow-comment', undefined, ALICE);
  assert.equal(r.status, 'REFUSED');
  assert.equal(r.code, 'NOT_ADMIN');
  assert.equal((await env.svc.runSimulated('id-000001', ALICE)).code, 'NOT_ADMIN');
  assert.equal((await env.repo.listAudit()).length, 0);
  assert.equal((await env.repo.listOpenRequests()).length, 0);
  assert.equal(env.writes().length, 0);
});

test('resolver: simulate and runSimulated take identity from the Forge context only', async () => {
  const env = await setup();
  env.as(ALICE);
  const defs = resolverDefinitions(() => env.svc);
  const r = await defs.simulate({ payload: { preset: 'allow-comment', accountId: BOB }, context: { accountId: ALICE } });
  assert.equal(r.code, 'NOT_ADMIN');
  const handler = buildResolver(() => env.svc);
  const viaRuntime = await handler(
    { call: { functionKey: 'simulate', payload: { preset: 'allow-comment' } }, context: {} },
    { principal: { accountId: ALICE } },
  );
  assert.equal(viaRuntime.code, 'NOT_ADMIN');
  assert.equal((await defs.runSimulated({ payload: { approvalId: 'x' }, context: {} })).status, 'INVALID');
});

test('dry-run allow preset runs through the gate, uses caps, is audited as simulated, never touches Jira writes', async () => {
  const env = await setup();
  env.as(BOB);
  const r = await env.svc.simulate('allow-comment', undefined, BOB);
  assert.equal(r.status, 'EXECUTED');
  assert.equal(r.verdict, 'ALLOW');
  assert.equal(r.dryRun, true);
  assert.equal(r.simulation.mode, 'dry-run');
  assert.equal(env.writes().length, 0);
  // Only the admin check hit real Jira.
  assert.ok(env.jira.state.calls.every((c) => c.path.includes('mypermissions')));
  const audit = await env.repo.listAudit();
  assert.deepEqual(audit.map((e) => e.outcome).sort(), ['EXECUTED', 'EXECUTION_STARTED']);
  assert.ok(audit.every((e) => e.source === 'simulated' && e.dryRun === true && e.targets[0] === 'DEMO-9001'));
  assert.equal((await env.repo.getUsage(BOB, Date.UTC(2026, 10, 2, 9), 'UTC')).actorDay, 1, 'caps apply to simulations too');
});

test('blocked preset is denied by policy before any Jira read', async () => {
  const env = await setup();
  env.as(BOB);
  const r = await env.svc.simulate('blocked-bulk', 'DEMO-1', BOB);
  assert.equal(r.status, 'DENIED');
  assert.deepEqual(r.reasons.map((x) => x.code), ['TOO_MANY_TARGETS']);
  assert.ok(env.jira.state.calls.every((c) => c.path.includes('mypermissions')), 'live mode, still no issue reads');
  const [entry] = simulated(await env.repo.listAudit());
  assert.equal(entry.outcome, 'DENIED');
  assert.equal(entry.dryRun, undefined);
});

test('dry run follows the policy honestly: an empty allowlist denies even the low-risk preset', async () => {
  const env = await setup({ policy: { allowedProjects: [] } });
  env.as(BOB);
  const r = await env.svc.simulate('allow-comment', undefined, BOB);
  assert.equal(r.status, 'DENIED');
  assert.equal(r.reasons[0].code, 'PROJECT_NOT_ALLOWED');
});

test('approval preset (dry run): queued, two-person rule enforced, approved by another human, run once without Jira writes', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const p = await env.svc.simulate('approval-transition', undefined, BOB);
  assert.equal(p.status, 'PENDING_APPROVAL');
  assert.deepEqual(p.reasons.map((x) => x.code), ['PROTECTED_STATUS']);
  const [req] = await env.repo.listOpenRequests();
  assert.equal(req.source, 'simulated');
  assert.equal(req.simulation.mode, 'dry-run');
  assert.deepEqual((await env.svc.dashboard(BOB)).simulations.map((s) => s.id), [p.approvalId]);

  assert.equal((await env.svc.decideRequest(p.approvalId, true, null, BOB)).code, 'SELF_APPROVAL');
  assert.equal((await env.svc.runSimulated(p.approvalId, BOB)).code, 'NOT_APPROVED_YET');
  env.as(ALICE);
  assert.equal((await env.svc.decideRequest(p.approvalId, true, 'ok for demo', ALICE)).status, 'OK');
  env.as(BOB);
  const run = await env.svc.runSimulated(p.approvalId, BOB);
  assert.equal(run.status, 'EXECUTED');
  assert.equal(run.dryRun, true);
  assert.equal(env.writes().length, 0);
  assert.equal((await env.svc.runSimulated(p.approvalId, BOB)).code, 'ALREADY_USED');
  const outcomes = simulated(await env.repo.listAudit()).map((e) => e.outcome);
  for (const o of ['QUEUED', 'APPROVED_BY_HUMAN', 'EXECUTION_STARTED', 'EXECUTED']) assert.ok(outcomes.includes(o), o);
});

test('a dry-run request stays dry even when run through the agent action path', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const p = await env.svc.simulate('allow-comment', undefined, BOB); // executes at once
  assert.equal(p.status, 'EXECUTED');
  const q = await env.svc.simulate('approval-transition', undefined, BOB);
  env.as(ALICE);
  await env.svc.decideRequest(q.approvalId, true, null, ALICE);
  env.as(BOB);
  const run = await env.svc.runApproved(q.approvalId, BOB); // the Rovo run-approved-change entry point
  assert.equal(run.status, 'EXECUTED');
  assert.equal(run.dryRun, true);
  assert.equal(env.writes().length, 0);
});

test('live approval preset performs the real Jira write on the chosen issue after approval', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const p = await env.svc.simulate('approval-transition', 'DEMO-1', BOB);
  assert.equal(p.status, 'PENDING_APPROVAL');
  assert.equal(env.writes().length, 0);
  env.as(ALICE);
  await env.svc.decideRequest(p.approvalId, true, null, ALICE);
  env.as(BOB);
  const run = await env.svc.runSimulated(p.approvalId, BOB);
  assert.equal(run.status, 'EXECUTED');
  assert.equal(run.dryRun, undefined);
  assert.equal(env.jira.state.issues['DEMO-1'].status, 'Done');
  assert.ok(simulated(await env.repo.listAudit()).every((e) => e.dryRun === undefined));
});

test('simulated and real agent requests for the same change are never merged', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const agent = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Done' }, BOB);
  const sim = await env.svc.simulate('approval-transition', 'DEMO-1', BOB);
  assert.notEqual(agent.approvalId, sim.approvalId);
  assert.equal((await env.repo.getRequest(agent.approvalId)).source, 'agent');
  assert.equal((await env.svc.runSimulated(agent.approvalId, BOB)).status, 'INVALID', 'real agent requests cannot be run from the demo panel');
});

test('dry-run Jira resolves the same synthetic issue by key and by id and grants no authority', async () => {
  const j = new DryRunJira({ projectKey: 'DEMO', extraStatuses: ["Won't Do"] });
  assert.deepEqual(await j.getIssue('DEMO-9001'), await j.getIssue('9001'));
  assert.equal(await j.getIssue('OPS-1'), null);
  assert.equal(await j.isJiraAdmin(), false);
  assert.ok((await j.getTransitions()).some((t) => t.to === "Won't Do"));
  assert.throws(() => new DryRunJira({ projectKey: 'bad key' }));
});

test('a requester who is no longer an admin cannot run a simulated request through run-approved-change', async () => {
  const env = await setup({ policy: { approvers: [ALICE, BOB] }, admins: [BOB] });
  env.as(BOB);
  const p = await env.svc.simulate('approval-transition', 'DEMO-1', BOB);
  env.as(ALICE);
  await env.svc.decideRequest(p.approvalId, true, null, ALICE);
  env.as(BOB);
  env.jira.state.caller = 'acct-demoted'; // Jira now reports BOB's session without ADMINISTER
  const r = await env.svc.runApproved(p.approvalId, BOB);
  assert.equal(r.code, 'NOT_ADMIN');
  assert.equal(env.writes().length, 0);
  assert.equal(env.jira.state.issues['DEMO-1'].status, 'To Do');
});

test('alternating agent and simulated requests for one change dedupe within each origin', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const agent = () => env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Done' }, BOB);
  const sim = () => env.svc.simulate('approval-transition', 'DEMO-1', BOB);
  const ids = [(await agent()).approvalId, (await sim()).approvalId, (await agent()).approvalId, (await sim()).approvalId];
  assert.equal(ids[0], ids[2]);
  assert.equal(ids[1], ids[3]);
  assert.notEqual(ids[0], ids[1]);
  assert.equal((await env.repo.listOpenRequests()).length, 2);
});

test('an approved simulation keeps its Run control even after many newer simulations', async () => {
  const env = await setup(twoApprovers);
  env.as(BOB);
  const first = (await env.svc.simulate('approval-transition', 'DEMO-1', BOB)).approvalId;
  env.as(ALICE);
  await env.svc.decideRequest(first, true, null, ALICE);
  env.as(BOB);
  for (let i = 2; i <= 13; i++) {
    env.advance(1000);
    await env.svc.simulate('approval-transition', `DEMO-${i}`, BOB);
  }
  const d = await env.svc.dashboard(BOB);
  const row = d.simulations.find((r) => r.id === first);
  assert.equal(row?.status, 'APPROVED');
  assert.equal((await env.svc.runSimulated(first, BOB)).status, 'EXECUTED');
  assert.ok(!(await env.svc.dashboard(BOB)).simulations.some((r) => r.id === first), 'gone from the approved index once run');
});
