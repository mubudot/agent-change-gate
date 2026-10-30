// Orchestration: build op -> resolve against Jira -> gate -> execute / queue for approval -> audit.
// All dependencies are injected so the whole flow runs in unit tests without Forge.
import { buildOperation } from './policy/ops.js';
import { evaluate, Verdict } from './policy/gate.js';
import { fingerprintOperation, canonicalJson } from './policy/fingerprint.js';
import { createRequest, decide, claim, finish, withExpiry, GateError, Status } from './policy/approvals.js';
import { clone } from './policy/policy.js';
import { resolveOperation, executeOperation, outcomeOf } from './jira/executor.js';

// Approval reasons a human approval is allowed to cover at run time even if their
// exact numbers changed (usage moves between request and execution).
const RATE_CODES = new Set(['HOURLY_LIMIT', 'DAILY_LIMIT', 'SITE_DAILY_LIMIT']);

export class GateService {
  /**
   * @param {{repo: import('./store/repo.js').Repo, jira: import('./jira/client.js').JiraClient,
   *          now?: () => number, newId?: () => string}} deps
   */
  constructor({ repo, jira, now = () => Date.now(), newId }) {
    this.repo = repo;
    this.jira = jira;
    this.now = now;
    this.newId = newId ?? (() => globalThis.crypto.randomUUID());
  }

  /** Main entry for every guarded write action. */
  async guardedChange(kind, input, actor, { preview = false } = {}) {
    return this.mutate(actor, () => this.change(kind, input, actor, { preview }));
  }

  async change(kind, input, actor, { preview }) {
    if (!actor) return out('INVALID', { errors: ['no user context: actions must run on behalf of a signed-in user'] });
    const { op, errors } = buildOperation(kind, input);
    if (!op) return out('INVALID', { errors });

    const { policy, errors: policyErrors } = await this.repo.loadPolicy();

    // Do not spend Jira reads on calls the gate will reject on size alone.
    let plan = { transitionIds: {} };
    let resolveErrors = [];
    if (op.targets.length <= policy.maxTargetsPerCall) {
      ({ plan, errors: resolveErrors } = await this.resolve(op));
    }
    if (resolveErrors.length) return out('INVALID', { errors: resolveErrors });

    const now = this.now();
    const usage = await this.repo.getUsage(actor, now, policy.timezone);
    const decision = evaluate(policy, op, usage, { policyErrors });
    const fingerprint = fingerprintOperation(op);
    const base = { verdict: decision.verdict, reasons: decision.reasons };

    if (preview) return out('PREVIEW', { ...base, message: previewMessage(decision) });

    if (decision.verdict === Verdict.DENY) {
      await this.audit({ actor, op, verdict: decision.verdict, outcome: 'DENIED', reasons: decision.reasons });
      return out('DENIED', { ...base, message: 'The change guard blocked this change. Tell the user why; do not retry with a workaround.' });
    }

    if (decision.verdict === Verdict.NEEDS_APPROVAL) {
      const existing = await this.repo.findPending(actor, fingerprint, now);
      const req =
        existing ??
        createRequest({
          id: this.newId(),
          op: clone(op),
          fingerprint,
          requester: actor,
          reasons: decision.reasons,
          now,
          ttlMinutes: policy.approvalTtlMinutes,
        });
      if (!existing) {
        await this.repo.saveRequest(req);
        await this.audit({ actor, op, verdict: decision.verdict, outcome: 'QUEUED', reasons: decision.reasons, approvalId: req.id });
      }
      return out('PENDING_APPROVAL', {
        ...base,
        approvalId: req.id,
        expiresAt: new Date(req.expiresAt).toISOString(),
        message:
          'Nothing was changed. A human approver must approve this request on the Agent Change Gate page in Jira (Apps menu). ' +
          `After approval, call run-approved-change with approvalId ${req.id}.`,
      });
    }

    await this.reserveAndAudit(actor, op, policy, decision.verdict, []);
    const results = await this.execute(op, plan);
    const { outcome } = outcomeOf(results);
    await this.audit({ actor, op, verdict: decision.verdict, outcome, reasons: [], results });
    return out(outcome, { ...base, results });
  }

  /** Run a request a human approved. Single use, requester only, same operation only. */
  async runApproved(approvalId, actor) {
    return this.mutate(actor, () => this.run(approvalId, actor));
  }

  async run(approvalId, actor) {
    if (!actor) return out('INVALID', { errors: ['no user context'] });
    const stored = await this.repo.getRequest(approvalId);
    if (!stored) return out('INVALID', { errors: [`no approval request '${approvalId}'`] });
    const now = this.now();
    const { policy, errors: policyErrors } = await this.repo.loadPolicy();

    let req;
    try {
      req = claim(stored, { actor, fingerprint: fingerprintOperation(stored.op), now });
    } catch (e) {
      if (e instanceof GateError) {
        if (e.code === 'EXPIRED' && stored.status !== Status.EXPIRED) await this.repo.saveRequest({ ...stored, status: Status.EXPIRED });
        return out('REFUSED', { code: e.code, message: e.message, approvalStatus: withExpiry(stored, now).status });
      }
      throw e;
    }

    // Re-check against Jira and the CURRENT policy: approval never overrides a DENY,
    // and a new kind of risk needs a new approval.
    const op = clone(stored.op);
    const { plan, errors: resolveErrors } = await this.resolve(op);
    const usage = await this.repo.getUsage(actor, now, policy.timezone);
    const decision = resolveErrors.length
      ? { verdict: Verdict.DENY, reasons: resolveErrors.map((m) => ({ code: 'RESOLVE_FAILED', message: m })) }
      : evaluate(policy, op, usage, { policyErrors });
    // A change to the authority configuration invalidates old decisions, including
    // approvals made with a previously disabled two-person rule.
    if (stored.approvalAuthority !== approvalAuthority(policy)) {
      await this.repo.saveRequest(finish(req, { ok: false, result: { refused: 'AUTHORITY_CHANGED' }, now: this.now() }));
      return out('REFUSED', { code: 'AUTHORITY_CHANGED', message: 'approval authority changed; request a new approval' });
    }
    const approvedCodes = new Set(stored.reasons.map((r) => r.code));
    const newRisks = decision.reasons.filter((r) => !approvedCodes.has(r.code) && !RATE_CODES.has(r.code));
    if (decision.verdict === Verdict.DENY || newRisks.length) {
      const reasons = decision.verdict === Verdict.DENY ? decision.reasons : newRisks;
      const failed = finish(req, { ok: false, result: { refused: reasons }, now });
      await this.repo.saveRequest(failed);
      await this.audit({ actor, op, verdict: decision.verdict, outcome: 'REFUSED_AT_RUN', reasons, approvalId });
      return out('REFUSED', {
        code: decision.verdict === Verdict.DENY ? 'DENIED_NOW' : 'NEW_RISK',
        reasons,
        message: 'The situation changed since approval; nothing was changed. Ask the user whether to request a new approval.',
      });
    }

    // Resolution may have taken minutes, or Jira may now map the requested name
    // to a different transition. Recheck BOTH the expiry and resolved fingerprint.
    try {
      req = claim(stored, { actor, fingerprint: fingerprintOperation(op), now: this.now() });
    } catch (e) {
      if (!(e instanceof GateError)) throw e;
      if (e.code === 'EXPIRED') await this.repo.saveRequest(withExpiry(stored, this.now()));
      return out('REFUSED', { code: e.code, message: e.message });
    }
    if (!(await this.repo.claimExecution(approvalId, actor, this.now()))) {
      return out('REFUSED', { code: 'ALREADY_USED', message: 'this approval was already used' });
    }
    await this.repo.saveRequest(req);
    await this.reserveAndAudit(actor, op, policy, 'APPROVED', stored.reasons, approvalId);
    if (this.now() >= stored.expiresAt) {
      await this.repo.saveRequest(withExpiry(stored, this.now()));
      return out('REFUSED', { code: 'EXPIRED', message: 'approval expired before execution' });
    }
    const results = await this.execute(op, plan);
    const { outcome } = outcomeOf(results);
    const done = finish(req, { ok: outcome === 'EXECUTED', result: { results }, now: this.now() });
    await this.repo.saveRequest(done);
    await this.audit({ actor, op, verdict: 'APPROVED', outcome, reasons: stored.reasons, approvalId, results });
    return out(outcome, { approvalId, approvedBy: stored.decidedBy, results });
  }

  async approvalStatus(approvalId, actor) {
    const req = await this.repo.getRequest(approvalId);
    if (!req || req.requester !== actor) return out('INVALID', { errors: [`no approval request '${approvalId}' for you`] });
    const r = withExpiry(req, this.now());
    return out('OK', {
      approvalId,
      approvalStatus: r.status,
      reasons: r.reasons,
      decisionNote: r.decisionNote,
      expiresAt: new Date(r.expiresAt).toISOString(),
    });
  }

  // ---------- approver / admin side (UI resolvers) ----------

  async isApprover(actor, policy) {
    if (!actor) return false;
    if (policy.approvers.length) return policy.approvers.includes(actor);
    return this.jira.isJiraAdmin();
  }

  async decideRequest(approvalId, approve, note, actor) {
    return this.mutate(actor, () => this.decide(approvalId, approve, note, actor));
  }

  async decide(approvalId, approve, note, actor) {
    const req = await this.repo.getRequest(approvalId);
    if (!req) return out('INVALID', { errors: ['request not found'] });
    const { policy, errors } = await this.repo.loadPolicy();
    if (errors.length) return out('REFUSED', { code: 'POLICY_INVALID', message: 'fix the stored policy before deciding requests' });
    const isApprover = await this.isApprover(actor, policy);
    try {
      const decided = decide(req, {
        approver: actor,
        approve: approve === true,
        note,
        now: this.now(),
        isApprover,
        requireDistinctApprover: policy.requireDistinctApprover,
      });
      decided.approvalAuthority = approvalAuthority(policy);
      await this.repo.saveRequest(decided);
      await this.audit({
        actor,
        op: req.op,
        verdict: decided.status,
        outcome: decided.status === Status.APPROVED ? 'APPROVED_BY_HUMAN' : 'REJECTED_BY_HUMAN',
        reasons: req.reasons,
        approvalId,
      });
      return out('OK', { approvalStatus: decided.status });
    } catch (e) {
      if (e instanceof GateError) {
        if (e.code === 'EXPIRED') await this.repo.saveRequest({ ...req, status: Status.EXPIRED });
        return out('REFUSED', { code: e.code, message: e.message });
      }
      throw e;
    }
  }

  async dashboard(actor) {
    if (!actor) throw new GateError('NO_USER', 'no user context');
    const { policy, errors } = await this.repo.loadPolicy();
    const approver = await this.isApprover(actor, policy);
    const isAdmin = await this.jira.isJiraAdmin();
    const now = this.now();
    const visible = await this.repo.listOpenRequests(50, now, approver || isAdmin ? undefined : actor);
    return {
      actor,
      isApprover: approver,
      isAdmin,
      policy,
      policyErrors: errors,
      requests: visible,
      audit: approver || isAdmin ? await this.repo.listAudit(50) : await this.repo.listAuditForActor(actor, 50),
      siteUsageToday: (await this.repo.getUsage('-', now, policy.timezone)).siteDay,
    };
  }

  async savePolicy(input, actor) {
    return this.mutate(actor, () => this.updatePolicy(input, actor));
  }

  async updatePolicy(input, actor) {
    if (!(await this.jira.isJiraAdmin())) return out('REFUSED', { code: 'NOT_ADMIN', message: 'only Jira administrators can change the policy' });
    const res = await this.repo.savePolicy(input);
    if (!res.ok) return out('INVALID', { errors: res.errors });
    await this.audit({ actor, op: { kind: 'policy.update', targets: [] }, verdict: 'ADMIN', outcome: 'POLICY_SAVED', reasons: [] });
    return out('OK', { policy: res.policy });
  }

  async myActivity(actor) {
    if (!actor) return out('INVALID', { errors: ['no user context'] });
    return out('OK', { entries: await this.repo.listAuditForActor(actor, 20) });
  }

  async policySummary() {
    const { policy, errors } = await this.repo.loadPolicy();
    const { approvers, ...rest } = policy;
    return out('OK', { policy: { ...rest, approverCount: approvers.length || 'Jira administrators' }, policyErrors: errors });
  }

  // ---------- internals ----------

  async mutate(actor, work) {
    if (!actor) return out('INVALID', { errors: ['no user context'] });
    try {
      return await this.repo.withMutation(work, this.now());
    } catch (e) {
      if (!(e instanceof GateError)) throw e;
      return out('REFUSED', { code: e.code, message: e.message });
    }
  }

  async reserveAndAudit(actor, op, policy, verdict, reasons, approvalId) {
    // Count attempted targets before sending writes: a lost Jira response must
    // never buy an agent another uncounted write. Failed attempts are not refunded.
    await this.repo.addUsage(actor, this.now(), policy.timezone, op.targets.length);
    await this.audit({ actor, op, verdict, outcome: 'EXECUTION_STARTED', reasons, approvalId });
  }

  resolve(op) {
    return resolveOperation(op, this.jira);
  }

  execute(op, plan) {
    return executeOperation(op, plan, this.jira);
  }

  async audit({ actor, op, verdict, outcome, reasons, approvalId, results }) {
    await this.repo.appendAudit({
      id: this.newId(),
      at: this.now(),
      actor,
      kind: op.kind,
      targets: (op.targets ?? []).map((t) => t.issueKey ?? `new:${t.projectKey}`),
      verdict,
      outcome,
      codes: (reasons ?? []).map((r) => r.code),
      approvalId: approvalId ?? null,
      failed: results ? results.filter((r) => !r.ok).map((r) => r.key) : [],
    });
  }
}

function approvalAuthority(policy) {
  return canonicalJson({ approvers: [...policy.approvers].sort(), requireDistinctApprover: policy.requireDistinctApprover });
}

function previewMessage(d) {
  if (d.verdict === Verdict.ALLOW) return 'This change would run immediately.';
  if (d.verdict === Verdict.NEEDS_APPROVAL) return 'This change would need a human approval first.';
  return 'This change would be blocked.';
}

function out(status, rest = {}) {
  return { status, ...rest };
}
