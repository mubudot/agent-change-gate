// UI Kit resolvers for the approval dashboard. Identity comes from the Forge context.
import Resolver from '@forge/resolver';

export function resolverDefinitions(getService) {
  return {
    getDashboard: ({ context }) => getService().dashboard(context.accountId),
    decide: ({ payload, context }) =>
      getService().decideRequest(String(payload?.approvalId ?? ''), payload?.approve === true, payload?.note, context.accountId),
    savePolicy: ({ payload, context }) => getService().savePolicy(payload?.policy, context.accountId),
  };
}

export function buildResolver(getService) {
  const resolver = new Resolver();
  for (const [name, fn] of Object.entries(resolverDefinitions(getService))) resolver.define(name, fn);
  return resolver.getDefinitions();
}
