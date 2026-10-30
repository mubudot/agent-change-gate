// Jira Cloud REST v3 calls the gate needs. Transport is injected:
//   request(method, path, body?) -> Promise<{ status:number, data:any }>
// On Forge it is api.asUser().requestJira(...) so Jira's own permissions still apply
// to the human the agent acts for; in tests it is a fake.

const enc = encodeURIComponent;

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
    const r = await this.request('GET', `/rest/api/3/issue/${enc(key)}?fields=project,status,summary`);
    if (r.status === 404) return null;
    ensureOk(r, `read ${key}`);
    return {
      key: r.data.key,
      projectKey: r.data.fields?.project?.key,
      status: r.data.fields?.status?.name,
      summary: r.data.fields?.summary,
    };
  }

  async getTransitions(key) {
    const r = await this.request('GET', `/rest/api/3/issue/${enc(key)}/transitions`);
    ensureOk(r, `list transitions of ${key}`);
    return (r.data.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
  }

  async isJiraAdmin() {
    const r = await this.request('GET', '/rest/api/3/mypermissions?permissions=ADMINISTER');
    if (r.status >= 400) return false;
    return r.data?.permissions?.ADMINISTER?.havePermission === true;
  }

  async addComment(key, body) {
    return this.request('POST', `/rest/api/3/issue/${enc(key)}/comment`, { body: adfText(body) });
  }

  async transition(key, transitionId) {
    return this.request('POST', `/rest/api/3/issue/${enc(key)}/transitions`, { transition: { id: String(transitionId) } });
  }

  async assign(key, accountId) {
    return this.request('PUT', `/rest/api/3/issue/${enc(key)}/assignee`, { accountId });
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
    return this.request('PUT', `/rest/api/3/issue/${enc(key)}`, { fields, update });
  }

  async create({ projectKey, issueType, summary, description }) {
    const fields = { project: { key: projectKey }, issuetype: { name: issueType }, summary };
    if (description) fields.description = adfText(description);
    return this.request('POST', '/rest/api/3/issue', { fields });
  }

  async remove(key) {
    return this.request('DELETE', `/rest/api/3/issue/${enc(key)}`);
  }
}

function ensureOk(r, what) {
  if (r.status >= 400) {
    const err = new Error(`Jira refused to ${what} (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
}
