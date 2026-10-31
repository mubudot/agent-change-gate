// Forge entry point: platform wiring and the asUser transport.
// Named imports only: @forge/* packages are CommonJS, so default imports are unreliable under ESM.
import { asUser, assumeTrustedRoute, getAppContext } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { KvsStore } from './store/kvs.js';
import { Repo } from './store/repo.js';
import { JiraClient } from './jira/client.js';
import { GateService } from './service.js';
import { TeamworkGraphClient, cloudIdFrom } from './context/graph-client.js';
import { makeHandlers } from './actions.js';
import { buildResolver } from './resolvers.js';
import { approvalPagePath } from './rovo/links.js';

// asUser(): every Jira call runs with the permissions of the human the agent acts for,
// so the gate can only ever narrow what that user could already do.
async function requestAsUser(method, path, body) {
  // Paths are built in jira/client.js with encodeURIComponent on every parameter.
  const res = await asUser().requestJira(assumeTrustedRoute(path), {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data };
}

// Teamwork Graph (Preview) as the same user: results are filtered by what that user may see.
async function graphAsUser(query, variables) {
  const res = await asUser().requestTeamworkGraph(query, variables);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { errors: [{ message: `non-JSON response: ${text.slice(0, 120)}` }] };
  }
  return { status: res.status, data };
}

// The Forge context (second handler argument) carries the site; Rovo payloads also include it.
const service = (context, payload) =>
  new GateService({
    repo: new Repo(new KvsStore(kvs, WhereConditions)),
    jira: new JiraClient(requestAsUser),
    graph: new TeamworkGraphClient(graphAsUser, cloudIdFrom(context) ?? cloudIdFrom(payload?.context)),
    // Link Rovo chat can show for "approve here": this app's own global page in this environment.
    approvalPage: () => approvalPagePath(getAppContext()),
  });

const h = makeHandlers(service);
export const commentIssues = h.commentIssues;
export const transitionIssues = h.transitionIssues;
export const assignIssues = h.assignIssues;
export const editIssues = h.editIssues;
export const createIssue = h.createIssue;
export const deleteIssues = h.deleteIssues;
export const runApproved = h.runApproved;
export const approvalStatus = h.approvalStatus;
export const myActivity = h.myActivity;
export const policySummary = h.policySummary;
export const issueContext = h.issueContext;

// ---- UI resolvers for the approval dashboard (jira:globalPage) ----
export const uiResolver = buildResolver(service);
