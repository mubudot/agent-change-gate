// Rovo action / MCP tool handlers. Forge calls handler(payload, context).
// Identity ALWAYS comes from the platform context, never from LLM-chosen inputs.
import { ISSUE_KEY } from './policy/ops.js';

// Forge passes the signed-in user as context.principal.accountId to plain functions
// (https://developer.atlassian.com/platform/forge/function-reference/arguments/). The flat
// context.accountId form is what @forge/resolver hands UI resolvers; accept it too. Both come
// from the platform's second argument; anything inside the LLM-built payload is ignored.
export function actorFrom(payload, context) {
  const actor = context?.principal?.accountId ?? context?.accountId;
  return typeof actor === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(actor) ? actor : null;
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
