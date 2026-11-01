// Stand-in Teamwork Graph for dry-run simulations. Same interface as context/graph-client.js.
/** Stand-in Teamwork Graph for dry runs: answers only from the preset's frozen synthetic context. */
export class DryRunGraph {
  constructor({ context = null, contextByIssue = null } = {}) {
    this.simulated = true;
    this.context = context;
    this.contextByIssue = contextByIssue;
  }

  async ping() {
    return { ok: true, simulated: true };
  }

  async workItemContext(issueIds) {
    const facts = (id) => {
      const context = this.contextByIssue?.[String(id)] ?? this.context;
      return { goals: context?.goals ?? [], pullRequests: context?.pullRequests ?? [], deployments: context?.deployments ?? [] };
    };
    return { byIssue: Object.fromEntries(issueIds.map((id) => [String(id), facts(id)])), errors: [], answered: ['goals', 'pullRequests', 'deployments'] };
  }
}
