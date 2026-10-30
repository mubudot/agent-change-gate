// The deterministic policy gate. Pure function: (policy, operation, usage) -> decision.
// No LLM, no I/O. DENY reasons always win over NEEDS_APPROVAL reasons.
import { DESTRUCTIVE_KINDS, OPERATION_KINDS } from './policy.js';

export const Verdict = Object.freeze({
  ALLOW: 'ALLOW',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  DENY: 'DENY',
});

/**
 * @param {object} policy normalized policy (see normalizePolicy)
 * @param {object} op normalized operation; targets[].projectKey must be the
 *   project Jira reports for the issue (resolved by the service), not a guess.
 *   For transitions, op.toStatus is the resolved target status name.
 * @param {{actorHour?:number, actorDay?:number, siteDay?:number}} usage writes already counted
 * @param {{policyErrors?: string[], context?: {signals: object[], gaps: object[]}}} [opts]
 *   context comes from src/context/collector.js; it can only add DENY or NEEDS_APPROVAL reasons.
 * @returns {{verdict: string, reasons: {code:string, message:string}[], units: number}}
 */
export function evaluate(policy, op, usage = {}, opts = {}) {
  const deny = [];
  const approve = [];
  const d = (code, message) => deny.push({ code, message });
  const a = (code, message) => approve.push({ code, message });
  const units = op?.targets?.length ?? 0;

  if (opts.policyErrors?.length) {
    d('POLICY_INVALID', `stored policy is invalid (${opts.policyErrors[0]}); agent writes are blocked until an admin fixes it`);
  }
  if (!op || !OPERATION_KINDS.includes(op.kind)) {
    d('UNKNOWN_OPERATION', `operation '${op?.kind}' is not supported`);
    return { verdict: Verdict.DENY, reasons: deny, units };
  }
  if (policy.agentWritesPaused) d('PAUSED', 'agent writes are paused by an administrator (kill switch)');

  const mode = policy.operations[op.kind] ?? 'deny';
  if (mode === 'deny') d('OPERATION_DENIED', `${op.kind} is not permitted for agents`);

  if (units === 0) d('NO_TARGETS', 'operation has no targets');
  if (units > policy.maxTargetsPerCall) {
    d('TOO_MANY_TARGETS', `${units} issues in one call exceeds the hard limit of ${policy.maxTargetsPerCall}`);
  }

  const projects = [...new Set((op.targets ?? []).map((t) => t.projectKey))];
  for (const p of projects) {
    if (!p) d('UNKNOWN_PROJECT', 'a target has no resolved project');
    else if (policy.blockedProjects.includes(p)) d('PROJECT_BLOCKED', `project ${p} is blocked for agent writes`);
    else if (!policy.allowedProjects.includes(p)) d('PROJECT_NOT_ALLOWED', `project ${p} is not on the agent write allowlist`);
  }

  if (op.kind === 'jira.issue.comment') {
    const len = op.payload?.body?.length ?? 0;
    if (len > policy.maxCommentLength) d('COMMENT_TOO_LONG', `comment is ${len} characters (max ${policy.maxCommentLength})`);
  }

  const contextReasons = contextRiskReasons(policy, opts.context);
  deny.push(...contextReasons.deny);

  if (deny.length) return { verdict: Verdict.DENY, reasons: deny, units };
  approve.push(...contextReasons.approve);

  // ---- approval reasons (a human can say yes) ----
  if (mode === 'approve' || DESTRUCTIVE_KINDS.includes(op.kind)) {
    a('OPERATION_NEEDS_APPROVAL', `${op.kind} always needs human approval`);
  }
  if (units > policy.bulkApprovalThreshold) {
    a('BULK_CHANGE', `${units} issues in one call is above the bulk threshold of ${policy.bulkApprovalThreshold}`);
  }
  const protectedFields = policy.protectedFields.map((f) => f.toLowerCase());
  const touched = (op.fields ?? []).filter((f) => protectedFields.includes(String(f).toLowerCase()));
  if (touched.length) a('PROTECTED_FIELD', `changes protected field(s): ${touched.join(', ')}`);

  if (op.kind === 'jira.issue.transition') {
    // Check the requested name and every resolved per-issue target status.
    const names = [op.toStatus, ...(op.targets ?? []).map((t) => t.toStatus)].filter(Boolean);
    const protectedSet = policy.protectedStatuses.map((s) => s.toLowerCase());
    const hit = [...new Set(names.filter((n) => protectedSet.includes(String(n).toLowerCase())))];
    if (hit.length) a('PROTECTED_STATUS', `moves issues into protected status ${hit.map((h) => `'${h}'`).join(', ')}`);
  }

  const hour = (usage.actorHour ?? 0) + units;
  const day = (usage.actorDay ?? 0) + units;
  const site = (usage.siteDay ?? 0) + units;
  if (hour > policy.perActorHourlyLimit) a('HOURLY_LIMIT', `would make ${hour} agent writes this hour for this user (limit ${policy.perActorHourlyLimit})`);
  if (day > policy.perActorDailyLimit) a('DAILY_LIMIT', `would make ${day} agent writes today for this user (limit ${policy.perActorDailyLimit})`);
  if (site > policy.siteDailyLimit) a('SITE_DAILY_LIMIT', `would make ${site} agent writes today on this site (limit ${policy.siteDailyLimit})`);

  if (approve.length) return { verdict: Verdict.NEEDS_APPROVAL, reasons: approve, units };
  return { verdict: Verdict.ALLOW, reasons: [], units };
}

/**
 * One reason per signal type (codes stay unique so a run-time recheck can compare them),
 * listing every affected issue. Missing Jira facts always need a human; a Teamwork Graph
 * outage does only when policy.contextRisk.onGraphUnavailable is 'approve'.
 */
export function contextRiskReasons(policy, context) {
  const out = { deny: [], approve: [] };
  const cfg = policy.contextRisk;
  if (!context || !cfg?.enabled) return out;
  const grouped = new Map();
  for (const s of context.signals ?? []) {
    const mode = cfg.signals?.[s.signal] ?? 'off';
    if (mode === 'off') continue;
    const g = grouped.get(s.code) ?? { mode, code: s.code, messages: [], sources: new Set() };
    g.messages.push(s.message);
    g.sources.add(s.source);
    grouped.set(s.code, g);
  }
  for (const g of grouped.values()) {
    const reason = { code: g.code, message: g.messages.join('; '), source: [...g.sources].join('+') };
    (g.mode === 'deny' ? out.deny : out.approve).push(reason);
  }
  const gaps = (context.gaps ?? []).filter((g) => g.required || cfg.onGraphUnavailable === 'approve');
  if (gaps.length) {
    out.approve.push({
      code: 'CONTEXT_UNAVAILABLE',
      message: `context could not be fully checked (${gaps[0].message}${gaps.length > 1 ? `; +${gaps.length - 1} more` : ''})`,
      source: [...new Set(gaps.map((g) => g.source))].join('+'),
    });
  }
  return out;
}
