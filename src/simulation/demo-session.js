// Guided sample session: the real gate, with its own policy, counters, requests,
// claims, audit and lease. Only the administrator permission check uses real Jira.
import { createHash } from 'node:crypto';
import { GateService } from '../service.js';
import { Repo } from '../store/repo.js';
import { PrefixStore } from '../store/prefix.js';
import { DryRunJira } from './dry-run-jira.js';
import { DryRunGraph } from './dry-run-graph.js';
import { reconcileDemoProgress } from './demo-progress.js';

export const DEMO_TTL_SECONDS = 86400;
export const demoPrefix = (actor) => `demo:${createHash('sha256').update(actor).digest('hex')}:`;
const STEPS = new Set([1, 2, 3, 4, 5, 'replay']);
const EXPECTED = { 1: 'EXECUTED', 2: 'PENDING_APPROVAL', 3: 'APPROVED', 4: 'EXECUTED', 5: 'DENIED' };
const invalid = (message) => ({ status: 'INVALID', errors: [message] });
const orderError = (next) => ({ status: 'REFUSED', code: 'DEMO_STEP_ORDER', message: next ? `Run demo step ${next} next.` : 'The demo is complete. Reset demo to start again.' });
const emptyView = () => ({ nextStep: 1, results: {}, replay: null, review: null, audit: [] });

export function demoSeed(now) {
  return {
    preset: 'guided-demo', mode: 'dry-run', projectKey: 'DEMO',
    contextByIssue: {
      '1': {},
      '2': {
        fixVersions: [{ name: 'Demo release', released: false, releaseDate: new Date(now + 3 * 86400_000).toISOString().slice(0, 10) }],
        goals: [{ name: 'Demo company goal', archived: false }],
      },
    },
  };
}

export class DemoSession {
  // actor is ONLY the trusted Forge context.accountId, supplied by the resolvers.
  constructor(service, actor) {
    this.service = service;
    this.actor = actor;
  }

  state(payload) { return this.handle('state', payload); }
  step(payload) { return this.handle('step', payload); }
  reset(payload) { return this.handle('reset', payload); }

  async handle(action, payload) {
    if (!this.actor) return invalid('no user context');
    if (!(await this.service.jira.isJiraAdmin())) {
      return { status: 'REFUSED', code: 'NOT_ADMIN', message: 'only Jira administrators can use the guided demo' };
    }
    // No issue keys, operations, policy overrides, actor ids or other input can
    // enter the demo. Its sample data and namespace are selected on the server.
    const fields = action === 'step' ? ['step'] : [];
    if (payload != null && (typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((k) => !fields.includes(k)))) {
      return invalid('Guided demo accepts only a step id; issue keys and other inputs are not accepted.');
    }
    if (action === 'step' && !STEPS.has(payload?.step)) return invalid('unknown demo step; choose 1–5 or replay');

    const store = new PrefixStore(this.service.repo.store, demoPrefix(this.actor), { ttlSeconds: DEMO_TTL_SECONDS });
    const repo = new Repo(store);
    const gate = new GateService({
      repo, jira: this.service.jira, now: this.service.now, newId: this.service.newId,
    });
    // State is read-only, including on a fresh install. Parallel mounts/refreshes
    // can read the last committed progress without competing for a mutation lease.
    if (action === 'state') {
      const session = await store.get('session');
      if (!session || session.expiresAt <= gate.now()) return { status: 'OK', demo: emptyView() };
      await reconcileDemoProgress(repo, session);
      return { status: 'OK', demo: await this.view(repo, session) };
    }
    // Hold ONE of Repo's existing bucket leases over order validation, gate work
    // and progress persistence. Call change/decide/run inside it (their public
    // wrappers would try to acquire the same lease twice). This lease is prefixed
    // per actor, never the installation-wide lease used by real requests.
    return gate.mutate(this.actor, async () => {
      if (action === 'reset') {
        await store.clear();
        return { status: 'OK', demo: emptyView() };
      }
      let session = await store.get('session');
      if (session && session.expiresAt <= gate.now()) {
        await store.clear();
        session = undefined;
      }
      if (!session) {
        await repo.savePolicy({ allowedProjects: ['DEMO'], requireDistinctApprover: false, contextRisk: { enabled: true } });
        session = { ...emptyView(), expiresAt: gate.now() + DEMO_TTL_SECONDS * 1000, simulation: demoSeed(gate.now()) };
        await store.set('session', session);
      }
      const step = payload.step;
      const previousNext = session.nextStep;
      await reconcileDemoProgress(repo, session);
      if (previousNext !== session.nextStep) {
        await store.set('session', session);
        // A retry of the interrupted step returns its stored outcome.
        if (step === previousNext) return { ...session.results[step], demo: await this.view(repo, session) };
      }
      if (step === 'replay' ? !session.results[4] || session.nextStep === 4 : step !== session.nextStep) {
        return { ...orderError(session.nextStep), demo: await this.view(repo, session) };
      }
      // Repeated clicks on the replay example return the first refusal; they do
      // not grow an unbounded audit log or perform additional executions.
      if (step === 'replay' && session.replay) return { ...session.replay, demo: await this.view(repo, session) };

      const result = await this.runStep(gate, session, step);
      if (step === 'replay') session.replay = result;
      else {
        session.results[step] = result;
        if (result.status === EXPECTED[step]) session.nextStep = step === 5 ? null : step + 1;
      }
      await store.set('session', session);
      return { ...result, demo: await this.view(repo, session) };
    });
  }

  async runStep(gate, session, step) {
    const origin = { source: 'simulated', simulation: session.simulation };
    if (step === 1 || step === 2 || step === 5) {
      const dry = gate.withJira(new DryRunJira(session.simulation), new DryRunGraph(session.simulation));
      const issueKeys = step === 5 ? Array.from({ length: 21 }, (_, i) => `DEMO-${i + 1}`).join(',') : `DEMO-${step}`;
      const result = await dry.change('jira.issue.transition', { issueKeys, toStatus: step === 5 ? 'Done' : 'In Progress' }, this.actor, { origin });
      if (step === 2 && result.approvalId) session.approvalId = result.approvalId;
      return result;
    }
    if (step === 3) {
      const result = await gate.decide(session.approvalId, true, undefined, this.actor);
      return { ...result, status: result.approvalStatus ?? result.status };
    }
    const result = await gate.run(session.approvalId, this.actor);
    if (step === 'replay' && result.status === 'REFUSED') {
      // The gate returns early on a spent approval; record this demo interaction
      // too, using the same audit writer and the actual refusal code.
      const request = await gate.repo.getRequest(session.approvalId);
      await gate.audit({ actor: this.actor, op: request.op, verdict: 'APPROVED', outcome: 'REFUSED', reasons: [{ code: result.code }], approvalId: request.id, origin });
    }
    return result;
  }

  async view(repo, session) {
    const request = session.approvalId ? await repo.getRequest(session.approvalId) : null;
    return {
      nextStep: session.nextStep, results: session.results, replay: session.replay, expiresAt: session.expiresAt,
      // Use exactly the stored approver snapshot (count-only graph context).
      review: request ? { reasons: request.reasons, context: request.context } : null,
      audit: await repo.listAuditForActor(this.actor, 10),
    };
  }
}
