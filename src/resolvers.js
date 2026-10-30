// UI Kit resolvers for the approval dashboard. Identity comes from the Forge context.
// Named import on purpose: @forge/resolver is CommonJS, and with "type": "module" both Node and
// the Forge bundler resolve a default import to the whole module.exports object, not the class.
import { makeResolver } from '@forge/resolver';

export function resolverDefinitions(getService) {
  return {
    getDashboard: ({ context }) => getService().dashboard(context.accountId),
    decide: ({ payload, context }) =>
      getService().decideRequest(String(payload?.approvalId ?? ''), payload?.approve === true, payload?.note, context.accountId),
    savePolicy: ({ payload, context }) => getService().savePolicy(payload?.policy, context.accountId),
    // Admin-only demo: push a preset request through the same gate the Rovo/MCP actions use.
    simulate: ({ payload, context }) =>
      getService().simulate(String(payload?.preset ?? ''), typeof payload?.issueKey === 'string' ? payload.issueKey : undefined, context.accountId),
    runSimulated: ({ payload, context }) => getService().runSimulated(String(payload?.approvalId ?? ''), context.accountId),
  };
}

export function buildResolver(getService) {
  return makeResolver(resolverDefinitions(getService));
}
