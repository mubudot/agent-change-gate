// Where the human approves: the app's Jira global page, as a site-relative path that Rovo chat
// renders as a link. Built from the Forge app context (app + environment ARIs), never from LLM input.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last path segment of an ARI if it is a UUID, else null. */
function uuidOf(ari) {
  if (typeof ari !== 'string') return null;
  const last = ari.split('/').pop();
  return UUID.test(last) ? last.toLowerCase() : null;
}

/**
 * @param {{appAri?: unknown, environmentAri?: unknown} | null | undefined} appContext
 *   appAri: ari:cloud:ecosystem::app/<appId>; environmentAri: ari:cloud:ecosystem::environment/<appId>/<envId>
 * @returns {string | null} e.g. /jira/apps/<appId>/<envId>
 */
export function approvalPagePath(appContext) {
  // @forge/api returns ARIs as objects with toString(); plain strings work too.
  const appAri = appContext?.appAri == null ? null : String(appContext.appAri);
  const envAri = appContext?.environmentAri == null ? null : String(appContext.environmentAri);
  const app = uuidOf(appAri);
  const env = uuidOf(envAri);
  if (!app || !env) return null;
  // The environment ARI names its app; refuse a mismatched pair rather than link to another app.
  if (!envAri.toLowerCase().includes(`/${app}/`)) return null;
  return `/jira/apps/${app}/${env}`;
}

/** Plain-language hint for the agent: where to approve. */
export function approvalPlace(pagePath) {
  return pagePath
    ? `the Agent Change Gate page in Jira (${pagePath})`
    : 'the Agent Change Gate page in Jira (Apps menu)';
}
