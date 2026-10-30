// Rovo action / MCP tool handlers. Forge calls handler(payload, context).
// Identity ALWAYS comes from the platform context, never from LLM-chosen inputs.
import { ISSUE_KEY } from './policy/ops.js';

export function actorFrom(payload, context) {
  return context?.accountId ?? context?.principal?.accountId ?? payload?.context?.accountId ?? null;
}

/** If the agent omitted issueKeys but the user is looking at an issue, use that issue. */
function withContextIssue(payload) {
  const input = { ...(payload ?? {}) };
  const ctxKey = payload?.context?.jira?.issueKey;
  if (!input.issueKeys && typeof ctxKey === 'string' && ISSUE_KEY.test(ctxKey)) input.issueKeys = ctxKey;
  delete input.context;
  return input;
}

const truthy = (v) => v === true || v === 'true';

export function makeHandlers(getService) {
  const guarded = (kind) => async (payload, context) => {
    const input = withContextIssue(payload);
    return getService().guardedChange(kind, input, actorFrom(payload, context), { preview: truthy(input.preview) });
  };
  return {
    commentIssues: guarded('jira.issue.comment'),
    transitionIssues: guarded('jira.issue.transition'),
    assignIssues: guarded('jira.issue.assign'),
    editIssues: guarded('jira.issue.edit'),
    createIssue: guarded('jira.issue.create'),
    deleteIssues: guarded('jira.issue.delete'),
    runApproved: async (payload, context) => getService().runApproved(String(payload?.approvalId ?? '').trim(), actorFrom(payload, context)),
    approvalStatus: async (payload, context) =>
      getService().approvalStatus(String(payload?.approvalId ?? '').trim(), actorFrom(payload, context)),
    myActivity: async (payload, context) => getService().myActivity(actorFrom(payload, context)),
    policySummary: async () => getService().policySummary(),
  };
}
