// Dev tool (not part of the Forge bundle): checks that the Change Gate Agent is registered in Rovo on a
// site and, optionally, sends it one chat message through Rovo's own chat service.
// Runs in the forge GitHub workflow with the developer's API token (FORGE_EMAIL / FORGE_API_TOKEN).
// The Rovo chat gateway used here is Atlassian's internal web-client API, not a public contract;
// this script is a smoke test for our own site only.
//
// usage: node scripts/rovo-probe.mjs <site-host> ["prompt" ...]
//   Several prompts are sent in order into ONE conversation.
const [site, ...prompts] = process.argv.slice(2);
if (!site) throw new Error('usage: rovo-probe.mjs <site-host> [prompt...]');
const auth = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
const base = `https://${site.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
const AGENT_NAME = 'Change Gate Agent';

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
let seen = 0;
let cursor = '';
for (let page = 0; page < 20 && !ours; page++) {
  const agents = await call('GET', `/gateway/api/assist/rovo/v1/agents?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: rovo });
  const list = agents.json?.items ?? agents.json?.values ?? [];
  if (page === 0) console.log('agents HTTP', agents.status, '| page keys:', Object.keys(agents.json ?? {}).join(','));
  seen += list.length;
  ours = list.find((a) => a?.name === AGENT_NAME);
  cursor = agents.json?.next_cursor ?? agents.json?.cursor ?? agents.json?.next ?? '';
  if (!cursor || !list.length) break;
}
console.log('agents seen', seen, '| ours:', ours ? JSON.stringify({ id: ours.id, named_id: ours.named_id, creator_type: ours.creator_type, plugins: Object.keys(ours.available_plugins ?? {}), model: ours.execution_config?.model_display_name }) : 'NOT FOUND');
if (!ours || !prompts.length) process.exit(ours ? 0 : 2);

const convo = await call('POST', '/gateway/api/assist/rovo/v1/chat/conversation', { headers: rovo, body: {} });
console.log('conversation HTTP', convo.status, clip(convo.text, 400));
const convoId = convo.json?.id ?? convo.json?.conversation_id;
if (!convoId) process.exit(3);

for (const prompt of prompts) {
  console.log('\n>>> USER:', prompt);
  // The web client streams the reply; try the request shapes it has used (first one that is accepted wins).
  const adf = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] };
  const shapes = [
    { accept: '*/*', body: { recipient_agent_named_id: ours.named_id, agent_id: ours.id, content: adf, mimeType: 'text/adf', context: {} } },
    { accept: 'application/json', body: { recipient_agent_named_id: ours.named_id, agent_id: ours.id, content: adf, mimeType: 'text/adf', context: {} } },
    { accept: '*/*', body: { recipient_agent_named_id: ours.named_id, content: prompt, mimeType: 'text/markdown', context: {} } },
  ];
  let msg;
  for (const shape of shapes) {
    msg = await call('POST', `/gateway/api/assist/rovo/v1/chat/conversation/${convoId}/message/stream`, {
      headers: { ...rovo, Accept: shape.accept }, raw: true, body: shape.body,
    });
    if (msg.status === 200) break;
    console.log('shape rejected', shape.accept, typeof shape.body.content, 'HTTP', msg.status, clip(msg.text, 600));
  }
  console.log('message HTTP', msg.status);
  // Rovo streams JSON events: TRACE (tool progress), ANSWER_PART (text deltas), FINAL_RESPONSE (whole
  // message with every tool invocation, its input and output).
  const events = msg.text.split('\n').map((l) => (l.startsWith('data:') ? l.slice(5) : l)).filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let finalText = '';
  console.log('EVENTS', events.map((e) => e.type).join(' '));
  for (const ev of events) {
    if (!['TRACE', 'ANSWER_PART', 'FINAL_RESPONSE', 'RECONNECT_SUPPORTED', 'CONVERSATION_CHANNEL_DATA', 'FOLLOW_UP_QUERIES'].includes(ev.type)) console.log('EV', ev.type, clip(JSON.stringify(ev), 2500));
    if (ev.type === 'TRACE' && /Invoking tool/.test(ev.message?.content ?? '')) console.log('TRACE', ev.message.content);
    if (ev.type === 'FINAL_RESPONSE') {
      const m = ev.message?.message ?? ev.message ?? {};
      finalText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      for (const inv of m.plugin_invocations ?? []) {
        console.log('TOOL', inv.plugin_display_name, '| keys:', Object.keys(inv).join(','));
        for (const k of Object.keys(inv)) if (/input|arg|param/i.test(k)) console.log('  ', k, clip(JSON.stringify(inv[k]), 600));
        for (const k of Object.keys(inv)) if (/output|result|response/i.test(k)) console.log('  ', k, clip(typeof inv[k] === 'string' ? inv[k] : JSON.stringify(inv[k]), 1500));
        if (inv.plugin_error_message) console.log('   error', inv.plugin_error_message);
      }
    }
  }
  console.log('<<< AGENT:', clip(finalText || '(no final response)', 4000));
  if (process.env.ROVO_RAW) console.log('RAW HEAD', clip(msg.text, 4000), '\nRAW TAIL', msg.text.slice(-4000));
}
