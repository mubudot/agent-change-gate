// Dev tool (not part of the Forge bundle): checks that the Change Gate Agent of the development deployment is
// registered in Rovo on a site and, optionally, chats with it through Rovo's own chat service.
// Runs in the forge GitHub workflow with the developer's API token (FORGE_EMAIL / FORGE_API_TOKEN).
// The Rovo chat gateway used here is Atlassian's internal web-client API, not a public contract;
// this script is a smoke test for our own site only. Exit code is non-zero on any failed step.
//
// usage: node scripts/rovo-probe.mjs <site>.atlassian.net ["prompt" ...]   prompts go into ONE conversation
//        node scripts/rovo-probe.mjs <site>.atlassian.net peek ["JQL"]     lists projects and issues for test data
import { AGENT_NAME, APP_ID, DEV_ENV_ID, isOurAgent, missingActions, parseTurn, trustedSiteHost, turnProblem } from './lib/rovo-chat.mjs';

const [site, ...prompts] = process.argv.slice(2);
const host = trustedSiteHost(site);
if (!host) throw new Error(`refusing to send credentials to "${site}": expected <site>.atlassian.net`);
const base = `https://${host}`;
const auth = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
const fail = (code, why) => { console.log('FAIL', why); process.exit(code); };
const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + ` …[${s.length - n} more]` : s);

async function call(method, path, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

if (prompts[0] === 'peek') {
  const projects = await call('GET', '/rest/api/3/project/search?maxResults=50');
  for (const p of projects.json?.values ?? []) console.log('PROJECT', p.key, '|', p.name, '|', p.projectTypeKey);
  const jql = encodeURIComponent(prompts[1] ?? 'statusCategory != Done ORDER BY updated DESC');
  const issues = await call('GET', `/rest/api/3/search/jql?jql=${jql}&maxResults=40&fields=summary,status,priority,fixVersions,issuelinks,issuetype`);
  if (issues.status !== 200) fail(4, `search HTTP ${issues.status}`);
  for (const i of issues.json?.issues ?? []) {
    const f = i.fields;
    const fv = (f.fixVersions ?? []).map((v) => `${v.name}${v.releaseDate ? '@' + v.releaseDate : ''}${v.released ? '(released)' : ''}`).join(',');
    const blocks = (f.issuelinks ?? []).filter((l) => l.outwardIssue && /block/i.test(l.type?.outward ?? '')).map((l) => l.outwardIssue.key).join(',');
    console.log('ISSUE', i.key, '|', f.issuetype?.name, '|', f.status?.name, '|', f.priority?.name, '| fix:', fv || '-', '| blocks:', blocks || '-', '|', clip(f.summary ?? '', 70));
  }
  process.exit(0);
}

const tenant = await call('GET', '/_edge/tenant_info');
const cloudId = tenant.json?.cloudId;
if (!cloudId) fail(2, `no cloudId (HTTP ${tenant.status})`);
const rovo = { 'x-cloudid': cloudId, 'x-experience-id': 'ai-mate', 'x-product': 'rovo' };

// The agents list is paged; collect every agent that is this app's module in the development environment.
const matches = [];
let seen = 0;
let cursor = '';
for (let page = 0; page < 20; page++) {
  const agents = await call('GET', `/gateway/api/assist/rovo/v1/agents?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: rovo });
  if (agents.status !== 200) fail(2, `agents HTTP ${agents.status}`);
  const list = agents.json?.items ?? [];
  seen += list.length;
  matches.push(...list.filter((a) => isOurAgent(a, DEV_ENV_ID)));
  cursor = agents.json?.hasNext ? agents.json?.cursor ?? '' : '';
  if (!cursor || !list.length) break;
}
if (matches.length !== 1) fail(2, `${matches.length} agents are ${AGENT_NAME} of app ${APP_ID} env ${DEV_ENV_ID} (seen ${seen})`);
const ours = matches[0];
const missing = missingActions(ours);
if (missing.length) fail(2, `agent is missing actions: ${missing.join(', ')}`);
console.log('agent OK', JSON.stringify({ id: ours.id, name: ours.name, actions: Object.keys(ours.available_plugins) }), '| agents seen', seen);
if (!prompts.length) process.exit(0);

const convo = await call('POST', '/gateway/api/assist/rovo/v1/chat/conversation', { headers: rovo, body: {} });
const convoId = convo.json?.id;
if (convo.status !== 200 || !convoId) fail(3, `could not create a conversation (HTTP ${convo.status})`);

for (const prompt of prompts) {
  console.log('\n>>> USER:', prompt);
  // Same request shape as the Rovo web client: ADF content addressed to our agent; the reply is streamed.
  const adf = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] };
  const msg = await call('POST', `/gateway/api/assist/rovo/v1/chat/conversation/${convoId}/message/stream`, {
    headers: { ...rovo, Accept: '*/*' },
    raw: true,
    body: { recipient_agent_named_id: ours.named_id, agent_id: ours.id, content: adf, mimeType: 'text/adf', context: {} },
  });
  if (msg.status !== 200) fail(4, `message HTTP ${msg.status}: ${clip(msg.text, 500)}`);
  const turn = parseTurn(msg.text, DEV_ENV_ID);
  console.log('EVENTS', turn.events.join(' '));
  for (const t of turn.traces) console.log('TRACE', t);
  for (const t of turn.tools) {
    console.log('TOOL', t.name, '| input', clip(String(t.input ?? ''), 600));
    console.log('   output', clip(String(t.output ?? ''), 1500));
    if (t.error) console.log('   error', t.error);
  }
  // Rovo holds consequential actions (UPDATE/CREATE/DELETE verbs) until the user clicks Confirm in chat.
  // This script does not play that click; it reports the planned call so a person can confirm it in Rovo.
  for (const a of turn.planned) console.log('WAITING FOR ROVO CONFIRMATION', a.displayName, JSON.stringify(a.data));
  console.log('<<< AGENT:', clip(turn.finalText || '(no text)', 4000));
  const problem = turnProblem(turn);
  if (problem) fail(5, problem);
}
