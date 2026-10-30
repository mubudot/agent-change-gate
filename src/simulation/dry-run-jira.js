// Stand-in Jira client for dry-run simulations. Same interface as jira/client.js, so the gate engine
// (resolve -> evaluate -> approve -> execute -> audit) runs unchanged, but nothing reaches Jira:
// reads describe a synthetic issue in one project and writes succeed without doing anything.
import { ISSUE_KEY, PROJECT_KEY } from '../policy/ops.js';

const BASE_STATUSES = ['In Progress', 'In Review', 'Done'];
const DRY_PROJECT_ID = '1';
const ok = () => ({ status: 200, data: { dryRun: true } });

export class DryRunJira {
  /** @param {{projectKey: string, extraStatuses?: string[]}} simulation stored with the request */
  constructor({ projectKey, extraStatuses = [] }) {
    if (!PROJECT_KEY.test(String(projectKey))) throw new Error('dry run needs a valid project key');
    this.dryRun = true;
    this.projectKey = projectKey;
    // Order is fixed so transition ids are identical when the request is created and when it runs.
    this.statuses = [...new Set([...BASE_STATUSES, ...extraStatuses.filter((s) => typeof s === 'string' && s)])];
  }

  // Issue id == issue number, so a stored op addressed by id resolves to the same synthetic issue.
  async getIssue(ref) {
    const s = String(ref);
    const key = /^[1-9][0-9]*$/.test(s) ? `${this.projectKey}-${s}` : s;
    if (!ISSUE_KEY.test(key) || key.split('-')[0] !== this.projectKey) return null;
    return { id: key.split('-')[1], key, projectId: DRY_PROJECT_ID, projectKey: this.projectKey, status: 'To Do', summary: 'Simulated issue' };
  }

  async getProject(key) {
    if (key !== this.projectKey) throw new Error(`dry run only knows project ${this.projectKey}`);
    return { id: DRY_PROJECT_ID, key };
  }

  async getTransitions() {
    return this.statuses.map((to, i) => ({ id: String(11 + i), name: to, to, toId: String(1 + i) }));
  }

  // Never grants authority: admin and approver checks always use the real Jira client.
  async isJiraAdmin() {
    return false;
  }

  async addComment() { return ok(); }
  async transition() { return ok(); }
  async assign() { return ok(); }
  async edit() { return ok(); }
  async create() { return ok(); }
  async remove() { return ok(); }
}
