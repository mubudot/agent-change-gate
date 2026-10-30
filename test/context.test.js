// Context risk: Jira facts + Teamwork Graph connections can only raise the gate's verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeGraph, ALICE, BOB } from './helpers.js';
import { daysUntil, graphSignals, jiraSignals } from '../src/context/signals.js';
import { TeamworkGraphClient, buildFamilyQuery, cloudIdFrom, workItemAri } from '../src/context/graph-client.js';
import { contextRiskReasons } from '../src/policy/gate.js';
import { normalizePolicy } from '../src/policy/policy.js';
import { issueFacts } from '../src/jira/client.js';
import { makeHandlers } from '../src/actions.js';

const NOW = Date.UTC(2026, 10, 2, 9); // matches helpers.setup clock
const CFG = normalizePolicy({}).policy.contextRisk;
const CLOUD = '11111111-2222-3333-4444-555555555555';
const releaseIn = (days, extra = {}) => ({
  fixVersions: [{ name: 'Mobile 2.4', released: false, releaseDate: new Date(NOW + days * 86_400_000).toISOString().slice(0, 10), ...extra }],
});

// ---------- pure signals ----------

test('jiraSignals: release window, overdue, released versions, blockers and priority', () => {
  assert.equal(daysUntil('2026-11-05', NOW), 3);
  assert.equal(daysUntil('nope', NOW), null);
  const soon = jiraSignals('DEMO-2', releaseIn(3), CFG, NOW);
  assert.deepEqual(soon.map((s) => s.code), ['CONTEXT_RELEASE_SOON']);
  assert.match(soon[0].message, /Mobile 2\.4.*in 3 days/);
  assert.equal(soon[0].source, 'jira');
  assert.match(jiraSignals('X-1', releaseIn(-2), CFG, NOW)[0].message, /2 days overdue/);
  assert.equal(jiraSignals('X-1', releaseIn(30), CFG, NOW).length, 0, 'outside the window');
  assert.equal(jiraSignals('X-1', releaseIn(1, { released: true }), CFG, NOW).length, 0, 'already released');
  assert.equal(jiraSignals('X-1', { fixVersions: [{ name: 'v', released: false, releaseDate: null }] }, CFG, NOW).length, 0, 'no date');
  const blocks = jiraSignals('X-1', { blocks: [{ key: 'X-2', done: false }, { key: 'X-3', done: true }] }, CFG, NOW);
  assert.deepEqual(blocks.map((s) => s.detail.blocks), [['X-2']]);
  assert.equal(jiraSignals('X-1', { priority: 'highest' }, CFG, NOW)[0].code, 'CONTEXT_HIGH_PRIORITY');
  assert.equal(jiraSignals('X-1', { priority: 'Low' }, CFG, NOW).length, 0);
  assert.deepEqual(jiraSignals('X-1', null, CFG, NOW), []);
});

test('graphSignals: active goals, open PRs and live production deployments only', () => {
  const s = graphSignals('DEMO-2', {
    goals: [{ name: 'Old goal', archived: true }, { name: 'Launch checkout' }],
    pullRequests: [{ name: 'Fix totals', status: 'OPEN' }, { name: 'Merged', status: 'MERGED' }],
    deployments: [
      { name: 'deploy 1', state: 'FAILED', environmentType: 'PRODUCTION' },
      { name: 'deploy 2', state: 'SUCCESSFUL', environmentType: 'STAGING' },
      { name: 'deploy 3', state: 'SUCCESSFUL', environmentType: 'PRODUCTION', environment: 'prod-eu' },
    ],
  });
  assert.deepEqual(s.map((x) => x.code), ['CONTEXT_LINKED_GOAL', 'CONTEXT_OPEN_PULL_REQUEST', 'CONTEXT_PRODUCTION_DEPLOYMENT']);
  assert.match(s[0].message, /"Launch checkout"/);
  assert.doesNotMatch(s[0].message, /Old goal/);
  assert.match(s[2].message, /prod-eu/);
  assert.ok(s.every((x) => x.source === 'teamwork-graph'));
  assert.deepEqual(graphSignals('X-1', { goals: [], pullRequests: [], deployments: [] }), []);
});

test('issueFacts reads fixVersions, priority and outward "blocks" links only', () => {
  const f = issueFacts({
    fixVersions: [{ name: 'R1', released: false, releaseDate: '2026-11-05' }],
    priority: { name: 'Highest' },
    issuelinks: [
      { type: { outward: 'blocks' }, outwardIssue: { key: 'A-2', fields: { status: { statusCategory: { key: 'indeterminate' } } } } },
      { type: { outward: 'blocks' }, inwardIssue: { key: 'A-3' } },
      { type: { outward: 'relates to' }, outwardIssue: { key: 'A-4' } },
    ],
  });
  assert.deepEqual(f, { missing: [], fixVersions: [{ name: 'R1', released: false, releaseDate: '2026-11-05' }], priority: 'Highest', blocks: [{ key: 'A-2', done: false }] });
  assert.equal(issueFacts(undefined), null, 'malformed response is not "no risk"');
  assert.deepEqual(issueFacts({ priority: { name: 'Low' } }).missing, ['fixVersions', 'issuelinks']);
  // Every entry is evaluated: the only risky version sits at position 51.
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `old-${i}`, released: true, releaseDate: '2026-01-01' }));
  many.push({ name: 'R51', released: false, releaseDate: '2026-11-03' });
  assert.equal(jiraSignals('A-1', issueFacts({ fixVersions: many }), CFG, NOW)[0].detail.release, 'R51');
});

// ---------- Teamwork Graph client ----------

test('graph client batches targets as aliases of one curated query per family', () => {
  const { query, variables } = buildFamilyQuery('goals', CLOUD, ['10001', '10002']);
  assert.match(query, /^query agentChangeGate_goals\(\$i0: ID!, \$i1: ID!\)/);
  assert.match(query, /i0: jiraWorkItemGoals\(id: \$i0, first: 25\)/);
  assert.match(query, /\.\.\. on AtlassianGoal \{ id name archived \}/);
  assert.deepEqual(variables, { i0: workItemAri(CLOUD, '10001'), i1: workItemAri(CLOUD, '10002') });
  assert.equal(workItemAri(CLOUD, '7'), `ari:cloud:jira:${CLOUD}:issue/7`);
  assert.equal(cloudIdFrom({ installContext: `ari:cloud:jira::site/${CLOUD}` }), CLOUD);
  assert.equal(cloudIdFrom({ cloudId: CLOUD }), CLOUD);
  assert.equal(cloudIdFrom({ cloudId: 'bad id!' }), null);
});

test('graph client parses results; a failing family only loses its own signals', async () => {
  const seen = [];
  const graph = new TeamworkGraphClient(async (query, variables) => {
    seen.push({ query, variables });
    if (query.includes('agentChangeGate_deployments')) return { status: 200, data: { errors: [{ message: 'Cannot query field "environment"' }] } };
    if (query.includes('agentChangeGate_goals')) {
      return { status: 200, data: { data: { i0: { edges: [{ node: { __typename: 'AtlassianGoal', id: 'g', name: 'Launch checkout', archived: false } }] } } } };
    }
    return { status: 200, data: { data: { i0: { edges: [{ node: { __typename: 'ExternalPullRequest', displayName: 'Fix totals', status: 'OPEN' } }] } } } };
  }, CLOUD);
  const r = await graph.workItemContext(['10001', '10001', 'x']);
  assert.equal(seen.length, 3, 'one request per family, ids deduplicated and validated');
  assert.deepEqual(r.byIssue['10001'].goals, [{ name: 'Launch checkout', archived: false }]);
  assert.equal(r.byIssue['10001'].pullRequests[0].status, 'OPEN');
  assert.deepEqual(r.byIssue['10001'].deployments, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /deployments: Cannot query field/);
});

test('graph client without a site id, and transport failures, are reported as gaps', async () => {
  const none = new TeamworkGraphClient(async () => { throw new Error('should not be called'); }, null);
  assert.match((await none.workItemContext(['1'])).errors[0], /no site id/);
  assert.equal((await none.ping()).ok, false);
  const broken = new TeamworkGraphClient(async () => { throw new Error('socket hang up'); }, CLOUD);
  const r = await broken.workItemContext(['1']);
  assert.equal(r.errors.length, 3);
  const ok = new TeamworkGraphClient(async () => ({ status: 200, data: { data: { echo: 'ok' } } }), CLOUD);
  assert.deepEqual(await ok.ping(), { ok: true });
});

// ---------- gate ----------

test('contextRiskReasons: one reason per signal type, modes off/approve/deny, gaps', () => {
  const { policy } = normalizePolicy({ contextRisk: { signals: { HIGH_PRIORITY: 'off', LINKED_GOAL: 'deny' } } });
  const sig = (signal, issueKey, source = 'jira') => ({ signal, code: `CONTEXT_${signal}`, issueKey, source, message: `${issueKey} ${signal}` });
  const r = contextRiskReasons(policy, {
    signals: [sig('RELEASE_SOON', 'A-1'), sig('RELEASE_SOON', 'A-2'), sig('HIGH_PRIORITY', 'A-1'), sig('LINKED_GOAL', 'A-1', 'teamwork-graph')],
    gaps: [{ source: 'teamwork-graph', graph: true, message: 'graph down' }],
  });
  assert.deepEqual(r.approve.map((x) => x.code), ['CONTEXT_RELEASE_SOON']);
  assert.equal(r.approve[0].message, 'A-1 RELEASE_SOON; A-2 RELEASE_SOON');
  assert.deepEqual(r.deny.map((x) => [x.code, x.source]), [['CONTEXT_LINKED_GOAL', 'teamwork-graph']]);
  // Graph outage ignored by default; required (Jira) gaps always need a human.
  const strict = normalizePolicy({ contextRisk: { onGraphUnavailable: 'approve' } }).policy;
  const gap = { signals: [], gaps: [{ source: 'teamwork-graph', graph: true, message: 'graph down' }] };
  assert.equal(contextRiskReasons(policy, gap).approve.length, 0);
  assert.equal(contextRiskReasons(strict, gap).approve[0].code, 'CONTEXT_UNAVAILABLE');
  assert.equal(contextRiskReasons(policy, { signals: [], gaps: [{ source: 'jira', required: true, message: 'x' }] }).approve[0].code, 'CONTEXT_UNAVAILABLE');
  assert.equal(contextRiskReasons(strict, { signals: [], gaps: [{ source: 'jira', info: true, message: 'x' }] }).approve.length, 0, 'info gaps never escalate');
  const off = normalizePolicy({ contextRisk: { enabled: false } }).policy;
  assert.deepEqual(contextRiskReasons(off, { signals: [sig('RELEASE_SOON', 'A-1')], gaps: [] }), { deny: [], approve: [] });
});

test('policy: contextRisk is validated strictly and merged over defaults', () => {
  const ok = normalizePolicy({ contextRisk: { releaseWindowDays: 3, appliesTo: ['jira.issue.transition'] } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.policy.contextRisk.releaseWindowDays, 3);
  assert.equal(ok.policy.contextRisk.signals.RELEASE_SOON, 'approve', 'unspecified keys keep defaults');
  const bad = normalizePolicy({
    contextRisk: { foo: 1, enabled: 'yes', releaseWindowDays: -1, appliesTo: ['jira.issue.create'], signals: { NOPE: 'approve', LINKED_GOAL: 'maybe' }, onGraphUnavailable: 'deny' },
  });
  assert.equal(bad.errors.length, 7, bad.errors.join('\n'));
  assert.ok(normalizePolicy({ contextRisk: [] }).errors.includes('contextRisk must be an object'));
});

// ---------- service ----------

async function contextEnv({ policy = {}, graph = fakeGraph() } = {}) {
  const env = await setup({ policy: { requireDistinctApprover: false, ...policy }, graph });
  env.jira.state.issues['DEMO-2'].fields = releaseIn(3);
  return env;
}

test('same command, different verdict: the issue context decides', async () => {
  const env = await contextEnv();
  const move = (key) => env.svc.guardedChange('jira.issue.transition', { issueKeys: key, toStatus: 'In Review' }, ALICE);
  const plain = await move('DEMO-1');
  assert.equal(plain.status, 'EXECUTED');
  assert.deepEqual(plain.context.signals, []);
  const risky = await move('DEMO-2');
  assert.equal(risky.status, 'PENDING_APPROVAL');
  assert.deepEqual(risky.reasons.map((r) => r.code), ['CONTEXT_RELEASE_SOON']);
  assert.equal(risky.reasons[0].source, 'jira');
  assert.match(risky.reasons[0].message, /DEMO-2 ships in release "Mobile 2\.4"/);
  const stored = await env.repo.getRequest(risky.approvalId);
  assert.equal(stored.context.signals[0].signal, 'RELEASE_SOON', 'reviewer sees the context snapshot');
  assert.equal(env.writes().length, 1, 'only DEMO-1 was written');
});

test('Teamwork Graph goal link escalates; comments are not context-gated by default', async () => {
  const graph = fakeGraph({ 10000: { goals: [{ name: 'Launch checkout' }], pullRequests: [], deployments: [] } });
  const env = await contextEnv({ graph });
  const r = await env.svc.guardedChange('jira.issue.assign', { issueKeys: 'DEMO-1', assigneeAccountId: 'acct-x' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  assert.deepEqual(r.reasons.map((x) => [x.code, x.source]), [['CONTEXT_LINKED_GOAL', 'teamwork-graph']]);
  assert.deepEqual(graph.calls, [['10000']]);
  const c = await env.svc.guardedChange('jira.issue.comment', { issueKeys: 'DEMO-1', body: 'hi' }, ALICE);
  assert.equal(c.status, 'EXECUTED');
  assert.equal(graph.calls.length, 1, 'no graph call for a comment');
});

test('context that appears after approval is a NEW_RISK at run time', async () => {
  const env = await contextEnv({ policy: { protectedStatuses: ['In Review'] } });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  assert.equal((await env.svc.decideRequest(r.approvalId, true, undefined, BOB)).status, 'OK');
  env.jira.state.issues['DEMO-1'].fields = releaseIn(1); // joined a release after the decision
  env.as(ALICE);
  const run = await env.svc.runApproved(r.approvalId, ALICE);
  assert.equal(run.status, 'REFUSED');
  assert.equal(run.code, 'NEW_RISK');
  assert.deepEqual(run.reasons.map((x) => x.code), ['CONTEXT_RELEASE_SOON']);
  assert.equal(env.writes().length, 0);
});

test('a graph outage at run time asks for a new approval (fail closed)', async () => {
  const graph = fakeGraph();
  const env = await contextEnv({ graph, policy: { contextRisk: { onGraphUnavailable: 'approve' } } });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  await env.svc.decideRequest(r.approvalId, true, undefined, BOB);
  graph.workItemContext = async () => { throw new Error('graph down'); };
  env.as(ALICE);
  const run = await env.svc.runApproved(r.approvalId, ALICE);
  assert.equal(run.code, 'NEW_RISK');
  assert.deepEqual(run.reasons.map((x) => x.code), ['CONTEXT_UNAVAILABLE']);
  assert.equal(env.writes().length, 0);
});

test('graph outage: ignored by default, needs a human when policy says so', async () => {
  const down = () => fakeGraph({}, { fail: true });
  const lenient = await contextEnv({ graph: down() });
  const a = await lenient.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(a.status, 'EXECUTED');
  assert.ok(a.context.gaps.some((g) => /graph down/.test(g)));
  const strict = await contextEnv({ graph: down(), policy: { contextRisk: { onGraphUnavailable: 'approve' } } });
  const b = await strict.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(b.status, 'PENDING_APPROVAL');
  assert.deepEqual(b.reasons.map((x) => x.code), ['CONTEXT_UNAVAILABLE']);
});

test('context checks can be switched off, and deny mode blocks', async () => {
  const off = await contextEnv({ policy: { contextRisk: { enabled: false } } });
  const r = await off.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'EXECUTED');
  assert.equal(r.context, undefined);
  const deny = await contextEnv({ policy: { contextRisk: { signals: { RELEASE_SOON: 'deny' } } } });
  const d = await deny.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Review' }, ALICE);
  assert.equal(d.status, 'DENIED');
  assert.equal(deny.writes().length, 0);
});

test('preview reports context without queuing or writing', async () => {
  const env = await contextEnv();
  const p = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Review', preview: true }, ALICE, { preview: true });
  assert.equal(p.status, 'PREVIEW');
  assert.equal(p.verdict, 'NEEDS_APPROVAL');
  assert.equal(p.context.signals[0].signal, 'RELEASE_SOON');
  assert.equal((await env.repo.listOpenRequests()).length, 0);
});

test('issue-context action is read-only and uses the issue in view', async () => {
  const graph = fakeGraph({ 10001: { goals: [{ name: 'Launch checkout' }], pullRequests: [], deployments: [] } });
  const env = await contextEnv({ graph });
  const h = makeHandlers(() => env.svc);
  const r = await h.issueContext({ context: { jira: { issueKey: 'DEMO-2' } } }, { principal: { accountId: ALICE } });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.issues, ['DEMO-2']);
  assert.deepEqual(r.signals.map((s) => [s.signal, s.source, s.policy]), [['RELEASE_SOON', 'jira', 'approve'], ['LINKED_GOAL', 'teamwork-graph', 'approve']]);
  assert.equal(env.writes().length, 0);
  assert.equal((await env.repo.listAudit()).length, 0);
  assert.equal((await h.issueContext({ issueKeys: 'DEMO-1' }, {})).status, 'INVALID', 'needs a signed-in user');
  assert.equal((await h.issueContext({ issueKeys: 'nope' }, { principal: { accountId: ALICE } })).status, 'INVALID');
});

test('dashboard reports Teamwork Graph status', async () => {
  const env = await contextEnv();
  assert.deepEqual((await env.svc.dashboard(ALICE)).graphStatus, { ok: true });
  const none = await setup();
  assert.equal((await none.svc.dashboard(ALICE)).graphStatus.ok, false);
});

// ---------- simulation ----------

test('context presets: identical command, dry-run context changes the verdict, runs after approval', async () => {
  const env = await setup({ policy: { requireDistinctApprover: false } });
  env.as(BOB);
  const plain = await env.svc.simulate('routine-move', undefined, BOB);
  assert.equal(plain.status, 'EXECUTED');
  assert.equal(plain.dryRun, true);
  const ctx = await env.svc.simulate('context-move', undefined, BOB);
  assert.equal(ctx.status, 'PENDING_APPROVAL');
  assert.deepEqual(ctx.reasons.map((x) => [x.code, x.source]), [['CONTEXT_RELEASE_SOON', 'simulated'], ['CONTEXT_LINKED_GOAL', 'simulated']]);
  assert.equal(ctx.simulation.context.fixVersions[0].releaseDate, '2026-11-05');
  await env.svc.decideRequest(ctx.approvalId, true, undefined, BOB);
  const run = await env.svc.runSimulated(ctx.approvalId, BOB);
  assert.equal(run.status, 'EXECUTED');
  assert.equal(run.dryRun, true);
  assert.equal(env.writes().length, 0, 'dry runs never write to Jira');
});

// ---------- review fixes (Codex round 1) ----------

test('approver-facing reasons and stored snapshots never carry graph names; the requester sees them', async () => {
  const graph = fakeGraph({ 10001: { goals: [{ name: 'Secret acquisition' }], pullRequests: [{ name: 'hidden-pr', status: 'OPEN' }], deployments: [] } });
  const env = await contextEnv({ graph });
  env.jira.state.issues['DEMO-2'].fields = { ...releaseIn(3), issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'HR-7', fields: { status: { statusCategory: { key: 'new' } } } } }] };
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  assert.ok(r.context.signals.some((x) => /Secret acquisition/.test(x.message)), 'requester (own permissions) sees names');
  const stored = await env.repo.getRequest(r.approvalId);
  const shown = JSON.stringify({ reasons: stored.reasons, context: stored.context, reply: r.reasons });
  for (const secret of ['Secret acquisition', 'hidden-pr', 'HR-7']) assert.ok(!shown.includes(secret), secret);
  assert.match(shown, /linked to 1 active goal/);
});

test('a second target that joined an already-approved risk type is a NEW_RISK', async () => {
  const env = await contextEnv();
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2,DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  await env.svc.decideRequest(r.approvalId, true, undefined, BOB);
  env.jira.state.issues['DEMO-1'].fields = releaseIn(2);
  env.as(ALICE);
  const run = await env.svc.runApproved(r.approvalId, ALICE);
  assert.equal(run.code, 'NEW_RISK');
  assert.match(run.reasons[0].message, /DEMO-1/);
  assert.doesNotMatch(run.reasons[0].message, /DEMO-2/);
  assert.equal(env.writes().length, 0);
});

test('outage tolerance does not cover context checks that were off when the change was approved', async () => {
  const graph = fakeGraph();
  const env = await contextEnv({ graph, policy: { contextRisk: { enabled: false }, protectedStatuses: ['In Review'] } });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  await env.svc.decideRequest(r.approvalId, true, undefined, BOB);
  assert.equal((await env.svc.savePolicy({ allowedProjects: ['DEMO'], requireDistinctApprover: false, protectedStatuses: ['In Review'], contextRisk: { onGraphUnavailable: 'approve' } }, BOB)).status, 'OK');
  graph.workItemContext = async () => { throw new Error('graph down'); };
  env.as(ALICE);
  const run = await env.svc.runApproved(r.approvalId, ALICE);
  assert.equal(run.status, 'REFUSED');
  assert.ok(['NEW_RISK', 'AUTHORITY_CHANGED'].includes(run.code));
  assert.equal(env.writes().length, 0);
});

test('graph results with more pages are reported as a gap (and escalate when policy says so)', async () => {
  const graph = new TeamworkGraphClient(async (query) => ({
    status: 200,
    data: { data: { i0: { edges: query.includes('PullRequests') ? Array.from({ length: 25 }, () => ({ node: { displayName: 'm', status: 'MERGED' } })) : [], pageInfo: { hasNextPage: query.includes('PullRequests') } } } },
  }), CLOUD);
  const res = await graph.workItemContext(['10000']);
  assert.deepEqual(res.byIssue['10000'].truncated, ['pullRequests']);
  const env = await contextEnv({ graph, policy: { contextRisk: { onGraphUnavailable: 'approve' } } });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Review' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  assert.match(r.reasons[0].message, /more than 25 linked pullRequests/);
});

// ---------- review fixes (Codex round 2) ----------

test('outage tolerance needs reviewed graph context: Jira-only approvals refuse a later graph outage', async () => {
  const graph = fakeGraph({}, { fail: true }); // graph down at request time: only Jira context reviewed
  const env = await contextEnv({ graph });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-2', toStatus: 'In Progress' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  await env.svc.decideRequest(r.approvalId, true, undefined, BOB);
  await env.svc.savePolicy({ allowedProjects: ['DEMO'], requireDistinctApprover: false, contextRisk: { onGraphUnavailable: 'approve' } }, BOB);
  env.as(ALICE);
  const run = await env.svc.runApproved(r.approvalId, ALICE);
  assert.equal(run.code, 'NEW_RISK');
  assert.deepEqual(run.reasons.map((x) => x.code), ['CONTEXT_UNAVAILABLE']);
});

test('every Jira fact is evaluated: the only open blocked issue sits after 1,000 done ones', () => {
  const links = Array.from({ length: 1000 }, (_, i) => ({ type: { outward: 'blocks' }, outwardIssue: { key: `D-${i + 1}`, fields: { status: { statusCategory: { key: 'done' } } } } }));
  links.push({ type: { outward: 'blocks' }, outwardIssue: { key: 'D-1001', fields: { status: { statusCategory: { key: 'new' } } } } });
  const versions = Array.from({ length: 1000 }, () => ({ name: 'old', released: true, releaseDate: '2026-01-01' }));
  versions.push({ name: 'R1001', released: false, releaseDate: '2026-11-04' });
  const sigs = jiraSignals('A-1', issueFacts({ issuelinks: links, fixVersions: versions }), CFG, NOW);
  assert.deepEqual(sigs.map((x) => x.signal), ['RELEASE_SOON', 'BLOCKS_OPEN_WORK']);
  assert.deepEqual(sigs[1].detail.blocks, ['D-1001']);
});

test('a stalled Teamwork Graph becomes a gap within the deadline, and ping is bounded', async () => {
  const stall = () => new Promise(() => {});
  const graph = new TeamworkGraphClient(stall, CLOUD, { timeoutMs: 30, pingTimeoutMs: 30 });
  const res = await graph.workItemContext(['1']);
  assert.equal(res.errors.length, 3);
  assert.match(res.errors[0], /timed out/);
  assert.match((await graph.ping()).error, /timed out/);
});

test('dashboard does not report graph status when the policy does not use it', async () => {
  const env = await contextEnv({ policy: { contextRisk: { useTeamworkGraph: false } } });
  assert.equal((await env.svc.dashboard(ALICE)).graphStatus.ok, false);
});

// ---------- review fixes (Codex round 3) ----------

test('tightening onGraphUnavailable after a successful read still refuses a later outage', async () => {
  const graph = fakeGraph();
  const env = await contextEnv({ graph, policy: { protectedStatuses: ['In Progress'] } });
  const r = await env.svc.guardedChange('jira.issue.transition', { issueKeys: 'DEMO-1', toStatus: 'In Progress' }, ALICE);
  assert.equal(r.status, 'PENDING_APPROVAL');
  env.as(BOB);
  await env.svc.decideRequest(r.approvalId, true, undefined, BOB);
  await env.svc.savePolicy({ allowedProjects: ['DEMO'], requireDistinctApprover: false, protectedStatuses: ['In Progress'], contextRisk: { onGraphUnavailable: 'approve' } }, BOB);
  graph.workItemContext = async () => { throw new Error('graph down'); };
  env.as(ALICE);
  assert.equal((await env.svc.runApproved(r.approvalId, ALICE)).code, 'NEW_RISK');
});

test('dashboard makes no Teamwork Graph call when the policy does not use it', async () => {
  const graph = fakeGraph();
  let pings = 0;
  graph.ping = async () => { pings++; return { ok: true }; };
  for (const contextRisk of [{ enabled: false }, { useTeamworkGraph: false }]) {
    const env = await contextEnv({ graph, policy: { contextRisk } });
    await env.svc.dashboard(ALICE);
  }
  assert.equal(pings, 0);
});
