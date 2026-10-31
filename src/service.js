// Orchestration: build op -> resolve against Jira -> gate -> execute / queue for approval -> audit.
// All dependencies are injected so the whole flow runs in unit tests without Forge.
import { buildOperation } from './policy/ops.js';
import { evaluate, Verdict } from './policy/gate.js';
import { fingerprintOperation, canonicalJson } from './policy/fingerprint.js';
import { createRequest, decide, claim, finish, withExpiry, GateError, Status } from './policy/approvals.js';
import { clone } from './policy/policy.js';
import { resolveOperation, executeOperation, outcomeOf } from './jira/executor.js';
import { graphForSimulation, jiraForSimulation, simulateRequest, runSimulatedRequest } from './simulation/simulator.js';
import { EMPTY_CONTEXT, collectContext, contextApplies, signalKey } from './context/collector.js';
import { parseIssueKeys } from './policy/ops.js';
import { approvalPlace } from './rovo/links.js';

// Approval reasons a human approval is allowed to cover at run time even if their
// exact numbers changed (usage moves between request and execution).
const RATE_CODES = new Set(['HOURLY_LIMIT', 'DAILY_LIMIT', 'SITE_DAILY_LIMIT']);

export class GateService {
  /**
   * @param {{repo: import('./store/repo.js').Repo, jira: import('./jira/client.js').JiraClient,
   *          graph?: import('./context/graph-client.js').TeamworkGraphClient,
   *          now?: () => number, newId?: () => string, approvalPage?: () => string | null}} deps
   *   approvalPage: site-relative path of the approval page (from the Forge app context), or null.
   */
  constructor({ repo, jira, graph = null, now = () => Date.now(), newId, approvalPage = () => null }) {
    this.repo = repo;
    this.jira = jira;
    this.graph = graph;
    this.approvalPage = approvalPage;
    this.now = now;
    this.newId = newId ?? (() => globalThis.crypto.randomUUID());
  }

  /** Same repo, clock and ids, different Jira (and graph) client (used for dry-run simulations). */
  withJira(jira, graph = this.graph) {
    return new GateService({ repo: this.repo, jira, graph, now: this.now, newId: this.newId, approvalPage: this.approvalPage });
  }

  /**
   * Main entry for every guarded write action.
   * origin.source is 'agent' for Rovo/MCP calls and 'simulated' for the admin demo panel.
   */
  async guardedChange(kind, input, actor, { preview = false, origin = AGENT } = {}) {
    return this.mutate(actor, () => this.change(kind, input, actor, { preview, origin }));
  }

  async change(kind, input, actor, { preview, origin = AGENT }) {
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
    const context = op.targets.length <= policy.maxTargetsPerCall ? await this.context(op, plan, policy) : EMPTY_CONTEXT;
    const usage = await this.repo.getUsage(actor, now, policy.timezone);
    const decision = evaluate(policy, op, usage, { policyErrors, context });
    const fingerprint = fingerprintOperation(op);
    const base = { verdict: decision.verdict, reasons: decision.reasons, ...contextView(context) };

    if (preview) return out('PREVIEW', { ...base, message: previewMessage(decision) });

    if (decision.verdict === Verdict.DENY) {
      await this.audit({ actor, op, verdict: decision.verdict, outcome: 'DENIED', reasons: decision.reasons, origin });
      return out('DENIED', { ...base, message: 'The change guard blocked this change. Tell the user why; do not retry with a workaround.' });
    }

    if (decision.verdict === Verdict.NEEDS_APPROVAL) {
      const pending = await this.repo.findPending(actor, fingerprint, now, origin);
      // Never fold a simulated request into a real agent request (or the reverse).
      const existing = pending && sameOrigin(pending, origin) ? pending : undefined;
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
        req.source = origin.source;
        if (context.checked) req.context = storedContext(context);
        if (origin.simulation) req.simulation = clone(origin.simulation);
        await this.repo.saveRequest(req);
        if (origin.simulation) await this.repo.indexSimulation(req.id, now);
        await this.audit({ actor, op, verdict: decision.verdict, outcome: 'QUEUED', reasons: decision.reasons, approvalId: req.id, origin });
      }
      const page = this.pagePath();
      return out('PENDING_APPROVAL', {
        ...base,
        approvalId: req.id,
        expiresAt: new Date(req.expiresAt).toISOString(),
        ...(page ? { approvalPage: page } : {}),
        message:
          `Nothing was changed. A human approver must approve this request on ${approvalPlace(page)}. ` +
          `After approval, call run-approved-change with approvalId ${req.id}.`,
      });
    }

    await this.reserveAndAudit(actor, op, policy, decision.verdict, [], undefined, origin);
    const results = await this.execute(op, plan);
    const { outcome } = outcomeOf(results);
    await this.audit({ actor, op, verdict: decision.verdict, outcome, reasons: [], results, origin });
    return out(outcome, { ...base, results, ...dryRunFlag(origin) });
  }

  /** Run a request a human approved. Single use, requester only, same operation only. */
  async runApproved(approvalId, actor) {
    return this.mutate(actor, () => this.run(approvalId, actor));
  }

  async run(approvalId, actor) {
    if (!actor) return out('INVALID', { errors: ['no user context'] });
    const stored = await this.repo.getRequest(approvalId);
    if (!stored) return out('INVALID', { errors: [`no approval request '${approvalId}'`] });
    if (stored.source === 'simulated') {
      // Simulations stay admin-only on every entry point (dashboard or Rovo/MCP run-approved-change),
      // checked with the real Jira client before any dry-run binding.
      if (this.jira.dryRun || !(await this.jira.isJiraAdmin())) {
        return out('REFUSED', { code: 'NOT_ADMIN', message: 'only Jira administrators can run simulated requests' });
      }
      // A dry-run simulation is bound to the dry-run client at creation, whichever entry point runs it.
      if (stored.simulation?.mode === 'dry-run') {
        return this.withJira(jiraForSimulation(stored.simulation, this.jira), graphForSimulation(stored.simulation, this.graph))
          .runStored(stored, approvalId, actor);
      }
    }
    return this.runStored(stored, approvalId, actor);
  }

  async runStored(stored, approvalId, actor) {
    const origin = originOf(stored);
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
    // Context is re-read too: an issue that joined a release or a goal since approval is a new risk.
    const context = resolveErrors.length ? EMPTY_CONTEXT : await this.context(op, plan, policy);
    const decision = resolveErrors.length
      ? { verdict: Verdict.DENY, reasons: resolveErrors.map((m) => ({ code: 'RESOLVE_FAILED', message: m })) }
      : evaluate(policy, op, usage, { policyErrors, context });
    // A change to the authority configuration invalidates old decisions, including
    // approvals made with a previously disabled two-person rule.
    if (stored.approvalAuthority !== approvalAuthority(policy)) {
      await this.repo.saveRequest(finish(req, { ok: false, result: { refused: 'AUTHORITY_CHANGED' }, now: this.now() }));
      return out('REFUSED', { code: 'AUTHORITY_CHANGED', message: 'approval authority changed; request a new approval' });
    }
    const newRisks = newRisksSince(stored, decision.reasons, context);
    if (decision.verdict === Verdict.DENY || newRisks.length) {
      const reasons = decision.verdict === Verdict.DENY ? decision.reasons : newRisks;
      const failed = finish(req, { ok: false, result: { refused: reasons }, now });
      await this.repo.saveRequest(failed);
      await this.audit({ actor, op, verdict: decision.verdict, outcome: 'REFUSED_AT_RUN', reasons, approvalId, origin });
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
    await this.reserveAndAudit(actor, op, policy, 'APPROVED', stored.reasons, approvalId, origin);
    if (this.now() >= stored.expiresAt) {
      await this.repo.saveRequest(withExpiry(stored, this.now()));
      return out('REFUSED', { code: 'EXPIRED', message: 'approval expired before execution' });
    }
    const results = await this.execute(op, plan);
    const { outcome } = outcomeOf(results);
    const done = finish(req, { ok: outcome === 'EXECUTED', result: { results }, now: this.now() });
    await this.repo.saveRequest(done);
    await this.audit({ actor, op, verdict: 'APPROVED', outcome, reasons: stored.reasons, approvalId, results, origin });
    return out(outcome, { approvalId, approvedBy: stored.decidedBy, results, ...dryRunFlag(origin) });
  }

  /**
   * Read-only: what the gate knows about issues before any change (Jira + Teamwork Graph context),
   * and what each signal would mean under the current policy. Writes nothing, takes no lock.
   */
  async issueContext(input, actor) {
    if (!actor) return out('INVALID', { errors: ['no user context'] });
    const errors = [];
    const keys = parseIssueKeys(input?.issueKeys, errors);
    if (errors.length) return out('INVALID', { errors });
    const { policy } = await this.repo.loadPolicy();
    if (keys.length > policy.maxTargetsPerCall) return out('INVALID', { errors: [`ask about at most ${policy.maxTargetsPerCall} issues at once`] });
    const op = { kind: 'jira.issue.comment', targets: keys.map((issueKey) => ({ issueKey, projectKey: issueKey.split('-')[0] })), payload: {}, fields: [] };
    const { plan, errors: resolveErrors } = await this.resolve(op);
    if (resolveErrors.length) return out('INVALID', { errors: resolveErrors });
    const context = await collectContext(op, plan, policy.contextRisk, { jira: this.jira, graph: this.graph, now: this.now() });
    const meaning = (s) => policy.contextRisk.enabled ? policy.contextRisk.signals[s.signal] ?? 'off' : 'off';
    return out('OK', {
      issues: op.targets.map((t) => t.issueKey),
      signals: context.signals.map((s) => ({ issueKey: s.issueKey, signal: s.signal, source: s.source, message: s.message, policy: meaning(s) })),
      gaps: context.gaps.map((g) => g.message),
      sources: context.sources,
      appliesTo: policy.contextRisk.enabled ? policy.contextRisk.appliesTo : [],
      message: context.signals.length
        ? 'Signals marked approve or deny change the verdict for the operations listed in appliesTo.'
        : 'No release, blocking, priority, goal, pull-request or deployment context found for these issues.',
    });
  }

  async approvalStatus(approvalId, actor) {
    const req = await this.repo.getRequest(approvalId);
    if (!req || req.requester !== actor) return out('INVALID', { errors: [`no approval request '${approvalId}' for you`] });
    const r = withExpiry(req, this.now());
    const page = this.pagePath();
    return out('OK', {
      approvalId,
      approvalStatus: r.status,
      reasons: r.reasons,
      decisionNote: r.decisionNote,
      expiresAt: new Date(r.expiresAt).toISOString(),
      ...(page ? { approvalPage: page } : {}),
      nextStep: nextStep(r.status, approvalId, page),
    });
  }

  /** Approval page path, or null; a broken app context must never fail a gate call. */
  pagePath() {
    try {
      const p = this.approvalPage();
      return typeof p === 'string' && p.startsWith('/jira/apps/') ? p : null;
    } catch {
      return null;
    }
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
        origin: originOf(req),
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
    // Page-load latency: two parallel stages instead of six sequential round-trips, and one
    // Jira permission call (isApprover reuses the admin answer when no approvers are listed).
    const now = this.now();
    const [{ policy, errors }, isAdmin] = await Promise.all([this.repo.loadPolicy(), this.jira.isJiraAdmin()]);
    // Only ping Teamwork Graph when the policy uses it (bounded by the client's own deadline).
    const graphWanted = policy.contextRisk.enabled && policy.contextRisk.useTeamworkGraph;
    const graphPing = !graphWanted
      ? Promise.resolve({ ok: false, error: 'not used by the current policy' })
      : this.graph ? this.graph.ping() : Promise.resolve({ ok: false, error: 'not configured' });
    const approver = policy.approvers.length ? policy.approvers.includes(actor) : isAdmin;
    const seesAll = approver || isAdmin;
    const [requests, myApproved, audit, usage, simulations, graphStatus] = await Promise.all([
      this.repo.listOpenRequests(50, now, seesAll ? undefined : actor),
      this.repo.listApprovedFor(actor, 20, now),
      seesAll ? this.repo.listAudit(50) : this.repo.listAuditForActor(actor, 50),
      this.repo.getUsage('-', now, policy.timezone),
      isAdmin ? this.repo.listSimulations(10, now) : [],
      graphPing,
    ]);
    return {
      actor,
      isApprover: approver,
      isAdmin,
      policy,
      policyErrors: errors,
      requests,
      myApproved,
      audit,
      siteUsageToday: usage.siteDay,
      simulations,
      graphStatus,
    };
  }

  async savePolicy(input, actor) {
    return this.mutate(actor, () => this.updatePolicy(input, actor));
  }

  async updatePolicy(input, actor) {
    if (!(await this.jira.isJiraAdmin())) return out('REFUSED', { code: 'NOT_ADMIN', message: 'only Jira administrators can change the policy' });
    const res = await this.repo.savePolicy(input);
    if (!res.ok) return out('INVALID', { errors: res.errors });
    await this.audit({ actor, op: { kind: 'policy.update', targets: [] }, verdict: 'ADMIN', outcome: 'POLICY_SAVED', reasons: [], origin: ADMIN });
    return out('OK', { policy: res.policy });
  }

  // ---------- admin demo: simulated agent requests (see src/simulation/) ----------

  simulate(presetId, issueKey, actor) {
    return simulateRequest(this, presetId, issueKey, actor);
  }

  runSimulated(approvalId, actor) {
    return runSimulatedRequest(this, approvalId, actor);
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

  async reserveAndAudit(actor, op, policy, verdict, reasons, approvalId, origin = AGENT) {
    // Count attempted targets before sending writes: a lost Jira response must
    // never buy an agent another uncounted write. Failed attempts are not refunded.
    await this.repo.addUsage(actor, this.now(), policy.timezone, op.targets.length);
    await this.audit({ actor, op, verdict, outcome: 'EXECUTION_STARTED', reasons, approvalId, origin });
  }

  resolve(op) {
    return resolveOperation(op, this.jira);
  }

  context(op, plan, policy) {
    if (!contextApplies(policy, op)) return EMPTY_CONTEXT;
    return collectContext(op, plan, policy.contextRisk, { jira: this.jira, graph: this.graph, now: this.now() });
  }

  execute(op, plan) {
    return executeOperation(op, plan, this.jira);
  }

  async audit({ actor, op, verdict, outcome, reasons, approvalId, results, origin = AGENT }) {
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
      source: origin.source,
      ...dryRunFlag(origin),
    });
  }
}

const AGENT = Object.freeze({ source: 'agent' });
const ADMIN = Object.freeze({ source: 'admin' });

/** Origin of a stored request; requests created before sources existed came from agents. */
function originOf(req) {
  return req.source === 'simulated' ? { source: 'simulated', simulation: req.simulation } : AGENT;
}

function sameOrigin(req, origin) {
  return (req.source ?? 'agent') === origin.source && (req.simulation?.mode ?? null) === (origin.simulation?.mode ?? null);
}

/**
 * Reasons a human has not yet approved. Non-context reasons compare by code (rate codes are
 * exempt: usage moves between request and run). Context reasons compare per issue and signal,
 * so a second target that joined a release since approval is a new risk even though the code
 * CONTEXT_RELEASE_SOON was already approved for the first. CONTEXT_UNAVAILABLE is a new risk unless
 * the approver approved an unavailable context: fail closed, a run-time outage asks for a new approval.
 */
function newRisksSince(stored, reasons, context) {
  const approvedCodes = new Set(stored.reasons.map((r) => r.code));
  const reviewed = stored.context ? new Set((stored.context.signals ?? []).map(signalKey)) : null;
  const out = [];
  for (const r of reasons) {
    if (RATE_CODES.has(r.code)) continue;
    if (!r.code.startsWith('CONTEXT_') || r.code === 'CONTEXT_UNAVAILABLE') {
      if (!approvedCodes.has(r.code)) out.push(r);
      continue;
    }
    const fresh = (context.signals ?? []).filter((sig) => sig.code === r.code && !(reviewed?.has(signalKey(sig))));
    if (!approvedCodes.has(r.code) || fresh.length) {
      out.push(fresh.length ? { ...r, message: fresh.map((x) => x.shared ?? x.message).join('; ') } : r);
    }
  }
  return out;
}

/** What the requesting agent is told about context (its own permissions): short, no raw graph payloads. */
function contextView(context) {
  if (!context.checked) return {};
  return {
    context: {
      sources: context.sources,
      signals: context.signals.map((s) => ({ issueKey: s.issueKey, signal: s.signal, source: s.source, message: s.message })),
      gaps: context.gaps.map((g) => g.message),
    },
  };
}

/**
 * Snapshot kept on an approval request so the reviewer sees the context the gate saw. Uses the
 * shared (count-only) texts: it is shown to approvers who may not see what the requester sees.
 */
function storedContext(context) {
  return {
    checkedAt: context.checkedAt,
    sources: context.sources,
    signals: context.signals.map((s) => ({ issueId: s.issueId, issueKey: s.issueKey, signal: s.signal, source: s.source, message: s.shared ?? s.message })),
    gaps: context.gaps.map((g) => g.message),
  };
}

function dryRunFlag(origin) {
  return origin.simulation?.mode === 'dry-run' ? { dryRun: true } : {};
}

function approvalAuthority(policy) {
  return canonicalJson({ approvers: [...policy.approvers].sort(), requireDistinctApprover: policy.requireDistinctApprover });
}

function previewMessage(d) {
  if (d.verdict === Verdict.ALLOW) return 'This change would run immediately.';
  if (d.verdict === Verdict.NEEDS_APPROVAL) return 'This change would need a human approval first.';
  return 'This change would be blocked.';
}

/** What the agent should do next for an approval request in this status (plain words for the LLM). */
function nextStep(status, approvalId, page) {
  switch (status) {
    case Status.PENDING:
      return `Still waiting for a human approver on ${approvalPlace(page)}. Nothing has changed.`;
    case Status.APPROVED:
      return `Approved. Call run-approved-change with approvalId ${approvalId} to run it once.`;
    case Status.REJECTED:
      return 'Rejected by a human approver. Do not retry; tell the user and include the decision note if there is one.';
    case Status.EXPIRED:
      return 'Expired before it was run. Nothing changed; ask the user whether to request a new approval.';
    default:
      return 'This approval was already used or closed. Check my-activity for the outcome; do not run it again.';
  }
}

function out(status, rest = {}) {
  return { status, ...rest };
}
