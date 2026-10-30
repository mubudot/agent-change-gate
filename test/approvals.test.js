import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, decide, claim, finish, withExpiry, Status } from '../src/policy/approvals.js';

const base = () => createRequest({ id: 'r1', op: {}, fingerprint: 'fp', requester: 'alice', reasons: [], now: 0, ttlMinutes: 10 });
const ok = { approver: 'bob', approve: true, now: 1, isApprover: true, requireDistinctApprover: true };

test('approve then claim by requester with matching fingerprint', () => {
  const r = decide(base(), ok);
  assert.equal(r.status, Status.APPROVED);
  const c = claim(r, { actor: 'alice', fingerprint: 'fp', now: 2 });
  assert.equal(c.status, Status.EXECUTING);
  assert.equal(finish(c, { ok: true, result: {}, now: 3 }).status, Status.EXECUTED);
});

test('two-person rule blocks self approval but allows self rejection', () => {
  assert.throws(() => decide(base(), { ...ok, approver: 'alice' }), { code: 'SELF_APPROVAL' });
  assert.equal(decide(base(), { ...ok, approver: 'alice', approve: false }).status, Status.REJECTED);
  assert.equal(decide(base(), { ...ok, approver: 'alice', requireDistinctApprover: false }).status, Status.APPROVED);
});

test('non-approver cannot decide', () => {
  assert.throws(() => decide(base(), { ...ok, isApprover: false }), { code: 'NOT_APPROVER' });
});

test('cannot decide twice', () => {
  assert.throws(() => decide(decide(base(), ok), ok), { code: 'NOT_PENDING' });
});

test('claim guards: pending, other user, other operation, rejected, used', () => {
  assert.throws(() => claim(base(), { actor: 'alice', fingerprint: 'fp', now: 1 }), { code: 'NOT_APPROVED_YET' });
  const r = decide(base(), ok);
  assert.throws(() => claim(r, { actor: 'mallory', fingerprint: 'fp', now: 2 }), { code: 'NOT_REQUESTER' });
  assert.throws(() => claim(r, { actor: 'alice', fingerprint: 'other', now: 2 }), { code: 'FINGERPRINT_MISMATCH' });
  assert.throws(() => claim(decide(base(), { ...ok, approve: false }), { actor: 'alice', fingerprint: 'fp', now: 2 }), { code: 'REJECTED' });
  const used = finish(claim(r, { actor: 'alice', fingerprint: 'fp', now: 2 }), { ok: true, now: 3 });
  assert.throws(() => claim(used, { actor: 'alice', fingerprint: 'fp', now: 4 }), { code: 'ALREADY_USED' });
});

test('expiry applies to pending and approved requests', () => {
  assert.equal(withExpiry(base(), 600_000).status, Status.EXPIRED);
  assert.throws(() => decide(base(), { ...ok, now: 600_000 }), { code: 'EXPIRED' });
  const r = decide(base(), ok);
  assert.throws(() => claim(r, { actor: 'alice', fingerprint: 'fp', now: 600_001 }), { code: 'EXPIRED' });
});
