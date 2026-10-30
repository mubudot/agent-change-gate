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
    signals.push(...jiraSignals(t.issueKey, facts, cfg, now, jiraSource));
  }

  if (cfg.useTeamworkGraph && targets.length) {
    if (!graph) {
      gaps.push({ source: SOURCES.GRAPH, message: 'Teamwork Graph client is not configured' });
    } else {
      let res;
      try {
        res = await graph.workItemContext(targets.map((t) => t.issueId));
      } catch (e) {
        res = { byIssue: {}, errors: [`Teamwork Graph: ${String(e?.message ?? e).slice(0, 200)}`] };
      }
      for (const message of res.errors ?? []) gaps.push({ source: graphSource, message });
      const answered = Object.keys(res.byIssue ?? {}).length > 0 && (res.errors ?? []).length < 3;
      if (answered) sources.add(graphSource);
      for (const t of targets) signals.push(...graphSignals(t.issueKey, res.byIssue?.[t.issueId], graphSource));
    }
  }
  return { checked: true, checkedAt: now, signals, gaps, sources: [...sources] };
}
