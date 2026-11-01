// Admin-only demo entry points. A simulated request goes through GateService.guardedChange, the same
// path Rovo actions and MCP tools use (policy, caps, two-person approval, audit); it is only marked
// source 'simulated' and, without a real issue key, bound to the dry-run Jira client.
import { buildPreset } from './presets.js';
import { DryRunJira } from './dry-run-jira.js';
import { DryRunGraph } from './dry-run-graph.js';
import { progressDestination } from './destination.js';

const refuse = () => ({ status: 'REFUSED', code: 'NOT_ADMIN', message: 'only Jira administrators can simulate agent requests' });

/** Jira client a simulated request must use; dry-run requests can never reach real Jira. */
export function jiraForSimulation(simulation, realJira) {
  return simulation?.mode === 'dry-run' ? new DryRunJira(simulation) : realJira;
}

/** Teamwork Graph client a simulated request must use; dry runs never query the real graph. */
export function graphForSimulation(simulation, realGraph) {
  return simulation?.mode === 'dry-run' ? new DryRunGraph(simulation) : realGraph;
}

export async function simulateRequest(service, presetId, issueKey, actor) {
  if (!actor) return { status: 'INVALID', errors: ['no user context'] };
  if (!(await service.jira.isJiraAdmin())) return refuse();
  const { policy } = await service.repo.loadPolicy();
  const now = service.now();
  let { plan, error } = buildPreset(String(presetId ?? ''), policy, issueKey, now);
  if (!plan) return { status: 'INVALID', errors: [error] };
  if (plan.simulation.mode === 'live' && ['routine-move', 'context-move'].includes(presetId)) {
    try {
      const transitions = await service.jira.getTransitions(plan.input.issueKeys);
      const selected = progressDestination(plan.input.issueKeys, transitions);
      if (selected.error) return { status: 'INVALID', errors: [selected.error] };
      ({ plan } = buildPreset(presetId, policy, issueKey, now, selected.destination));
    } catch (e) {
      return { status: 'INVALID', errors: [e.message] };
    }
  }
  const target = plan.simulation.mode === 'dry-run' ? service.withJira(jiraForSimulation(plan.simulation), graphForSimulation(plan.simulation)) : service;
  const origin = { source: 'simulated', simulation: plan.simulation };
  const result = await target.guardedChange(plan.kind, plan.input, actor, { origin });
  return { ...result, source: 'simulated', simulation: plan.simulation };
}

/** Run an approved simulated request from the dashboard (Rovo may be off, so no agent can call run-approved-change). */
export async function runSimulatedRequest(service, approvalId, actor) {
  if (!actor) return { status: 'INVALID', errors: ['no user context'] };
  if (!(await service.jira.isJiraAdmin())) return refuse();
  const stored = await service.repo.getRequest(approvalId);
  if (!stored || stored.source !== 'simulated') return { status: 'INVALID', errors: ['no simulated request with that id'] };
  return service.runApproved(approvalId, actor);
}
