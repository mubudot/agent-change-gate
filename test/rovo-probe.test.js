// Dev tool helpers (scripts/lib/rovo-chat.mjs): agent identity and stream parsing must not accept look-alikes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ID, DEV_ENV_ID, EXPECTED_ACTIONS, isOurAgent, missingActions, parseTurn, trustedSiteHost, turnProblem } from '../scripts/lib/rovo-chat.mjs';

const ref = (env = DEV_ENV_ID, key = 'change-gate-agent', app = APP_ID) => `b90cf5e0-839e-4d1b-89db-caae53b12bf2_ari:cloud:ecosystem::extension/${app}/${env}/static/${key}`;
const agent = (over = {}) => ({
  name: 'Change Gate Agent', creator_type: 'FORGE', external_config_reference: ref(),
  available_plugins: Object.fromEntries(EXPECTED_ACTIONS.map((k) => [k, {}])),
  action_config: EXPECTED_ACTIONS.map((id) => ({ id, invalid: false })), ...over,
});
const stream = (...events) => events.map((e) => JSON.stringify(e)).join('\n');
const final = (message) => ({ type: 'FINAL_RESPONSE', message: { message } });

test('only this app + environment agent module counts as ours', () => {
  assert.equal(isOurAgent(agent()), true);
  assert.equal(isOurAgent(agent({ creator_type: 'CUSTOMER' })), false);
  assert.equal(isOurAgent(agent({ external_config_reference: ref('11111111-2222-4333-8444-555555555555') })), false);
  assert.equal(isOurAgent(agent({ external_config_reference: ref(DEV_ENV_ID, 'other-agent') })), false);
  // An identity string only mentioned in the description is not an identity.
  assert.equal(isOurAgent(agent({ external_config_reference: undefined, description: ref() })), false);
  assert.deepEqual(missingActions(agent()), []);
  assert.deepEqual(missingActions(agent({ action_config: [{ id: 'acg-comment-issues', invalid: true }] })).length, EXPECTED_ACTIONS.length);
});

test('site host allowlist', () => {
  assert.equal(trustedSiteHost('https://one-atlas-lhur.atlassian.net/'), 'one-atlas-lhur.atlassian.net');
  for (const bad of ['attacker.example', 'x.atlassian.net.evil.com', 'x.atlassian.net@evil.com', 'a.b.atlassian.net', '']) assert.equal(trustedSiteHost(bad), null);
});

test('turn parsing: answers, our planned actions, and malformed finals', () => {
  const ok = parseTurn(stream({ type: 'TRACE', message: { content: 'Invoking tool: Check issue context' } }, final({ content: 'MOBL-12 blocks 5 open issues.' })));
  assert.equal(turnProblem(ok), null);
  assert.deepEqual(ok.traces, ['Invoking tool: Check issue context']);

  const planned = parseTurn(stream(final({ content: '', actions: [{ status: 'planned', key: 'acg-transition-issues', actionId: `ari:cloud:ecosystem::extension/${APP_ID}/${DEV_ENV_ID}/static/acg-transition-issues`, data: {} }] })));
  assert.equal(planned.planned.length, 1);
  assert.equal(turnProblem(planned), null);

  const foreign = parseTurn(stream(final({ content: '', actions: [{ status: 'planned', key: 'acg-transition-issues', actionId: 'ari:cloud:ecosystem::extension/evil/x/static/acg-transition-issues' }] })));
  assert.match(turnProblem(foreign), /neither text nor a planned action/);
  assert.match(turnProblem(parseTurn(stream(final({})))), /neither text/);
  assert.match(turnProblem(parseTurn(stream(final({ content: '   ' })))), /neither text/);
  assert.match(turnProblem(parseTurn(stream(final({ content: { not: 'text' } })))), /neither text/);
  assert.match(turnProblem(parseTurn('not json\n{broken')), /without a final response/);
  assert.match(turnProblem(parseTurn(stream({ type: 'ANSWER_PART', message: { content: 'partial' } }))), /without a final response/);
});
