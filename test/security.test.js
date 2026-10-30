import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ALICE, BOB } from './helpers.js';
import { actorFrom, makeHandlers } from '../src/actions.js';
import { LOCK_BUCKET_MS, LOCK_LEASE_MS } from '../src/store/repo.js';

const comment = { issueKeys: 'DEMO-1', body: 'review fixture' };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function approved(env, kind = 'jira.issue.delete', input = { issueKeys: 'DEMO-1' }) {
  const pending = await env.svc.guardedChange(kind, input, ALICE);
  assert.equal(pending.status, 'PENDING_APPROVAL');
  env.as(BOB);
  assert.equal((await env.svc.decideRequest(pending.approvalId, true, '', BOB)).status, 'OK');
  env.as(ALICE);
  return pending.approvalId;
}

test('identity comes only from the platform context, never from the payload', async () => {
  const env = await setup();
  const h = makeHandlers(() => env.svc);
  const spoof = { ...comment, accountId: ALICE, context: { accountId: ALICE, principal: { accountId: ALICE } } };
  for (const context of [undefined, {}, { principal: {} }, { principal: { accountId: {} } }, { accountId: {} }, { accountId: '' }]) {
    assert.equal(actorFrom(spoof, context), null);
    assert.equal((await h.commentIssues(spoof, context)).status, 'INVALID');
    assert.equal((await h.myActivity(spoof, context)).status, 'INVALID');
  }
  const id = await approved(env);
  assert.equal((await h.runApproved({ ...spoof, approvalId: id }, {})).status, 'INVALID');
  assert.equal(env.writes().length, 0);
});

test('simultaneous changes cannot race the actor or site usage cap', async () => {
  const env = await setup({ policy: { perActorHourlyLimit: 1, perActorDailyLimit: 1, siteDailyLimit: 1 } });
  const entered = deferred();
  const resume = deferred();
  const get = env.jira.client.getIssue.bind(env.jira.client);
  env.jira.client.getIssue = async (key) => { entered.resolve(); await resume.promise; return get(key); };
  const first = env.svc.guardedChange('jira.issue.comment', comment, ALICE);
  await entered.promise;
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, BOB)).code, 'BUSY');
  resume.resolve();
  assert.equal((await first).status, 'EXECUTED');
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).status, 'PENDING_APPROVAL');
  const nextUser = await env.svc.guardedChange('jira.issue.comment', comment, BOB);
  assert.equal(nextUser.status, 'PENDING_APPROVAL');
  assert.ok(nextUser.reasons.some((r) => r.code === 'SITE_DAILY_LIMIT'));
  assert.equal(env.writes().length, 1);
});

test('competing decisions cannot overwrite a rejection with approval', async () => {
  const env = await setup({ policy: { approvers: [BOB] } });
  const pending = await env.svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  const entered = deferred();
  const resume = deferred();
  const get = env.repo.getRequest.bind(env.repo);
  env.repo.getRequest = async (id) => { const req = await get(id); entered.resolve(); await resume.promise; return req; };
  const reject = env.svc.decideRequest(pending.approvalId, false, '', BOB);
  await entered.promise;
  assert.equal((await env.svc.decideRequest(pending.approvalId, true, '', BOB)).code, 'BUSY');
  resume.resolve();
  assert.equal((await reject).approvalStatus, 'REJECTED');
  assert.equal((await env.svc.decideRequest(pending.approvalId, true, '', BOB)).code, 'NOT_PENDING');
  assert.equal((await env.svc.runApproved(pending.approvalId, ALICE)).code, 'REJECTED');
  assert.equal(env.writes().length, 0);
});

test('concurrent approved executions and later replays write each approved target once', async () => {
  const env = await setup();
  const id = await approved(env, 'jira.issue.comment', { issueKeys: 'DEMO-1,DEMO-2,DEMO-3,DEMO-4,DEMO-5,DEMO-6', body: 'review fixture' });
  const entered = deferred();
  const resume = deferred();
  const get = env.jira.client.getIssue.bind(env.jira.client);
  env.jira.client.getIssue = async (key) => { entered.resolve(); await resume.promise; return get(key); };
  const run = env.svc.runApproved(id, ALICE);
  await entered.promise;
  assert.equal((await env.svc.runApproved(id, ALICE)).code, 'BUSY');
  resume.resolve();
  assert.equal((await run).status, 'EXECUTED');
  assert.equal((await env.svc.runApproved(id, ALICE)).code, 'ALREADY_USED');
  assert.equal(env.writes().length, 6);
});

for (const mutation of ['transition', 'destination', 'project']) {
  test(`approval rejects a changed resolved ${mutation}, even with the same risk code`, async () => {
    const env = await setup({ policy: { allowedProjects: ['DEMO', 'OPS'] } });
    const id = await approved(env, 'jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Finish' });
    if (mutation === 'transition') env.jira.state.transitions[2].id = '32';
    if (mutation === 'destination') env.jira.state.transitions[2].to = { id: '4', name: 'Closed' };
    if (mutation === 'project') env.jira.state.issues['DEMO-1'].project = 'OPS';
    assert.equal((await env.svc.runApproved(id, ALICE)).code, 'FINGERPRINT_MISMATCH');
    assert.equal(env.writes().length, 0);
  });
}

test('create approvals bind to the resolved project ID', async () => {
  const env = await setup({ policy: { operations: { 'jira.issue.create': 'approve' } } });
  const id = await approved(env, 'jira.issue.create', { projectKey: 'DEMO', summary: 'review fixture' });
  env.jira.state.projects.DEMO.id = '101';
  assert.equal((await env.svc.runApproved(id, ALICE)).code, 'FINGERPRINT_MISMATCH');
  assert.equal(env.writes().length, 0);
});

test('create writes use the verified project ID', async () => {
  const env = await setup();
  assert.equal((await env.svc.guardedChange('jira.issue.create', { projectKey: 'DEMO', summary: 'review fixture' }, ALICE)).status, 'EXECUTED');
  assert.deepEqual(env.writes()[0].body.fields.project, { id: '100' });
});

test('reused issue key cannot redirect an approval to another issue', async () => {
  const env = await setup();
  const id = await approved(env);
  env.jira.state.issues['DEMO-1'] = { id: '90000', project: 'DEMO', status: 'To Do' };
  assert.equal((await env.svc.runApproved(id, ALICE)).code, 'DENIED_NOW');
  assert.equal(env.writes().length, 0);
});

test('aliases are deduplicated by Jira issue ID and writes use that ID', async () => {
  const env = await setup();
  env.jira.state.issues['DEMO-2'] = env.jira.state.issues['DEMO-1'];
  env.jira.state.issues['DEMO-1'].key = 'DEMO-1';
  assert.equal((await env.svc.guardedChange('jira.issue.comment', { ...comment, issueKeys: 'DEMO-1,DEMO-2' }, ALICE)).status, 'EXECUTED');
  assert.equal(env.writes().length, 1);
  assert.equal(env.writes()[0].path, '/rest/api/3/issue/10000/comment');
});

test('ambiguous and missing transition destinations are refused', async () => {
  for (const variant of ['ambiguous', 'missing destination']) {
    const env = await setup();
    if (variant === 'ambiguous') env.jira.state.transitions.push({ id: '99', name: 'Finish', to: { id: '3', name: 'Done' } });
    else delete env.jira.state.transitions[2].to;
    const result = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'Finish' }, ALICE);
    assert.equal(result.status, 'INVALID');
    assert.equal(env.writes().length, 0);
  }
});

for (const stage of ['resolution', 'reservation']) {
  test(`approval expiry during ${stage} is rechecked before writing`, async () => {
    const env = await setup({ policy: { approvalTtlMinutes: 1 } });
    const id = await approved(env);
    const method = stage === 'resolution' ? 'resolve' : 'reserveAndAudit';
    const original = env.svc[method].bind(env.svc);
    env.svc[method] = async (...args) => { const result = await original(...args); env.advance(60_000); return result; };
    assert.equal((await env.svc.runApproved(id, ALICE)).code, 'EXPIRED');
    assert.equal(env.writes().length, 0);
  });
}

test('approval expiry is rechecked after checking human permissions', async () => {
  const env = await setup({ policy: { approvalTtlMinutes: 1 } });
  const pending = await env.svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  env.jira.client.isJiraAdmin = async () => { env.advance(60_000); return true; };
  assert.equal((await env.svc.decideRequest(pending.approvalId, true, '', BOB)).code, 'EXPIRED');
});

for (const newPolicy of [{ approvers: [ALICE] }, { requireDistinctApprover: true }]) {
  test(`approval authority changes invalidate older decisions: ${JSON.stringify(newPolicy)}`, async () => {
    const env = await setup({ policy: { approvers: [BOB], requireDistinctApprover: false } });
    const id = await approved(env);
    const { policy } = await env.repo.loadPolicy();
    await env.repo.savePolicy({ ...policy, ...newPolicy });
    assert.equal((await env.svc.runApproved(id, ALICE)).code, 'AUTHORITY_CHANGED');
    assert.equal(env.writes().length, 0);
  });
}

test('invalid stored booleans fail closed and cannot silently unpause writes', async () => {
  const env = await setup();
  const pending = await env.svc.guardedChange('jira.issue.delete', { issueKeys: 'DEMO-1' }, ALICE);
  const { policy } = await env.repo.loadPolicy();
  await env.store.set('policy', { ...policy, agentWritesPaused: 'true' });
  const result = await env.svc.guardedChange('jira.issue.comment', comment, ALICE);
  assert.equal(result.status, 'DENIED');
  assert.ok(result.reasons.some((r) => r.code === 'POLICY_INVALID'));
  assert.equal((await env.svc.decideRequest(pending.approvalId, true, '', BOB)).code, 'POLICY_INVALID');
  assert.equal(env.writes().length, 0);
});

test('invalid stored usage cannot lower the effective caps', async () => {
  for (const value of [-1000, '0', false, null]) {
    const env = await setup();
    // MemoryStore rejects null writes just like the SDK, but model corrupted data.
    const key = env.repo.usageKeys(ALICE, Date.UTC(2026, 10, 2, 9), 'UTC').actorHour;
    env.store.map.set(key, JSON.stringify(value));
    assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).code, 'USAGE_INVALID');
    assert.equal(env.writes().length, 0);
  }
});

test('usage and audit failures before dispatch send no Jira writes', async () => {
  for (const prefix of ['usage:a:', 'usage:s:', 'audit:', 'auditu:']) {
    const env = await setup();
    const set = env.store.set.bind(env.store);
    env.store.set = async (key, ...args) => { if (key.startsWith(prefix)) throw new Error('storage unavailable'); return set(key, ...args); };
    await assert.rejects(env.svc.guardedChange('jira.issue.comment', comment, ALICE), /storage unavailable/);
    assert.equal(env.writes().length, 0);
  }
});

test('lost Jira response leaves reserved usage and an audit intent', async () => {
  const env = await setup({ policy: { perActorHourlyLimit: 1 } });
  const send = env.jira.client.addComment.bind(env.jira.client);
  env.jira.client.addComment = async (...args) => { await send(...args); throw new Error('response lost'); };
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).status, 'FAILED');
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).status, 'PENDING_APPROVAL');
  assert.equal(env.writes().length, 1);
  assert.ok((await env.repo.listAudit()).some((entry) => entry.outcome === 'EXECUTION_STARTED'));
});

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0); // setup() clock
const lockKey = (ms, offset = 0) => `mutation-lock:${Math.floor(ms / LOCK_BUCKET_MS) + offset}`;

test('a crashed lease blocks only until the next lock bucket', async () => {
  const env = await setup();
  // Crashed caller in the current bucket; its key never goes away (KVS may not sweep it for 48 h).
  await env.store.set(lockKey(T0), { owner: 'crashed', expiresAt: T0 + LOCK_LEASE_MS });
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).code, 'BUSY');
  assert.equal(env.writes().length, 0);
  env.advance(LOCK_BUCKET_MS);
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).status, 'EXECUTED');
  assert.ok(await env.store.get(lockKey(T0)), 'the crashed key is left alone, never deleted');
});

test('a live lease in an adjacent bucket blocks, and the backing-off caller releases its own key', async () => {
  for (const offset of [-1, 1]) {
    const env = await setup();
    await env.store.set(lockKey(T0, offset), { owner: 'other', expiresAt: Number.MAX_SAFE_INTEGER });
    assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).code, 'BUSY');
    assert.equal(await env.store.get(lockKey(T0)), undefined);
    assert.equal(env.writes().length, 0);
  }
});

test('an expired lease in the previous bucket and a legacy single lock key do not block', async () => {
  const env = await setup();
  await env.store.set(lockKey(T0, -1), { owner: 'crashed', expiresAt: T0 - 1 });
  await env.store.set('mutation-lock', { held: true });
  assert.equal((await env.svc.guardedChange('jira.issue.comment', comment, ALICE)).status, 'EXECUTED');
});

test('release never deletes a lease that is not ours', async () => {
  const env = await setup();
  await env.repo.withMutation(async () => {
    await env.store.set(lockKey(0), { owner: 'other', expiresAt: Number.MAX_SAFE_INTEGER });
  }, 0);
  assert.equal((await env.store.get(lockKey(0))).owner, 'other');
});

test('callers straddling a bucket boundary never both run', async () => {
  const env = await setup();
  const entered = deferred();
  const release = deferred();
  const late = LOCK_BUCKET_MS * 10 - 1; // last millisecond of a bucket
  const first = env.repo.withMutation(async () => { entered.resolve(); await release.promise; }, late);
  await entered.promise;
  await assert.rejects(env.repo.withMutation(async () => assert.fail('second caller ran'), late + 2), /another gate mutation/);
  release.resolve();
  await first;
});

test('Forge function context.principal.accountId is the acting user', async () => {
  const env = await setup();
  const h = makeHandlers(() => env.svc);
  // Documented shape for plain Forge functions (Rovo actions, MCP tools).
  assert.equal(actorFrom({ ...comment, accountId: BOB }, { principal: { accountId: ALICE }, installContext: 'ari:x' }), ALICE);
  assert.equal((await h.commentIssues(comment, { principal: { accountId: ALICE } })).status, 'EXECUTED');
});

