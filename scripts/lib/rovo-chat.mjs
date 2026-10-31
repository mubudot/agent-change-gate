// Pure helpers for scripts/rovo-probe.mjs (dev tool): which Rovo agent is ours, and how to read one
// streamed Rovo chat turn. Kept apart from the network code so they can be unit-tested.
export const APP_ID = '67a2afa4-d23d-4d5b-a9b7-1cf01c63defe';
export const DEV_ENV_ID = 'fb72e4c2-07b3-4fdf-9ba0-876c0e692990';
export const AGENT_NAME = 'Change Gate Agent';
export const AGENT_MODULE_KEY = 'change-gate-agent';
export const EXPECTED_ACTIONS = ['acg-approval-status', 'acg-assign-issues', 'acg-comment-issues', 'acg-create-issue',
  'acg-delete-issues', 'acg-edit-issues', 'acg-issue-context', 'acg-my-activity', 'acg-policy-summary',
  'acg-run-approved-change', 'acg-transition-issues'];

const extensionAri = (envId, key) => `ari:cloud:ecosystem::extension/${APP_ID}/${envId}/static/${key}`;

/** Only <site>.atlassian.net hosts may receive the developer's credentials. */
export function trustedSiteHost(site) {
  const host = String(site ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host) ? host : null;
}

/** Rovo lists a Forge agent with external_config_reference "<installation>_<agent module extension ARI>". */
export function isOurAgent(agent, envId = DEV_ENV_ID) {
  return agent?.creator_type === 'FORGE' &&
    typeof agent.external_config_reference === 'string' &&
    agent.external_config_reference.split('_').pop() === extensionAri(envId, AGENT_MODULE_KEY);
}

/** Expected actions that the agent does not have attached (or that Rovo marked invalid). */
export function missingActions(agent) {
  const configured = new Set((agent?.action_config ?? []).filter((x) => !x.invalid).map((x) => x.id));
  return EXPECTED_ACTIONS.filter((k) => !(k in (agent?.available_plugins ?? {})) || !configured.has(k));
}

/**
 * Read one streamed turn. The stream is newline-separated JSON events (optionally "data:"-prefixed):
 * TRACE (tool progress), ANSWER_PART (text deltas), FINAL_RESPONSE (whole message with tool calls).
 */
export function parseTurn(text, envId = DEV_ENV_ID) {
  const events = String(text ?? '').split('\n')
    .map((l) => (l.startsWith('data:') ? l.slice(5) : l))
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const traces = events.filter((e) => e.type === 'TRACE' && /Invoking tool/.test(e.message?.content ?? '')).map((e) => e.message.content);
  const final = events.find((e) => e.type === 'FINAL_RESPONSE');
  const m = final ? final.message?.message ?? final.message ?? {} : {};
  const finalText = typeof m.content === 'string' ? m.content.trim() : '';
  // A planned action only counts if it is one of ours, from this deployment.
  const planned = (Array.isArray(m.actions) ? m.actions : []).filter((a) =>
    a?.status === 'planned' && EXPECTED_ACTIONS.includes(a.key) && a.actionId === extensionAri(envId, a.key));
  const tools = (Array.isArray(m.plugin_invocations) ? m.plugin_invocations : []).map((inv) => ({
    name: inv.plugin_display_name, input: inv.plugin_input, output: inv.plugin_output, error: inv.plugin_error_message,
  }));
  return { events: events.map((e) => e.type), hasFinal: Boolean(final), finalText, planned, tools, traces };
}

/** Why a turn does not count as a successful agent answer, or null if it does. */
export function turnProblem(turn) {
  if (!turn.hasFinal) return 'stream ended without a final response';
  const failed = turn.tools.filter((t) => t.error);
  if (failed.length) return `tool call failed: ${failed.map((t) => `${t.name}: ${t.error}`).join('; ')}`;
  if (!turn.finalText && !turn.planned.length) return 'final response has neither text nor a planned action of ours';
  return null;
}
