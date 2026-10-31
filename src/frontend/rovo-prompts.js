// Rovo chat hand-offs from the approval page (pure helpers, unit-tested).
// The agent key and name must match the rovo:agent module in manifest.yml.
export const CHANGE_GATE_AGENT = Object.freeze({ type: 'forge', agentKey: 'change-gate-agent', agentName: 'Change Gate Agent' });

const UUIDISH = /^[A-Za-z0-9-]{8,64}$/;

/** Prompt that asks the agent to check and run one approved request. */
export function runApprovedPrompt(approvalId) {
  if (typeof approvalId !== 'string' || !UUIDISH.test(approvalId)) return null;
  return `My approval request ${approvalId} was approved. Check its status, then run it once.`;
}

/** Only the requester can run their own approved, non-simulated request from chat. */
export function canRunFromChat(request, actor) {
  return Boolean(request && actor && request.status === 'APPROVED' && request.requester === actor && request.source !== 'simulated');
}

export const ASK_PROMPT = 'What could go wrong if you move the issue I am looking at?';
