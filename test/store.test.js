import test from 'node:test';
import assert from 'node:assert/strict';
import { KvsStore } from '../src/store/kvs.js';
import { Repo } from '../src/store/repo.js';
import { MemoryStore } from '../src/store/memory.js';
import { createRequest } from '../src/policy/approvals.js';
import { setup, ALICE } from './helpers.js';

const request = (id, now, requester = ALICE) => createRequest({
  id, op: { kind: 'jira.issue.delete', targets: [], payload: {} }, fingerprint: id,
  requester, reasons: [], now, ttlMinutes: 1,
});

test('KVS adapter sends supported conflict and TTL options; conflict never becomes success', async () => {
  const calls = [];
  let error;
  const store = new KvsStore({ set: async (...args) => { calls.push(args); if (error) throw error; } });
  assert.equal(await store.set('fixture', { value: 1 }, { failIfExists: true, ttlSeconds: 60 }), true);
  assert.deepEqual(calls[0], ['fixture', { value: 1 }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'SECONDS', value: 60 } }]);
  error = { status: 409 };
  assert.equal(await store.set('fixture', {}, { failIfExists: true }), false);
  error = new Error('storage unavailable');
  await assert.rejects(store.set('fixture', {}, { failIfExists: true }), /storage unavailable/);
  error = { code: 'KEY_ALREADY_EXISTS' };
  assert.equal(await store.set('fixture', {}, { failIfExists: true }), false);
  await assert.rejects(store.set('fixture', {}));
});

test('KVS prefix query uses beginsWith and forwards pagination cursors', async () => {
  const calls = [];
  const query = {
    where: (...args) => { calls.push(['where', ...args]); return query; },
    limit: (...args) => { calls.push(['limit', ...args]); return query; },
    cursor: (...args) => { calls.push(['cursor', ...args]); return query; },
    getMany: async () => ({ results: [{ key: 'open:fixture', value: 1 }], nextCursor: 'next-page' }),
  };
  const store = new KvsStore({ query: () => query }, { beginsWith: (prefix) => ({ beginsWith: prefix }) });
  assert.deepEqual(await store.listPage('open:', 50, 'page-two'), {
    results: [{ key: 'open:fixture', value: 1 }], nextCursor: 'next-page',
  });
  assert.deepEqual(calls, [['where', 'key', { beginsWith: 'open:' }], ['limit', 50], ['cursor', 'page-two']]);
});

test('single-use claims never expire; the mutation lock is a bounded lease', async () => {
  const memory = new MemoryStore();
  const calls = [];
  const set = memory.set.bind(memory);
  memory.set = async (...args) => { calls.push(args); return set(...args); };
  const repo = new Repo(memory);
  assert.equal(await repo.claimExecution('id-fixture', ALICE, 0), true);
  assert.equal(await repo.claimExecution('id-fixture', ALICE, 1), false);
  for (const call of calls) assert.deepEqual(call[2], { failIfExists: true });
  calls.length = 0;
  await repo.withMutation(async () => {});
  assert.deepEqual(calls[0][2], { failIfExists: true, ttlSeconds: 240 });
  assert.match(calls[0][0], /^mutation-lock:\d+$/);
});

test('expired requests and other actors do not starve visible requests beyond the first page', async () => {
  const repo = new Repo(new MemoryStore());
  for (let i = 0; i < 110; i++) {
    await repo.saveRequest(request(`id-${String(i).padStart(6, '0')}`, i < 60 ? 0 : 60_000, 'acct-other'));
  }
  await repo.saveRequest(request('id-999999', 60_000));
  const visible = await repo.listOpenRequests(50, 60_001, ALICE);
  assert.deepEqual(visible.map((r) => r.id), ['id-999999']);
  const all = await repo.listOpenRequests(100, 60_001);
  assert.equal(all.length, 51);
  assert.ok(all.every((r) => r.expiresAt > 60_001));
});

test('pending deduplication uses point lookups even when index queries are stale', async () => {
  const env = await setup();
  const input = { issueKeys: 'DEMO-1' };
  const first = await env.svc.guardedChange('jira.issue.delete', input, ALICE);
  env.store.listPage = async () => ({ results: [] });
  const again = await env.svc.guardedChange('jira.issue.delete', input, ALICE);
  assert.equal(again.approvalId, first.approvalId);
  env.advance(86400_000);
  const fresh = await env.svc.guardedChange('jira.issue.delete', input, ALICE);
  assert.notEqual(fresh.approvalId, first.approvalId);
  const old = await env.repo.getRequest(first.approvalId);
  await env.repo.saveRequest({ ...old, status: 'EXPIRED' });
  assert.equal((await env.svc.guardedChange('jira.issue.delete', input, ALICE)).approvalId, fresh.approvalId);
});

test('null stored policy is reported as invalid rather than silently defaulted', async () => {
  const store = new MemoryStore();
  store.map.set('policy', 'null');
  assert.ok((await new Repo(store).loadPolicy()).errors.length);
});

test('personal audit prefixes isolate account IDs containing the storage delimiter', async () => {
  const repo = new Repo(new MemoryStore());
  const entry = { at: 1, kind: 'jira.issue.comment', outcome: 'EXECUTED' };
  await repo.appendAudit({ ...entry, id: 'id-000001', actor: 'acct-fixture' });
  await repo.appendAudit({ ...entry, id: 'id-000002', actor: 'acct-fixture:other' });
  assert.deepEqual((await repo.listAuditForActor('acct-fixture')).map((e) => e.id), ['id-000001']);
  assert.deepEqual((await repo.listAuditForActor('acct-fixture:other')).map((e) => e.id), ['id-000002']);
});

test('KVS FAIL_IF_EXISTS conflicts are read from the SDK error shape', async () => {
  const err = Object.assign(new Error('boom'), { code: 'SOMETHING', responseDetails: { status: 409 } });
  const store = new KvsStore({ set: async () => { throw err; } }, {});
  assert.equal(await store.set('k', 1, { failIfExists: true }), false);
  await assert.rejects(store.set('k', 1), /boom/);
});


test('complete approval byte limit includes escaped text and all 200 resolved targets', async () => {
  const store = new MemoryStore();
  const repo = new Repo(store);
  const req = request('id-000001', 0);
  req.op = {
    kind: 'jira.issue.comment',
    payload: { body: '\u0001'.repeat(32000) },
    targets: Array.from({ length: 200 }, (_, i) => ({
      issueKey: `ABCDEFGHIJ-${1000000000 + i}`, projectKey: 'ABCDEFGHIJ',
      issueId: String(10000 + i), projectId: '10000', currentStatus: '界'.repeat(255),
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(req)) > 240 * 1024);
  await assert.rejects(repo.saveRequest(req), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(await store.get(`req:${req.id}`), undefined);
  assert.equal(await store.get(`open:${req.id}`), undefined);
  req.op.payload.body = '界'.repeat(32000);
  req.op.targets.forEach((t) => { t.currentStatus = 'To Do'; });
  await repo.saveRequest(req);
  assert.ok(Buffer.byteLength(JSON.stringify(await repo.getRequest(req.id))) < 240 * 1024);
});
