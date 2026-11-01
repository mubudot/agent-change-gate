// The judge's path uses actual resolver definitions and initially empty storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverDefinitions, buildResolver } from '../src/resolvers.js';
import { freshSetup, ALICE, BOB } from './helpers.js';
import { showGuidedDemoHint } from '../src/frontend/demo-format.js';

test('fresh admin dashboard → guided demo → approval/run/replay/deny needs no policy setup or real issue access', async () => {
  const env = freshSetup();
  const defs = resolverDefinitions(() => env.svc);
  const context = { accountId: BOB };
  env.as(BOB);
  const dashboard = await defs.getDashboard({ context });
  assert.equal(dashboard.isAdmin, true);
  assert.deepEqual(dashboard.policy.allowedProjects, []);
  assert.equal(dashboard.policy.requireDistinctApprover, true);
  assert.equal(dashboard.siteUsageToday, 0);
  assert.deepEqual(dashboard.requests, []);
  assert.equal(showGuidedDemoHint(dashboard), true);
  assert.equal((await defs.demoState({ context })).demo.nextStep, 1);
  const call = (n) => defs.demoStep({ context, payload: { step: n } });
  assert.equal((await call(1)).verdict, 'ALLOW');
  const queued = await call(2);
  assert.equal(queued.status, 'PENDING_APPROVAL');
  assert.deepEqual(queued.reasons.map((r) => r.code), ['CONTEXT_RELEASE_SOON', 'CONTEXT_LINKED_GOAL']);
  assert.equal((await call(3)).status, 'APPROVED');
  assert.equal((await call(4)).status, 'EXECUTED');
  assert.equal((await call('replay')).code, 'ALREADY_USED');
  assert.equal((await call(5)).status, 'DENIED');
  assert.equal((await defs.demoState({ context })).demo.nextStep, null);
  const after = await defs.getDashboard({ context });
  assert.deepEqual(after, dashboard, 'main page still describes the unchanged real installation');
  assert.ok(env.jira.state.calls.every((c) => c.method === 'GET' && c.path.includes('mypermissions')));
  assert.ok([...env.store.map.keys()].every((k) => k.startsWith('demo:')), 'no real policy, usage, request or audit keys created');
  assert.equal((await defs.demoReset({ context })).demo.nextStep, 1);
  assert.equal(env.store.map.size, 0);
});

test('demo resolvers are wired through the Forge handler and use the trusted principal', async () => {
  const env = freshSetup({ admins: [ALICE, BOB] });
  const seen = [];
  const handler = buildResolver((context) => { seen.push(context.accountId); env.as(context.accountId); return env.svc; });
  const invoke = (name, payload, actor = BOB) => handler(
    { call: { functionKey: name, payload }, context: {} }, { principal: { accountId: actor } },
  );
  assert.equal((await invoke('demoState')).demo.nextStep, 1);
  assert.equal((await invoke('demoStep', { step: 1 })).status, 'EXECUTED');
  assert.equal((await invoke('demoState', undefined, ALICE)).demo.nextStep, 1);
  assert.equal((await invoke('demoStep', { step: 2, accountId: ALICE })).status, 'INVALID');
  assert.equal((await invoke('demoState')).demo.nextStep, 2);
  assert.equal((await invoke('demoReset')).demo.nextStep, 1);
  assert.ok(seen.every((id) => [ALICE, BOB].includes(id)));
});

test('fresh non-admin dashboard has no demo hint; all demo resolver operations refuse access', async () => {
  const env = freshSetup();
  env.as(ALICE);
  const defs = resolverDefinitions(() => env.svc);
  const context = { accountId: ALICE };
  const dashboard = await defs.getDashboard({ context });
  assert.equal(dashboard.isAdmin, false);
  assert.equal(showGuidedDemoHint(dashboard), false);
  for (const name of ['demoState', 'demoStep', 'demoReset']) {
    const r = await defs[name]({ context, payload: { step: 1, accountId: BOB } });
    assert.equal(r.code, 'NOT_ADMIN');
  }
  assert.equal(env.store.map.size, 0);
});
