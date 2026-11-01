import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSetup, setup, ALICE, BOB, fakeGraph } from './helpers.js';
import { DemoSession, demoPrefix, demoSeed, DEMO_TTL_SECONDS } from '../src/simulation/demo-session.js';
import { DryRunJira } from '../src/simulation/dry-run-jira.js';
import { DryRunGraph } from '../src/simulation/dry-run-graph.js';
import { PrefixStore } from '../src/store/prefix.js';
import { Repo } from '../src/store/repo.js';
import { MemoryStore } from '../src/store/memory.js';

const sessionFor = (env, actor = BOB) => { env.as(actor); return new DemoSession(env.svc, actor); };
const step = (demo, n) => demo.step({ step: n });
async function finish(demo) {
  const results = [];
  for (let i = 1; i <= 5; i++) {
    results.push(await step(demo, i));
    if (i === 4) results.push(await step(demo, 'replay'));
  }
  return results;
}

test('fresh demo completes allow → context approval → approve → execute → refuse replay → deny bulk', async () => {
  const env = freshSetup();
  assert.equal(env.store.map.size, 0);
  const demo = sessionFor(env);
  const initial = await demo.state();
  assert.equal(initial.status, 'OK');
  assert.equal(initial.demo.nextStep, 1);
  assert.deepEqual(initial.demo.audit, []);
  assert.equal(env.store.map.size, 0, 'initial state is read-only');
  const routine = await step(demo, 1);
  assert.equal(routine.verdict, 'ALLOW');
  assert.equal(routine.status, 'EXECUTED');
  assert.equal(routine.dryRun, true);
  assert.equal(routine.results[0].key, 'DEMO-1');
  assert.deepEqual(routine.context.signals, []);
  env.advance(1000);
  const risky = await step(demo, 2);
  assert.equal(risky.status, 'PENDING_APPROVAL');
  assert.deepEqual(risky.reasons.map((r) => r.code), ['CONTEXT_RELEASE_SOON', 'CONTEXT_LINKED_GOAL']);
  assert.match(risky.demo.review.reasons[1].message, /linked to 1 active goal/);
  assert.match(risky.demo.review.context.signals[1].message, /linked to 1 active goal/);
  assert.doesNotMatch(JSON.stringify(risky.demo.review), /Demo company goal/);
  env.advance(1000);
  const approved = await step(demo, 3);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approvalStatus, 'APPROVED');
  env.advance(1000);
  const run = await step(demo, 4);
  assert.equal(run.status, 'EXECUTED');
  assert.equal(run.approvedBy, BOB);
  assert.equal(run.dryRun, true);
  assert.equal(run.results[0].key, 'DEMO-2');
  const used = await step(demo, 'replay');
  assert.equal(used.status, 'REFUSED');
  assert.equal(used.code, 'ALREADY_USED');
  env.advance(1000);
  const denied = await step(demo, 5);
  assert.equal(denied.status, 'DENIED');
  assert.equal(denied.verdict, 'DENY');
  assert.deepEqual(denied.reasons.map((r) => r.code), ['TOO_MANY_TARGETS']);
  assert.equal(denied.demo.nextStep, null);
  assert.deepEqual(Object.keys(denied.demo.results), ['1', '2', '3', '4', '5']);
  assert.ok(denied.demo.audit.every((e) => e.actor === BOB && e.dryRun && e.source === 'simulated'));
  assert.ok(denied.demo.audit.some((e) => e.codes.includes('ALREADY_USED')));
  assert.equal(denied.demo.audit[0].outcome, 'DENIED');
  assert.ok(denied.demo.audit.length <= 10);
  assert.deepEqual((await demo.state()).demo, denied.demo);
  assert.ok(env.jira.state.calls.length > 0);
  assert.ok(env.jira.state.calls.every((c) => c.method === 'GET' && c.path === '/rest/api/3/mypermissions?permissions=ADMINISTER'));
});

test('demo order is enforced on the server, including duplicate steps and replay before execution', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  for (const n of [2, 3, 4, 5, 'replay']) assert.equal((await step(demo, n)).code, 'DEMO_STEP_ORDER');
  await step(demo, 1);
  const before = new Map(env.store.map);
  assert.equal((await step(demo, 1)).code, 'DEMO_STEP_ORDER');
  assert.deepEqual(env.store.map, before);
  await step(demo, 2);
  assert.equal((await step(demo, 4)).code, 'DEMO_STEP_ORDER');
  await step(demo, 3);
  assert.equal((await step(demo, 'replay')).code, 'DEMO_STEP_ORDER');
  await step(demo, 4);
  const refused = await step(demo, 'replay');
  const used = new Map(env.store.map);
  assert.deepEqual(await step(demo, 'replay'), refused);
  assert.deepEqual(env.store.map, used, 'replay example is bounded');
  await step(demo, 5);
  assert.equal((await step(demo, 5)).code, 'DEMO_STEP_ORDER');
});

test('demo reset deletes all session data, even when KVS index queries lag, and starts again', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  await finish(demo);
  env.store.listPage = async () => ({ results: [] });
  assert.equal((await demo.reset()).status, 'OK');
  assert.equal(env.store.map.size, 0, 'policy, requests, claims, usage, audit, indexes and lease are deleted');
  const state = await demo.state();
  assert.equal(state.demo.nextStep, 1);
  assert.deepEqual(state.demo.results, {});
  assert.equal((await step(demo, 1)).status, 'EXECUTED');
});

test('two administrators have isolated progress, requests, usage and audit; resetting one preserves the other', async () => {
  const env = freshSetup({ admins: [ALICE, BOB] });
  const bob = sessionFor(env);
  await step(bob, 1);
  const pending = await step(bob, 2);
  const alice = sessionFor(env, ALICE);
  assert.equal((await alice.state()).demo.nextStep, 1);
  assert.equal((await step(alice, 3)).code, 'DEMO_STEP_ORDER');
  await finish(alice);
  const aliceData = [...env.store.map.entries()].filter(([k]) => k.startsWith(demoPrefix(ALICE)));
  env.as(BOB);
  const bobRepo = new Repo(new PrefixStore(env.store, demoPrefix(BOB)));
  assert.equal((await bobRepo.getRequest(pending.approvalId)).status, 'PENDING');
  assert.ok((await bob.state()).demo.audit.every((e) => e.actor === BOB));
  assert.equal((await bobRepo.getUsage(BOB, env.svc.now(), 'UTC')).siteDay, 1);
  await bob.reset();
  assert.deepEqual([...env.store.map.entries()].filter(([k]) => k.startsWith(demoPrefix(ALICE))), aliceData);
});

test('full demo leaves existing real policy, usage, requests, approvals, audit and Teamwork Graph untouched', async () => {
  const graph = fakeGraph();
  const env = await setup({ graph });
  await env.svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'real attempt' }, ALICE);
  const pending = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'Done' }, ALICE);
  env.as(BOB);
  await env.svc.decideRequest(pending.approvalId, true, undefined, BOB);
  const before = new Map(env.store.map);
  const graphBefore = structuredClone(graph.calls);
  env.jira.state.calls.length = 0;
  await finish(sessionFor(env));
  const real = new Map([...env.store.map].filter(([k]) => !k.startsWith('demo:')));
  assert.deepEqual(real, before);
  assert.deepEqual(graph.calls, graphBefore);
  assert.ok(env.jira.state.calls.every((c) => c.path.includes('mypermissions')));
});

test('non-admins and missing actors cannot read, run or reset a demo; no namespace is created', async () => {
  const env = freshSetup();
  for (const actor of [ALICE, undefined]) {
    env.as(actor ?? ALICE);
    const target = new DemoSession(env.svc, actor);
    for (const call of [() => target.state(), () => step(target, 1), () => target.reset()]) {
      const r = await call();
      assert.equal(r.status, actor ? 'REFUSED' : 'INVALID');
      if (actor) assert.equal(r.code, 'NOT_ADMIN');
    }
  }
  assert.equal(env.store.map.size, 0);
});

test('demo rejects invalid steps, arbitrary input and every issue-key entry point', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  for (const n of [undefined, 0, 6, -1, '1', 'toString', 'DEMO-1', {}, ['1']]) {
    assert.equal((await step(demo, n)).status, 'INVALID');
  }
  for (const extra of [{ issueKey: 'OPS-1' }, { issueKeys: ['DEMO-1'] }, { input: { issueKey: 'OPS-1' } }, { accountId: ALICE }, { policy: {} }]) {
    for (const result of [await demo.state(extra), await demo.step({ step: 1, ...extra }), await demo.reset(extra)]) {
      assert.equal(result.status, 'INVALID');
      assert.match(result.errors[0], /issue keys/);
    }
  }
  assert.equal(env.store.map.size, 0);
});

test('bulk demo is rejected before any dry-run issue, transition or graph read', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  for (let i = 1; i <= 4; i++) await step(demo, i);
  const originals = [DryRunJira.prototype.getIssue, DryRunJira.prototype.getTransitions, DryRunGraph.prototype.workItemContext];
  const noRead = () => { assert.fail('bulk deny must precede every issue/context read'); };
  DryRunJira.prototype.getIssue = noRead;
  DryRunJira.prototype.getTransitions = noRead;
  DryRunGraph.prototype.workItemContext = noRead;
  try { assert.equal((await step(demo, 5)).status, 'DENIED'); }
  finally {
    [DryRunJira.prototype.getIssue, DryRunJira.prototype.getTransitions, DryRunGraph.prototype.workItemContext] = originals;
  }
});

test('demo uses real policy evaluation and usage caps in its namespace', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  await step(demo, 2); // initialise, without running step 1 out of order
  const repo = new Repo(new PrefixStore(env.store, demoPrefix(BOB)));
  const { policy } = await repo.loadPolicy();
  assert.deepEqual(policy.allowedProjects, ['DEMO']);
  assert.equal(policy.requireDistinctApprover, false);
  assert.equal(policy.contextRisk.enabled, true);
  await repo.withMutation(() => repo.addUsage(BOB, env.svc.now(), 'UTC', policy.siteDailyLimit), env.svc.now());
  const r = await step(demo, 1);
  assert.equal(r.status, 'PENDING_APPROVAL', 'demo results come from the gate, not scripted verdicts');
  assert.ok(r.reasons.some((x) => x.code === 'SITE_DAILY_LIMIT'));
  assert.equal(r.demo.nextStep, 1);
});

test('demo lease preserves concurrent step order and never contends with the real gate', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  const both = await Promise.all([step(demo, 1), step(demo, 1)]);
  assert.equal(both.filter((r) => r.status === 'EXECUTED').length, 1);
  assert.ok(both.some((r) => ['BUSY', 'DEMO_STEP_ORDER'].includes(r.code)));
  await env.repo.withMutation(async () => {
    assert.equal((await step(demo, 2)).status, 'PENDING_APPROVAL');
  }, env.svc.now());
  assert.ok(![...env.store.map.keys()].some((k) => k.includes('mutation-lock:')));
});

test('all demo data has a bounded TTL; logical expiry handles unswept KVS values', async () => {
  const env = freshSetup();
  const demo = sessionFor(env);
  await finish(demo);
  for (const key of env.store.map.keys()) {
    assert.ok(env.store.expiries.get(key) <= env.svc.now() + DEMO_TTL_SECONDS * 1000, key);
  }
  // KVS can retain expired values: logical session expiry still resets progress.
  env.store.expiries.clear();
  env.advance(DEMO_TTL_SECONDS * 1000);
  const state = await demo.state();
  assert.equal(state.demo.nextStep, 1);
  assert.deepEqual(state.demo.audit, []);
  assert.deepEqual(state.demo.results, {});
  assert.equal((await step(demo, 1)).status, 'EXECUTED', 'first action cleans up the expired session');
  assert.ok(![...env.store.map.keys()].some((k) => k.includes('req:') || k.includes('claim:')));
});

test('demo fixtures describe only DEMO-1 (routine) and DEMO-2 (release plus goal)', async () => {
  const now = Date.UTC(2026, 10, 2);
  const seed = demoSeed(now);
  const jira = new DryRunJira(seed);
  assert.deepEqual((await jira.getIssue('DEMO-1')).facts.fixVersions, []);
  assert.equal((await jira.getIssue('2')).facts.fixVersions[0].releaseDate, '2026-11-05');
  assert.equal(await jira.getIssue('DEMO-3'), null);
  const graph = await new DryRunGraph(seed).workItemContext(['1', '2']);
  assert.deepEqual(graph.byIssue['1'].goals, []);
  assert.equal(graph.byIssue['2'].goals.length, 1);
});

test('prefix adapter preserves pagination, stripped keys, atomic claims and shorter lease TTLs', async () => {
  const memory = new MemoryStore(() => 0);
  const store = new PrefixStore(memory, 'demo:fixture:');
  await store.set('open:a', 1);
  await store.set('open:b', 2);
  await memory.set('open:real', 3);
  const page = await store.listPage('open:', 1);
  assert.deepEqual(page.results, [{ key: 'open:a', value: 1 }]);
  assert.deepEqual((await store.listPage('open:', 1, page.nextCursor)).results, [{ key: 'open:b', value: 2 }]);
  assert.equal(await store.set('claim:x', 1, { failIfExists: true }), true);
  assert.equal(await store.set('claim:x', 2, { failIfExists: true }), false);
  await store.set('mutation-lock:0', {}, { ttlSeconds: 240 });
  assert.equal(memory.expiries.get('demo:fixture:mutation-lock:0'), 240000);
  await store.clear();
  assert.equal(await memory.get('open:real'), 3);
  assert.deepEqual(await memory.get('demo:fixture:mutation-lock:0'), {}, 'clear cannot release a held lease');
  assert.equal(await store.get('claim:x'), undefined);
});
