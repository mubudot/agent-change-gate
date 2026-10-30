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
  };
}

export function buildResolver(getService) {
  return makeResolver(resolverDefinitions(getService));
}
