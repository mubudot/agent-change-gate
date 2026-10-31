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

const tenant = await call('GET', '/_edge/tenant_info');
const cloudId = tenant.json?.cloudId;
console.log('cloudId', cloudId ?? `(none, HTTP ${tenant.status})`);
const rovo = { 'x-cloudid': cloudId, 'x-experience-id': 'ai-mate', 'x-product': 'rovo' };

const agents = await call('GET', '/gateway/api/assist/rovo/v1/agents?limit=100', { headers: rovo });
console.log('agents HTTP', agents.status);
const list = agents.json?.values ?? agents.json?.agents ?? agents.json?.data ?? (Array.isArray(agents.json) ? agents.json : []);
const ours = list.find((a) => a?.name === AGENT_NAME);
console.log('agent count', list.length, '| ours:', ours ? JSON.stringify({ id: ours.id, name: ours.name, ...ours.external_config_reference ? { ref: ours.external_config_reference } : {} }) : 'NOT FOUND');
if (!ours) console.log(clip(agents.text, 2500));
if (!ours || !prompts.length) process.exit(ours ? 0 : 2);

const convo = await call('POST', '/gateway/api/assist/rovo/v1/chat/conversation', { headers: rovo, body: {} });
console.log('conversation HTTP', convo.status, clip(convo.text, 400));
const convoId = convo.json?.id ?? convo.json?.conversation_id;
if (!convoId) process.exit(3);

for (const prompt of prompts) {
  console.log('\n>>> USER:', prompt);
  const msg = await call('POST', `/gateway/api/assist/rovo/v1/chat/conversation/${convoId}/message/stream`, {
    headers: { ...rovo, Accept: 'text/event-stream' },
    raw: true,
    body: {
      recipient_agent_named_id: ours.named_id ?? ours.namedId,
      agent_id: ours.id,
      content: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] },
      mimeType: 'text/adf',
      context: {},
    },
  });
  console.log('message HTTP', msg.status);
  // Print the final answer text and any action/tool events; keep the raw tail for debugging.
  const lines = msg.text.split('\n').filter((l) => l.startsWith('data:'));
  let finalText = '';
  for (const l of lines) {
    let ev;
    try { ev = JSON.parse(l.slice(5)); } catch { continue; }
    const m = ev?.message ?? ev;
    const t = typeof m?.content === 'string' ? m.content : '';
    if (t) finalText = t;
    const acts = m?.action_invocations ?? m?.actions ?? m?.plugin_invocations;
    if (acts) console.log('ACTION EVENT', clip(JSON.stringify(acts), 1200));
  }
  console.log('<<< AGENT:', clip(finalText || '(no text parsed)', 3000));
  if (!finalText) console.log('RAW', clip(msg.text, 3000));
}
