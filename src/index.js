// Forge entry point. The only file (with store/kvs.js and frontend/) that imports @forge/*.
import api, { assumeTrustedRoute } from '@forge/api';
import { KvsStore } from './store/kvs.js';
import { Repo } from './store/repo.js';
import { JiraClient } from './jira/client.js';
import { GateService } from './service.js';
import { makeHandlers } from './actions.js';
import { buildResolver } from './resolvers.js';

// asUser(): every Jira call runs with the permissions of the human the agent acts for,
// so the gate can only ever narrow what that user could already do.
async function requestAsUser(method, path, body) {
  // Paths are built in jira/client.js with encodeURIComponent on every parameter.
  const res = await api.asUser().requestJira(assumeTrustedRoute(path), {
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

const service = () => new GateService({ repo: new Repo(new KvsStore()), jira: new JiraClient(requestAsUser) });

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

// ---- UI resolvers for the approval dashboard (jira:globalPage) ----
export const uiResolver = buildResolver(service);
