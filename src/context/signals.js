// Turn facts about an issue into context risk signals. Pure: no I/O, no clock reads.
// Facts come from two places:
//   - Jira (the issue's own fixVersions, priority and "blocks" links), read in the same call that
//     resolves the target, and
//   - Teamwork Graph (goals, pull requests and deployments connected to the work item).
// A signal never lowers risk. The gate decides what each signal means via policy.contextRisk.
//
// Each signal has two texts: `message` (with names, read with the REQUESTING user's permissions and
// returned only to that user) and `shared` (counts and dates only). Anything stored on an approval
// request or shown to other people uses `shared`, so approvers never see goal, pull request,
// deployment or blocked-issue names they might not be allowed to read.

export const SIGNALS = Object.freeze({
  RELEASE_SOON: 'RELEASE_SOON',
  BLOCKS_OPEN_WORK: 'BLOCKS_OPEN_WORK',
  HIGH_PRIORITY: 'HIGH_PRIORITY',
  LINKED_GOAL: 'LINKED_GOAL',
  OPEN_PULL_REQUEST: 'OPEN_PULL_REQUEST',
  PRODUCTION_DEPLOYMENT: 'PRODUCTION_DEPLOYMENT',
});

export const SIGNAL_LIST = Object.freeze(Object.values(SIGNALS));

/** Reason code the gate uses for a signal, e.g. CONTEXT_RELEASE_SOON. */
export const reasonCode = (signal) => `CONTEXT_${signal}`;

export const SOURCES = Object.freeze({ JIRA: 'jira', GRAPH: 'teamwork-graph', SIMULATED: 'simulated' });

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAMES = 3;

/** Days from `nowMs` (UTC day) to a YYYY-MM-DD date; negative when overdue. */
export function daysUntil(date, nowMs) {
  if (!DATE.test(String(date))) return null;
  const today = Date.UTC(...ymd(new Date(nowMs)));
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - today) / DAY_MS);
}

const ymd = (dt) => [dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()];

function when(days) {
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const names = (list) => {
  const shown = list.slice(0, MAX_NAMES).map((n) => `"${n}"`).join(', ');
  return list.length > MAX_NAMES ? `${shown} and ${list.length - MAX_NAMES} more` : shown;
};

/**
 * @param {string} issueKey
 * @param {{fixVersions?: {name:string, released:boolean, releaseDate:string|null}[], priority?: string|null,
 *          blocks?: {key:string, done:boolean}[]}} facts from JiraClient.getIssue (facts)
 * @param {{releaseWindowDays:number, highPriorities:string[]}} cfg policy.contextRisk
 * @param {number} nowMs
 * @param {string} source 'jira' or 'simulated'
 */
export function jiraSignals(issueKey, facts, cfg, nowMs, source = SOURCES.JIRA) {
  if (!facts) return [];
  const out = [];
  const soon = (facts.fixVersions ?? [])
    .filter((v) => !v.released)
    .map((v) => ({ ...v, days: daysUntil(v.releaseDate, nowMs) }))
    .filter((v) => v.days !== null && v.days <= cfg.releaseWindowDays)
    .sort((a, b) => a.days - b.days);
  if (soon.length) {
    const v = soon[0];
    out.push(signal(SIGNALS.RELEASE_SOON, issueKey, source,
      `${issueKey} ships in release "${v.name}" (${v.releaseDate}, ${when(v.days)})`,
      { release: v.name, releaseDate: v.releaseDate }));
  }
  const open = (facts.blocks ?? []).filter((b) => !b.done).map((b) => b.key);
  if (open.length) {
    out.push(signal(SIGNALS.BLOCKS_OPEN_WORK, issueKey, source,
      `${issueKey} blocks ${open.length} open issue${open.length === 1 ? '' : 's'} (${open.slice(0, MAX_NAMES).join(', ')}${open.length > MAX_NAMES ? ', …' : ''})`,
      { blocks: open.slice(0, 20) },
      `${issueKey} blocks ${open.length} open issue${open.length === 1 ? '' : 's'}`));
  }
  const high = (cfg.highPriorities ?? []).map((p) => p.toLowerCase());
  if (facts.priority && high.includes(String(facts.priority).toLowerCase())) {
    out.push(signal(SIGNALS.HIGH_PRIORITY, issueKey, source, `${issueKey} has priority ${facts.priority}`, { priority: facts.priority }));
  }
  return out;
}

/**
 * @param {string} issueKey
 * @param {{goals?: {name:string, archived?:boolean}[], pullRequests?: {name:string, status?:string}[],
 *          deployments?: {name:string, state?:string, environmentType?:string, environment?:string}[]}} facts
 * @param {string} source 'teamwork-graph' or 'simulated'
 */
export function graphSignals(issueKey, facts, source = SOURCES.GRAPH) {
  if (!facts) return [];
  const out = [];
  const goals = (facts.goals ?? []).filter((g) => g.archived !== true).map((g) => g.name || 'unnamed goal');
  if (goals.length) {
    out.push(signal(SIGNALS.LINKED_GOAL, issueKey, source,
      `${issueKey} is linked to goal${goals.length === 1 ? '' : 's'} ${names(goals)}`, { goals: goals.slice(0, 10) },
      `${issueKey} is linked to ${goals.length} active goal${goals.length === 1 ? '' : 's'}`));
  }
  const prs = (facts.pullRequests ?? []).filter((p) => String(p.status ?? '').toUpperCase() === 'OPEN').map((p) => p.name || 'untitled pull request');
  if (prs.length) {
    out.push(signal(SIGNALS.OPEN_PULL_REQUEST, issueKey, source,
      `${issueKey} has ${prs.length} open pull request${prs.length === 1 ? '' : 's'} (${names(prs)})`, { pullRequests: prs.slice(0, 10) },
      `${issueKey} has ${prs.length} open pull request${prs.length === 1 ? '' : 's'}`));
  }
  const live = (facts.deployments ?? []).filter(
    (d) => String(d.environmentType ?? '').toUpperCase() === 'PRODUCTION' && !['FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(String(d.state ?? '').toUpperCase()),
  );
  if (live.length) {
    const d = live[0];
    out.push(signal(SIGNALS.PRODUCTION_DEPLOYMENT, issueKey, source,
      `${issueKey} is part of a production deployment (${d.environment || d.name || 'production'}${d.state ? `, ${String(d.state).toLowerCase()}` : ''})`,
      { deployments: live.slice(0, 10).map((x) => x.name || x.environment || 'deployment') },
      `${issueKey} is part of a production deployment`));
  }
  return out;
}

function signal(type, issueKey, source, message, detail, shared = message) {
  return { signal: type, code: reasonCode(type), issueKey, source, message, shared, detail };
}
