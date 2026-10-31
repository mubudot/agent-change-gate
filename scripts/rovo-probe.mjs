// Dev tool (not part of the Forge bundle): checks that the Change Gate Agent is registered in Rovo on a
// site and, optionally, sends it one chat message through Rovo's own chat service.
// Runs in the forge GitHub workflow with the developer's API token (FORGE_EMAIL / FORGE_API_TOKEN).
// The Rovo chat gateway used here is Atlassian's internal web-client API, not a public contract;
// this script is a smoke test for our own site only.
//
// usage: node scripts/rovo-probe.mjs <site-host> ["prompt" ...]
//   Several prompts are sent in order into ONE conversation.
//   node scripts/rovo-probe.mjs <site-host> peek ["JQL"]   lists projects and issues to pick test data.
const [site, ...prompts] = process.argv.slice(2);
if (!site) throw new Error('usage: rovo-probe.mjs <site-host> [prompt...]');
// The developer's credentials go only to an Atlassian Cloud site host.
const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
if (!/^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host)) throw new Error(`refusing to send credentials to "${host}": expected <site>.atlassian.net`);
const auth = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
const base = `https://${host}`;
const AGENT_NAME = 'Change Gate Agent';
// Our app and environment (default: development). The agent must come from exactly this deployment.
const APP_ID = '67a2afa4-d23d-4d5b-a9b7-1cf01c63defe';
const ENV_ID = process.env.ACG_ENV_ID ?? 'fb72e4c2-07b3-4fdf-9ba0-876c0e692990';
const EXPECTED_ACTIONS = ['acg-approval-status', 'acg-assign-issues', 'acg-comment-issues', 'acg-create-issue', 'acg-delete-issues',
  'acg-edit-issues', 'acg-issue-context', 'acg-my-activity', 'acg-policy-summary', 'acg-run-approved-change', 'acg-transition-issues'];
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

// "peek" lists projects and a few issues with release / link facts, to pick demo issues.
if (prompts[0] === 'peek') {
  const projects = await call('GET', '/rest/api/3/project/search?maxResults=50');
  for (const p of projects.json?.values ?? []) console.log('PROJECT', p.key, '|', p.name, '|', p.projectTypeKey);
  const jql = encodeURIComponent(prompts[1] ?? 'statusCategory != Done ORDER BY updated DESC');
  const issues = await call('GET', `/rest/api/3/search/jql?jql=${jql}&maxResults=40&fields=summary,status,priority,fixVersions,issuelinks,issuetype`);
  console.log('search HTTP', issues.status, issues.json ? '' : clip(issues.text, 300));
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
console.log('cloudId', cloudId ?? `(none, HTTP ${tenant.status})`);
const rovo = { 'x-cloudid': cloudId, 'x-experience-id': 'ai-mate', 'x-product': 'rovo' };

// The agents list is paged; follow the cursor until our agent shows up.
let ours;
const matches = [];
let seen = 0;
let cursor = '';
for (let page = 0; page < 20; page++) {
  const agents = await call('GET', `/gateway/api/assist/rovo/v1/agents?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: rovo });
  const list = agents.json?.items ?? agents.json?.values ?? [];
  if (page === 0) console.log('agents HTTP', agents.status, '| page keys:', Object.keys(agents.json ?? {}).join(','));
  seen += list.length;
  // Same display name is not enough: a custom agent or another deployment could share it.
  matches.push(...list.filter((a) => a?.name === AGENT_NAME && a?.creator_type === 'FORGE' && JSON.stringify(a).includes(`${APP_ID}/${ENV_ID}`)));
  cursor = agents.json?.next_cursor ?? agents.json?.cursor ?? agents.json?.next ?? '';
  if (!cursor || !list.length) break;
}
if (matches.length > 1) fail(2, `${matches.length} agents match ${AGENT_NAME} in this deployment`);
ours = matches[0];
const missing = ours ? EXPECTED_ACTIONS.filter((k) => !(k in (ours.available_plugins ?? {}))) : [];
if (missing.length) fail(2, `agent is missing actions: ${missing.join(', ')}`);
console.log('agents seen', seen, '| ours:', ours ? JSON.stringify({ id: ours.id, named_id: ours.named_id, creator_type: ours.creator_type, plugins: Object.keys(ours.available_plugins ?? {}), model: ours.execution_config?.model_display_name }) : 'NOT FOUND');
if (!ours) fail(2, `${AGENT_NAME} from app ${APP_ID} env ${ENV_ID} not found`);
if (process.env.ROVO_AGENT_DUMP) {
  const { system_prompt_template, description, user_defined_conversation_starters, ...rest } = ours;
  console.log('AGENT FIELDS', clip(JSON.stringify(rest), 3000));
}
if (!prompts.length) process.exit(0);

const convo = await call('POST', '/gateway/api/assist/rovo/v1/chat/conversation', { headers: rovo, body: {} });
console.log('conversation HTTP', convo.status, clip(convo.text, 400));
const convoId = convo.json?.id ?? convo.json?.conversation_id;
if (!convoId) fail(3, 'could not create a conversation');

for (const prompt of prompts) {
  console.log('\n>>> USER:', prompt);
  // Same request shape as the Rovo web client: ADF content addressed to our agent; reply is streamed.
  const adf = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] };
  const msg = await call('POST', `/gateway/api/assist/rovo/v1/chat/conversation/${convoId}/message/stream`, {
    headers: { ...rovo, Accept: '*/*' },
    raw: true,
    body: { recipient_agent_named_id: ours.named_id, agent_id: ours.id, content: adf, mimeType: 'text/adf', context: {} },
  });
  console.log('message HTTP', msg.status);
  if (msg.status !== 200) fail(4, `message HTTP ${msg.status}: ${clip(msg.text, 500)}`);
  // Rovo streams JSON events: TRACE (tool progress), ANSWER_PART (text deltas), FINAL_RESPONSE (whole
  // message with every tool invocation, its input and output).
  const events = msg.text.split('\n').map((l) => (l.startsWith('data:') ? l.slice(5) : l)).filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let finalText = '';
  let planned = [];
  console.log('EVENTS', events.map((e) => e.type).join(' '));
  for (const ev of events) {
    if (!['TRACE', 'ANSWER_PART', 'FINAL_RESPONSE', 'RECONNECT_SUPPORTED', 'CONVERSATION_CHANNEL_DATA', 'FOLLOW_UP_QUERIES'].includes(ev.type)) console.log('EV', ev.type, clip(JSON.stringify(ev), 2500));
    if (ev.type === 'TRACE' && /Invoking tool/.test(ev.message?.content ?? '')) console.log('TRACE', ev.message.content);
    if (ev.type === 'FINAL_RESPONSE') {
      const m = ev.message?.message ?? ev.message ?? {};
      planned = (m.actions ?? []).filter((a) => a.status === 'planned');
      finalText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const brief = Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== 'plugin_invocations' && k !== 'content' && v != null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
      console.log('FINAL META', clip(JSON.stringify(brief), 3000));
      for (const inv of m.plugin_invocations ?? []) {
        console.log('TOOL', inv.plugin_display_name, '| keys:', Object.keys(inv).join(','));
        for (const k of Object.keys(inv)) if (/input|arg|param/i.test(k)) console.log('  ', k, clip(JSON.stringify(inv[k]), 600));
        for (const k of Object.keys(inv)) if (/output|result|response/i.test(k)) console.log('  ', k, clip(typeof inv[k] === 'string' ? inv[k] : JSON.stringify(inv[k]), 1500));
        if (inv.plugin_error_message) console.log('   error', inv.plugin_error_message);
      }
    }
  }
  // Rovo holds consequential actions (UPDATE/CREATE/DELETE verbs) until the user clicks Confirm in chat.
  // This script does not play that click; it reports the planned call so a person can confirm it in Rovo.
  for (const a of planned) console.log('WAITING FOR ROVO CONFIRMATION', a.displayName, JSON.stringify(a.data));
  console.log('<<< AGENT:', clip(finalText || '(no final response)', 4000));
  if (!events.some((e) => e.type === 'FINAL_RESPONSE')) fail(5, 'stream ended without a final response');
  if (!finalText && !planned.length) fail(5, 'final response has neither text nor a planned action');
  if (process.env.ROVO_RAW) console.log('RAW HEAD', clip(msg.text, 4000), '\nRAW TAIL', msg.text.slice(-4000));
}
