// Teamwork Graph reads the gate needs, as the human the agent acts for.
// Transport is injected: request(query, variables) -> Promise<{ status:number, data:any }>
// On Forge it is asUser().requestTeamworkGraph(...) (Preview API since 2026-10-15); in tests it is a fake.
//
// Uses only curated queries (typed GraphQL fields maintained by Atlassian, no Cypher registration):
//   jiraWorkItemGoals, jiraWorkItemLinkedExternalPullRequests, jiraWorkItemLinkedExternalDeployments
// https://developer.atlassian.com/platform/teamwork-graph/curated-queries/
//
// One request per family, all targets batched as aliases. GraphQL rejects a whole document on
// a schema mismatch, so a family that fails only removes that family's signals, never the others.
// Results are permission-filtered for the user; a missing scope comes back empty, not as an error.

const ISSUE_ID = /^[1-9][0-9]*$/;
const CLOUD_ID = /^[0-9a-fA-F-]{8,64}$/;
const PAGE = 25; // curated queries cap `first` at 25

export const FAMILIES = Object.freeze({
  goals: {
    field: 'jiraWorkItemGoals',
    selection: '... on AtlassianGoal { id name archived }',
    parse: (n) => ({ name: str(n.name), archived: n.archived === true }),
  },
  pullRequests: {
    field: 'jiraWorkItemLinkedExternalPullRequests',
    selection: '... on ExternalPullRequest { id displayName status url }',
    parse: (n) => ({ name: str(n.displayName), status: str(n.status), url: str(n.url) }),
  },
  deployments: {
    field: 'jiraWorkItemLinkedExternalDeployments',
    selection: '... on ExternalDeployment { id displayName state environment { type displayName } }',
    parse: (n) => ({
      name: str(n.displayName),
      state: str(n.state),
      environmentType: str(n.environment?.type),
      environment: str(n.environment?.displayName),
    }),
  },
});

const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : v == null ? null : String(v).slice(0, 200));

/** Site cloud id from a Forge context (cloudId, or the installContext ARI). */
export function cloudIdFrom(context) {
  const direct = context?.cloudId;
  if (typeof direct === 'string' && CLOUD_ID.test(direct)) return direct;
  const m = /^ari:cloud:[a-z]+::site\/([0-9a-fA-F-]{8,64})$/.exec(String(context?.installContext ?? ''));
  return m ? m[1] : null;
}

export const workItemAri = (cloudId, issueId) => `ari:cloud:jira:${cloudId}:issue/${issueId}`;

/** Build one batched curated-query document for a family. Exported for tests. */
export function buildFamilyQuery(familyKey, cloudId, issueIds) {
  const fam = FAMILIES[familyKey];
  const vars = {};
  const params = [];
  const fields = issueIds.map((id, i) => {
    vars[`i${i}`] = workItemAri(cloudId, id);
    params.push(`$i${i}: ID!`);
    return `i${i}: ${fam.field}(id: $i${i}, first: ${PAGE}) { edges { node { __typename ${fam.selection} } } }`;
  });
  const query = `query agentChangeGate_${familyKey}(${params.join(', ')}) {\n  ${fields.join('\n  ')}\n}`;
  return { query, variables: vars };
}

export class TeamworkGraphClient {
  /** @param {(query:string, variables?:object) => Promise<{status:number, data:any}>} request */
  constructor(request, cloudId) {
    this.request = request;
    this.cloudId = cloudId;
  }

  get available() {
    return Boolean(this.request && this.cloudId && CLOUD_ID.test(this.cloudId));
  }

  /** Cheap connectivity check (documented `echo` query). */
  async ping() {
    if (!this.available) return { ok: false, error: 'no site id in the Forge context' };
    try {
      const r = await this.request('query agentChangeGate_ping { echo(myString: "ok") }', {});
      const ok = r.status >= 200 && r.status < 300 && r.data?.data?.echo === 'ok';
      return ok ? { ok: true } : { ok: false, error: graphError(r) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /**
   * @param {string[]} issueIds numeric Jira issue ids
   * @returns {Promise<{byIssue: Record<string, {goals:any[], pullRequests:any[], deployments:any[]}>, errors: string[]}>}
   */
  async workItemContext(issueIds) {
    const ids = [...new Set(issueIds.map(String))].filter((id) => ISSUE_ID.test(id));
    const byIssue = Object.fromEntries(ids.map((id) => [id, { goals: [], pullRequests: [], deployments: [] }]));
    if (!ids.length) return { byIssue, errors: [] };
    if (!this.available) return { byIssue, errors: ['Teamwork Graph: no site id in the Forge context'] };
    const errors = [];
    await Promise.all(
      Object.keys(FAMILIES).map(async (fam) => {
        const { query, variables } = buildFamilyQuery(fam, this.cloudId, ids);
        let r;
        try {
          r = await this.request(query, variables);
        } catch (e) {
          errors.push(`Teamwork Graph ${fam}: ${String(e?.message ?? e).slice(0, 200)}`);
          return;
        }
        const data = r?.data?.data;
        if (r.status < 200 || r.status >= 300 || !data) {
          errors.push(`Teamwork Graph ${fam}: ${graphError(r)}`);
          return;
        }
        if (r.data.errors?.length) errors.push(`Teamwork Graph ${fam}: ${graphError(r)}`);
        ids.forEach((id, i) => {
          const edges = data[`i${i}`]?.edges;
          if (!Array.isArray(edges)) return;
          byIssue[id][fam] = edges.map((e) => e?.node).filter(Boolean).map(FAMILIES[fam].parse);
        });
      }),
    );
    return { byIssue, errors };
  }
}

function graphError(r) {
  const msgs = (r?.data?.errors ?? []).map((e) => e?.message).filter(Boolean);
  return (msgs.length ? msgs.join('; ') : `HTTP ${r?.status}`).slice(0, 300);
}
