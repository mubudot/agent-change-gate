// Approval request state machine. Pure: every function returns a new object or
// throws a GateError. Storage and clocks are the caller's job.
//
// PENDING --approve--> APPROVED --claim--> EXECUTING --> EXECUTED | FAILED
//    |                    |
//    +--reject--> REJECTED +--(ttl)--> EXPIRED      (PENDING can also expire)

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const Status = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  FAILED: 'FAILED',
});

const TERMINAL = new Set([Status.REJECTED, Status.EXPIRED, Status.EXECUTED, Status.FAILED]);

export function createRequest({ id, op, fingerprint, requester, reasons, now, ttlMinutes }) {
  if (!id || !requester || !fingerprint) throw new GateError('BAD_REQUEST', 'id, requester and fingerprint are required');
  return {
    id,
    status: Status.PENDING,
    op,
    fingerprint,
    requester,
    reasons,
    createdAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    result: null,
  };
}

/** Apply expiry lazily: PENDING/APPROVED past expiresAt become EXPIRED. */
export function withExpiry(req, now) {
  if ((req.status === Status.PENDING || req.status === Status.APPROVED) && now >= req.expiresAt) {
    return { ...req, status: Status.EXPIRED };
  }
  return req;
}

/**
 * @param {object} req
 * @param {{approver:string, approve:boolean, note?:string, now:number,
 *          isApprover:boolean, requireDistinctApprover:boolean}} d
 */
export function decide(req, d) {
  const r = withExpiry(req, d.now);
  if (r.status === Status.EXPIRED) throw new GateError('EXPIRED', 'request has expired');
  if (r.status !== Status.PENDING) throw new GateError('NOT_PENDING', `request is ${r.status}, not PENDING`);
  if (!d.isApprover) throw new GateError('NOT_APPROVER', 'you are not an approver for agent changes');
  if (d.approve && d.requireDistinctApprover && d.approver === r.requester) {
    throw new GateError('SELF_APPROVAL', 'two-person rule: the requester cannot approve their own request');
  }
  return {
    ...r,
    status: d.approve ? Status.APPROVED : Status.REJECTED,
    decidedBy: d.approver,
    decidedAt: d.now,
    decisionNote: typeof d.note === 'string' ? d.note.slice(0, 500) : null,
  };
}

/**
 * Validate that `actor` may run approved request `req` for operation fingerprint `fp`.
 * Returns the request moved to EXECUTING. The caller must also win an atomic
 * single-use claim in storage before executing.
 */
export function claim(req, { actor, fingerprint, now }) {
  const r = withExpiry(req, now);
  if (r.status === Status.EXPIRED) throw new GateError('EXPIRED', 'approval has expired');
  if (r.status === Status.PENDING) throw new GateError('NOT_APPROVED_YET', 'request is still waiting for a human');
  if (r.status === Status.REJECTED) throw new GateError('REJECTED', 'request was rejected');
  if (r.status !== Status.APPROVED) throw new GateError('ALREADY_USED', `request is ${r.status}; approvals are single-use`);
  if (actor !== r.requester) throw new GateError('NOT_REQUESTER', 'only the user who requested the change can run it');
  if (fingerprint !== r.fingerprint) {
    throw new GateError('FINGERPRINT_MISMATCH', 'the operation differs from what was approved');
  }
  return { ...r, status: Status.EXECUTING };
}

export function finish(req, { ok, result, now }) {
  if (req.status !== Status.EXECUTING) throw new GateError('NOT_EXECUTING', `request is ${req.status}`);
  return { ...req, status: ok ? Status.EXECUTED : Status.FAILED, executedAt: now, result };
}

export function isTerminal(req) {
  return TERMINAL.has(req.status);
}
