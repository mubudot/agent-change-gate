// Policy schema, defaults and validation. Pure: no I/O, no Forge imports.

export const MODES = Object.freeze(['allow', 'approve', 'deny']);

// Every operation the gate knows about. Anything else is denied (fail closed).
export const OPERATION_KINDS = Object.freeze([
  'jira.issue.comment',
  'jira.issue.edit',
  'jira.issue.transition',
  'jira.issue.assign',
  'jira.issue.create',
  'jira.issue.delete',
]);

// Operations that cannot be undone from the Jira UI. These are never 'allow',
// whatever the stored policy says: the floor is 'approve'.
export const DESTRUCTIVE_KINDS = Object.freeze(['jira.issue.delete']);

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  agentWritesPaused: false,
  // Empty allowlist = no project may be written by an agent (safe default).
  allowedProjects: [],
  blockedProjects: [],
  operations: {
    'jira.issue.comment': 'allow',
    'jira.issue.edit': 'allow',
    'jira.issue.transition': 'allow',
    'jira.issue.assign': 'allow',
    'jira.issue.create': 'allow',
    'jira.issue.delete': 'approve',
  },
  // Edits that touch any of these fields need a human.
  protectedFields: ['priority', 'fixVersions', 'security', 'duedate'],
  // Transitions INTO any of these statuses need a human (matched case-insensitively).
  protectedStatuses: ['Done', 'Closed', "Won't Do"],
  maxTargetsPerCall: 20, // above this: DENY (agent must split the work and ask)
  bulkApprovalThreshold: 5, // above this: NEEDS_APPROVAL
  perActorHourlyLimit: 30, // attempted issue writes per user in a fixed UTC clock hour
  perActorDailyLimit: 100,
  siteDailyLimit: 500,
  maxCommentLength: 5000,
  requireDistinctApprover: true, // two-person rule: requester cannot approve their own request
  approvers: [], // Atlassian accountIds. Empty = Jira administrators.
  approvalTtlMinutes: 24 * 60,
  timezone: 'UTC', // day boundary for daily limits
  // Context risk: what the target issues are connected to can only RAISE the verdict.
  contextRisk: {
    enabled: true,
    // Comments and creates are excluded by default: context matters for state changes.
    appliesTo: ['jira.issue.transition', 'jira.issue.edit', 'jira.issue.assign', 'jira.issue.delete'],
    useTeamworkGraph: true,
    releaseWindowDays: 7, // unreleased fixVersion due within this many days (or overdue)
    highPriorities: ['Highest'],
    // off | approve | deny, per signal (see src/context/signals.js)
    signals: {
      RELEASE_SOON: 'approve',
      BLOCKS_OPEN_WORK: 'approve',
      HIGH_PRIORITY: 'approve',
      LINKED_GOAL: 'approve',
      OPEN_PULL_REQUEST: 'approve',
      PRODUCTION_DEPLOYMENT: 'approve',
    },
    // Teamwork Graph is a Preview API: if it errors, 'ignore' keeps Jira-based context only,
    // 'approve' sends the change to a human. Missing Jira facts always need a human.
    onGraphUnavailable: 'ignore',
  },
});

export const SIGNAL_MODES = Object.freeze(['off', 'approve', 'deny']);
const CONTEXT_KINDS = Object.freeze(['jira.issue.transition', 'jira.issue.edit', 'jira.issue.assign', 'jira.issue.delete', 'jira.issue.comment']);

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function upperList(value, name, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return [];
  }
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') { errors.push(`${name} entries must be strings`); continue; }
    const key = raw.trim().toUpperCase();
    if (!PROJECT_KEY.test(key)) errors.push(`${name}: invalid project key '${raw}'`);
    else if (!out.includes(key)) out.push(key);
  }
  return out;
}

function stringList(value, name, errors, { lower = false } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return [];
  }
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) { errors.push(`${name} entries must be nonempty strings`); continue; }
    let s = raw.trim();
    if (lower) s = s.toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function positiveInt(value, name, errors, max = 100000) {
  if (value === undefined) return undefined;
  const n = value;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    errors.push(`${name} must be an integer between 1 and ${max}`);
    return undefined;
  }
  return n;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge a stored/partial policy over the defaults and validate it.
 * Returns { policy, errors }. If errors is non-empty the caller must not save it;
 * at runtime an invalid stored policy is treated as "paused" by the gate.
 */
export function normalizePolicy(input = {}) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { policy: clone(DEFAULT_POLICY), errors: ['policy must be an object'] };
  }
  const p = clone(DEFAULT_POLICY);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) errors.push(`unknown policy property '${key}'`);
  }
  if (input.version !== undefined && input.version !== 1) errors.push('unsupported policy version');
  for (const key of ['agentWritesPaused', 'requireDistinctApprover']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') errors.push(`${key} must be a boolean`);
      else p[key] = input[key];
    }
  }

  const allowed = upperList(input.allowedProjects, 'allowedProjects', errors);
  if (allowed) p.allowedProjects = allowed;
  const blocked = upperList(input.blockedProjects, 'blockedProjects', errors);
  if (blocked) p.blockedProjects = blocked;

  if (input.operations !== undefined) {
    if (typeof input.operations !== 'object' || input.operations === null || Array.isArray(input.operations)) {
      errors.push('operations must be an object');
    } else {
      for (const [kind, mode] of Object.entries(input.operations)) {
        if (!OPERATION_KINDS.includes(kind)) {
          errors.push(`operations: unknown operation '${kind}'`);
          continue;
        }
        if (!MODES.includes(mode)) {
          errors.push(`operations.${kind} must be one of ${MODES.join(', ')}`);
          continue;
        }
        p.operations[kind] = mode;
      }
    }
  }
  // Destructive floor.
  for (const kind of DESTRUCTIVE_KINDS) {
    if (p.operations[kind] === 'allow') p.operations[kind] = 'approve';
  }

  const fields = stringList(input.protectedFields, 'protectedFields', errors);
  if (fields) p.protectedFields = fields;
  const statuses = stringList(input.protectedStatuses, 'protectedStatuses', errors);
  if (statuses) p.protectedStatuses = statuses;
  const approvers = stringList(input.approvers, 'approvers', errors);
  if (approvers) {
    for (const a of approvers) if (!ACCOUNT_ID.test(a)) errors.push(`approvers: invalid accountId '${a}'`);
    p.approvers = approvers.filter((a) => ACCOUNT_ID.test(a));
  }

  for (const [key, max] of [
    ['maxTargetsPerCall', 50],
    ['bulkApprovalThreshold', 50],
    ['perActorHourlyLimit', 10000],
    ['perActorDailyLimit', 100000],
    ['siteDailyLimit', 1000000],
    ['maxCommentLength', 32000],
    ['approvalTtlMinutes', 7 * 24 * 60],
  ]) {
    const v = positiveInt(input[key], key, errors, max);
    if (v !== undefined) p[key] = v;
  }

  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || !validTimezone(input.timezone)) {
      errors.push(`timezone '${input.timezone}' is not a valid IANA zone`);
    } else p.timezone = input.timezone;
  }

  if (input.contextRisk !== undefined) p.contextRisk = normalizeContextRisk(input.contextRisk, errors);

  if (p.bulkApprovalThreshold > p.maxTargetsPerCall) {
    errors.push('bulkApprovalThreshold must be <= maxTargetsPerCall');
  }
  if (p.perActorHourlyLimit > p.perActorDailyLimit) {
    errors.push('perActorHourlyLimit must be <= perActorDailyLimit');
  }
  return { policy: p, errors };
}

function normalizeContextRisk(input, errors) {
  const c = clone(DEFAULT_POLICY.contextRisk);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('contextRisk must be an object');
    return c;
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(c, key)) errors.push(`unknown contextRisk property '${key}'`);
  }
  for (const key of ['enabled', 'useTeamworkGraph']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') errors.push(`contextRisk.${key} must be a boolean`);
      else c[key] = input[key];
    }
  }
  const kinds = stringList(input.appliesTo, 'contextRisk.appliesTo', errors);
  if (kinds) {
    for (const k of kinds) if (!CONTEXT_KINDS.includes(k)) errors.push(`contextRisk.appliesTo: unsupported operation '${k}'`);
    c.appliesTo = kinds.filter((k) => CONTEXT_KINDS.includes(k));
  }
  if (input.releaseWindowDays !== undefined) {
    const n = input.releaseWindowDays;
    if (!Number.isInteger(n) || n < 0 || n > 365) errors.push('contextRisk.releaseWindowDays must be an integer between 0 and 365');
    else c.releaseWindowDays = n;
  }
  const prios = stringList(input.highPriorities, 'contextRisk.highPriorities', errors);
  if (prios) c.highPriorities = prios;
  if (input.signals !== undefined) {
    if (input.signals === null || typeof input.signals !== 'object' || Array.isArray(input.signals)) {
      errors.push('contextRisk.signals must be an object');
    } else {
      for (const [sig, mode] of Object.entries(input.signals)) {
        if (!Object.hasOwn(c.signals, sig)) errors.push(`contextRisk.signals: unknown signal '${sig}'`);
        else if (!SIGNAL_MODES.includes(mode)) errors.push(`contextRisk.signals.${sig} must be one of ${SIGNAL_MODES.join(', ')}`);
        else c.signals[sig] = mode;
      }
    }
  }
  if (input.onGraphUnavailable !== undefined) {
    if (!['ignore', 'approve'].includes(input.onGraphUnavailable)) errors.push("contextRisk.onGraphUnavailable must be 'ignore' or 'approve'");
    else c.onGraphUnavailable = input.onGraphUnavailable;
  }
  return c;
}

export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** Calendar day (YYYY-MM-DD) of `nowMs` in the policy timezone. */
export function dayKey(nowMs, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** UTC clock-hour bucket, e.g. 2026-10-30T03. */
export function hourKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 13);
}
