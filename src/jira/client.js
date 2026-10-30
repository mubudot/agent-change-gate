// Jira Cloud REST v3 calls the gate needs. Transport is injected:
//   request(method, path, body?) -> Promise<{ status:number, data:any }>
// On Forge it is api.asUser().requestJira(...) so Jira's own permissions still apply
// to the human the agent acts for; in tests it is a fake.

import { ISSUE_KEY, PROJECT_KEY } from '../policy/ops.js';

function issueRef(value) {
  const ref = String(value);
  if (!ISSUE_KEY.test(ref) && !/^[1-9][0-9]*$/.test(ref)) throw new Error('invalid Jira issue reference');
  return encodeURIComponent(ref);
}

export function adfText(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => ({ type: 'paragraph', content: p ? [{ type: 'text', text: p }] : [] }));
  return { type: 'doc', version: 1, content: paragraphs };
}

export class JiraClient {
  constructor(request) {
    this.request = request;
  }

  async getIssue(key) {
    const r = await this.request('GET', `/rest/api/3/issue/${issueRef(key)}?fields=project,status,summary`);
    if (r.status === 404) return null;
    ensureOk(r, `read ${key}`);
    return {
      id: r.data.id,
      key: r.data.key,
      projectId: r.data.fields?.project?.id,
      projectKey: r.data.fields?.project?.key,
      status: r.data.fields?.status?.name,
      summary: r.data.fields?.summary,
    };
  }

  async getProject(key) {
    if (!PROJECT_KEY.test(key)) throw new Error('invalid Jira project key');
    const r = await this.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}`);
    ensureOk(r, `read project ${key}`);
    return { id: r.data.id, key: r.data.key };
  }

  async getTransitions(key) {
    const r = await this.request('GET', `/rest/api/3/issue/${issueRef(key)}/transitions`);
    ensureOk(r, `list transitions of ${key}`);
    return (r.data.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name, toId: t.to?.id }));
  }

  async isJiraAdmin() {
    const r = await this.request('GET', '/rest/api/3/mypermissions?permissions=ADMINISTER');
    if (r.status < 200 || r.status >= 300) return false;
    return r.data?.permissions?.ADMINISTER?.havePermission === true;
  }

  async addComment(key, body) {
    return this.request('POST', `/rest/api/3/issue/${issueRef(key)}/comment`, { body: adfText(body) });
  }

  async transition(key, transitionId) {
    return this.request('POST', `/rest/api/3/issue/${issueRef(key)}/transitions`, { transition: { id: String(transitionId) } });
  }

  async assign(key, accountId) {
    return this.request('PUT', `/rest/api/3/issue/${issueRef(key)}/assignee`, { accountId });
  }

  async edit(key, changes) {
    const fields = {};
    const update = {};
    if (changes.summary !== undefined) fields.summary = changes.summary;
    if (changes.priority !== undefined) fields.priority = { name: changes.priority };
    if (changes.duedate !== undefined) fields.duedate = changes.duedate;
    if (changes.labels) {
      update.labels = [...changes.labels.add.map((l) => ({ add: l })), ...changes.labels.remove.map((l) => ({ remove: l }))];
    }
    return this.request('PUT', `/rest/api/3/issue/${issueRef(key)}`, { fields, update });
  }

  async create({ projectId, issueType, summary, description }) {
    const fields = { project: { id: projectId }, issuetype: { name: issueType }, summary };
    if (description) fields.description = adfText(description);
    return this.request('POST', '/rest/api/3/issue', { fields });
  }

  async remove(key) {
    return this.request('DELETE', `/rest/api/3/issue/${issueRef(key)}`);
  }
}

function ensureOk(r, what) {
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`Jira refused to ${what} (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
}
