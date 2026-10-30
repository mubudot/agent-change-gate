// Gather context risk for a resolved operation: Jira facts (already read while resolving targets)
// plus Teamwork Graph connections. Returns plain data for the pure gate.

import { SOURCES, graphSignals, jiraSignals } from './signals.js';

export const EMPTY_CONTEXT = Object.freeze({ checked: false, signals: [], gaps: [], sources: [] });

/** Does policy ask for context on this operation? */
export function contextApplies(policy, op) {
  const cfg = policy?.contextRisk;
  return Boolean(cfg?.enabled && op && op.kind !== 'jira.issue.create' && cfg.appliesTo.includes(op.kind));
}

/**
 * @param {object} op resolved operation (targets carry issueId/issueKey)
 * @param {{facts?: Record<string, object>}} plan from resolveOperation
 * @param {object} cfg policy.contextRisk
 * @param {{jira: {dryRun?: boolean}, graph?: {simulated?: boolean, workItemContext: Function}, now: number}} deps
 */
export async function collectContext(op, plan, cfg, { jira, graph, now }) {
  const targets = (op.targets ?? []).filter((t) => t.issueId);
  const simulated = Boolean(jira?.dryRun);
  const jiraSource = simulated ? SOURCES.SIMULATED : SOURCES.JIRA;
  const graphSource = simulated || graph?.simulated ? SOURCES.SIMULATED : SOURCES.GRAPH;
  const signals = [];
  const gaps = [];
  const sources = new Set();

  for (const t of targets) {
    const facts = plan?.facts?.[t.issueId];
    if (!facts) {
      gaps.push({ source: jiraSource, required: true, message: `${t.issueKey}: Jira release/link/priority facts were not available` });
      continue;
    }
    sources.add(jiraSource);
    signals.push(...withId(t, jiraSignals(t.issueKey, facts, cfg, now, jiraSource)));
    // Informational only: a field Jira omits is not configured for that issue.
    if (facts.missing?.length) gaps.push({ source: jiraSource, info: true, message: `${t.issueKey}: ${facts.missing.join(', ')} not configured` });
  }

  if (cfg.useTeamworkGraph && targets.length) {
    if (!graph) {
      gaps.push({ source: SOURCES.GRAPH, graph: true, message: 'Teamwork Graph client is not configured' });
    } else {
      let res;
      try {
        res = await graph.workItemContext(targets.map((t) => t.issueId));
      } catch (e) {
        res = { byIssue: {}, errors: [`Teamwork Graph: ${String(e?.message ?? e).slice(0, 200)}`], answered: [] };
      }
      for (const message of res.errors ?? []) gaps.push({ source: graphSource, graph: true, message });
      // Provenance: list Teamwork Graph as a checked source only when at least one query returned data.
      if (Array.isArray(res.answered) && res.answered.length > 0) sources.add(graphSource);
      for (const t of targets) {
        const facts = res.byIssue?.[t.issueId];
        signals.push(...withId(t, graphSignals(t.issueKey, facts, graphSource)));
        // More than one page of links: unchecked items could hold a risk, so say so.
        for (const fam of facts?.truncated ?? []) {
          gaps.push({ source: graphSource, graph: true, message: `${t.issueKey}: more than 25 linked ${fam}; only the first 25 were checked` });
        }
      }
    }
  }
  return { checked: true, checkedAt: now, signals, gaps, sources: [...sources] };
}

const withId = (t, list) => list.map((s) => ({ ...s, issueId: String(t.issueId) }));

/** Stable identity of a signal for run-time comparison: same issue, same signal type. */
export const signalKey = (s) => `${s.issueId ?? s.issueKey}:${s.signal}`;
