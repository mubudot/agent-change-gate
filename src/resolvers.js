// UI Kit resolvers for the approval dashboard. Identity comes from the Forge context.
// Named import on purpose: @forge/resolver is CommonJS, and with "type": "module" both Node and
// the Forge bundler resolve a default import to the whole module.exports object, not the class.
import { makeResolver } from '@forge/resolver';
import { DemoSession } from './simulation/demo-session.js';

export function resolverDefinitions(getService) {
  return {
    getDashboard: ({ context }) => getService(context).dashboard(context.accountId),
    decide: ({ payload, context }) =>
      getService(context).decideRequest(String(payload?.approvalId ?? ''), payload?.approve === true, payload?.note, context.accountId),
    savePolicy: ({ payload, context }) => getService(context).savePolicy(payload?.policy, context.accountId),
    // Admin-only demo: push a preset request through the same gate the Rovo/MCP actions use.
    simulate: ({ payload, context }) =>
      getService(context).simulate(String(payload?.preset ?? ''), typeof payload?.issueKey === 'string' ? payload.issueKey : undefined, context.accountId),
    runSimulated: ({ payload, context }) => getService(context).runSimulated(String(payload?.approvalId ?? ''), context.accountId),
    demoState: ({ payload, context }) => new DemoSession(getService(context), context.accountId).state(payload),
    demoStep: ({ payload, context }) => new DemoSession(getService(context), context.accountId).step(payload),
    demoReset: ({ payload, context }) => new DemoSession(getService(context), context.accountId).reset(payload),
  };
}

export function buildResolver(getService) {
  return makeResolver(resolverDefinitions(getService));
}
