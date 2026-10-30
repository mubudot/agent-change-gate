// Resolve an operation against live Jira data, then carry it out.
// Kept apart from the gate so the gate stays pure and this stays the only place that writes.

/** Replace guessed project keys with what Jira reports; resolve transitions per issue. */
export async function resolveOperation(op, jira) {
  const errors = [];
  const plan = { transitionIds: {}, facts: {} };
  if (op.kind === 'jira.issue.create') {
    try {
      const project = await jira.getProject(op.payload.projectKey);
      if (!validId(project.id) || !project.key) throw new Error('Jira did not return a project identity');
      op.targets[0].projectKey = project.key;
      op.targets[0].projectId = String(project.id);
      op.payload.projectId = String(project.id);
    } catch (e) { errors.push(e.message); }
    return { plan, errors };
  }
  for (const t of op.targets) {
    let issue;
    try {
      issue = await jira.getIssue(t.issueId ?? t.issueKey);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    if (!issue) {
      errors.push(`${t.issueKey} does not exist or you cannot see it`);
      continue;
    }
    if (!validId(issue.id) || !validId(issue.projectId) || !issue.key) {
      errors.push(`${t.issueKey}: Jira did not return an issue/project identity`);
      continue;
    }
    t.issueId = String(issue.id);
    t.issueKey = issue.key;
    t.projectId = String(issue.projectId);
    t.projectKey = issue.projectKey;
    t.currentStatus = issue.status;
    if (issue.facts) plan.facts[t.issueId] = issue.facts;
    if (op.kind === 'jira.issue.transition') {
      const want = String(op.toStatus).toLowerCase();
      let transitions;
      try {
        transitions = await jira.getTransitions(t.issueId);
      } catch (e) {
        errors.push(e.message);
        continue;
      }
      const byStatus = transitions.filter((x) => String(x.to ?? '').toLowerCase() === want);
      const matches = byStatus.length ? byStatus : transitions.filter((x) => String(x.name).toLowerCase() === want);
      if (matches.length > 1) {
        errors.push(`${t.issueKey}: transition '${op.toStatus}' is ambiguous`);
        continue;
      }
      const match = matches[0];
      if (!match) {
        errors.push(`${t.issueKey} (status ${issue.status}) has no transition to '${op.toStatus}'`);
        continue;
      }
      if (!validId(match.id) || !validId(match.toId) || !match.to) {
        errors.push(`${t.issueKey}: Jira did not return a transition destination identity`);
        continue;
      }
      t.transitionId = String(match.id);
      t.toStatusId = String(match.toId);
      plan.transitionIds[t.issueId] = String(match.id);
      t.toStatus = match.to;
    }
  }
  // Old and new keys can both resolve to the same issue after a move.
  op.targets = op.targets.filter((t, i, all) => all.findIndex((x) => x.issueId === t.issueId) === i);
  return { plan, errors };
}

const validId = (id) => /^[1-9][0-9]*$/.test(String(id));

const WRITERS = {
  'jira.issue.comment': (jira, key, op) => jira.addComment(key, op.payload.body),
  'jira.issue.transition': (jira, key, op, plan) => jira.transition(key, plan.transitionIds[key]),
  'jira.issue.assign': (jira, key, op) => jira.assign(key, op.payload.assignee),
  'jira.issue.edit': (jira, key, op) => jira.edit(key, op.payload.changes),
  'jira.issue.create': (jira, key, op) => jira.create(op.payload),
  'jira.issue.delete': (jira, key) => jira.remove(key),
};

/** Execute target by target; never throws. Returns per-target results. */
export async function executeOperation(op, plan, jira) {
  const write = WRITERS[op.kind];
  const results = [];
  for (const t of op.targets) {
    const key = t.issueKey;
    if (!write) {
      results.push({ key, ok: false, error: `no writer for ${op.kind}` });
      continue;
    }
    try {
      const r = await write(jira, t.issueId ?? key, op, plan);
      const ok = r.status >= 200 && r.status < 300;
      results.push({ key: key ?? r.data?.key ?? null, ok, httpStatus: r.status, ...(ok ? {} : { error: jiraError(r) }) });
    } catch (e) {
      results.push({ key, ok: false, error: String(e?.message ?? e) });
    }
  }
  return results;
}

function jiraError(r) {
  const msgs = [...(r.data?.errorMessages ?? []), ...Object.values(r.data?.errors ?? {})];
  return msgs.length ? msgs.join('; ').slice(0, 300) : `HTTP ${r.status}`;
}

export function outcomeOf(results) {
  const ok = results.filter((r) => r.ok).length;
  return { okCount: ok, outcome: ok === results.length ? 'EXECUTED' : ok === 0 ? 'FAILED' : 'PARTIAL' };
}
