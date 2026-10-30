// Stand-in Teamwork Graph for dry-run simulations. Same interface as context/graph-client.js.
/** Stand-in Teamwork Graph for dry runs: answers only from the preset's frozen synthetic context. */
export class DryRunGraph {
  constructor({ context = null } = {}) {
    this.simulated = true;
    this.context = context;
  }

  async ping() {
    return { ok: true, simulated: true };
  }

  async workItemContext(issueIds) {
    const facts = { goals: this.context?.goals ?? [], pullRequests: this.context?.pullRequests ?? [], deployments: this.context?.deployments ?? [] };
    return { byIssue: Object.fromEntries(issueIds.map((id) => [String(id), facts])), errors: [], answered: ['goals', 'pullRequests', 'deployments'] };
  }
}
