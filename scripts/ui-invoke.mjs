// Dev tool (not part of the Forge bundle): calls one of the approval page's UI resolvers the way the
// page does (Forge invokeExtension through the site's GraphQL gateway), signed in as the developer
// account via its API token. Used in CI to drive end-to-end tests on our own demo site: the same
// resolver code, identity checks and policy rules apply as when a person clicks in the page.
//
// usage: node scripts/ui-invoke.mjs <site-host> <envId> <functionKey> ['{"json":"payload"}']
const [site, envId, functionKey, json = '{}'] = process.argv.slice(2);
if (!site || !envId || !functionKey) throw new Error('usage: ui-invoke.mjs <site-host> <envId> <functionKey> [json]');
const APP_ID = '67a2afa4-d23d-4d5b-a9b7-1cf01c63defe';
const MODULE_KEY = 'change-gate-page';
const auth = 'Basic ' + Buffer.from(`${process.env.FORGE_EMAIL}:${process.env.FORGE_API_TOKEN}`).toString('base64');
const base = `https://${site.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

const tenant = await (await fetch(`${base}/_edge/tenant_info`)).json();
const cloudId = tenant.cloudId;
const extensionId = `ari:cloud:ecosystem::extension/${APP_ID}/${envId}/static/${MODULE_KEY}`;
const query = `mutation forge_ui_invokeExtension($input: InvokeExtensionInput!) {
  invokeExtension(input: $input) {
    success
    response { body }
    errors { message extensions { errorType statusCode } }
  }
}`;
const variables = {
  input: {
    contextIds: [`ari:cloud:jira::site/${cloudId}`],
    extensionId,
    entryPoint: process.env.UI_ENTRY ?? 'resolver',
    payload: {
      call: { functionKey, payload: JSON.parse(json) },
      context: { cloudId, moduleKey: MODULE_KEY, siteUrl: base, extension: { type: 'jira:globalPage' } },
    },
  },
};
const res = await fetch(`${base}/gateway/api/graphql`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ query, variables }),
});
const text = await res.text();
console.log('HTTP', res.status);
let out;
try { out = JSON.parse(text); } catch { console.log(text.slice(0, 2000)); process.exit(1); }
const r = out?.data?.invokeExtension;
if (!r?.success) { console.log(JSON.stringify(out).slice(0, 3000)); process.exit(1); }
const body = r.response?.body;
console.log(JSON.stringify(body, null, 1).slice(0, Number(process.env.UI_OUT_MAX ?? 6000)));
