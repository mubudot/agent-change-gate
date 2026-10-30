// Resolve an operation against live Jira data, then carry it out.
// Kept apart from the gate so the gate stays pure and this stays the only place that writes.

/** Replace guessed project keys with what Jira reports; resolve transitions per issue. */
export async function resolveOperation(op, jira) {
  const errors = [];
  const plan = { transitionIds: {} };
  if (op.kind === 'jira.issue.create') return { plan, errors };
  for (const t of op.targets) {
    let issue;
    try {
      issue = await jira.getIssue(t.issueKey);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    if (!issue) {
      errors.push(`${t.issueKey} does not exist or you cannot see it`);
      continue;
    }
    t.projectKey = issue.projectKey;
    t.currentStatus = issue.status;
    if (op.kind === 'jira.issue.transition') {
      const want = String(op.toStatus).toLowerCase();
      let transitions;
      try {
        transitions = await jira.getTransitions(t.issueKey);
      } catch (e) {
        errors.push(e.message);
        continue;
      }
      const match =
        transitions.find((x) => String(x.to ?? '').toLowerCase() === want) ??
        transitions.find((x) => String(x.name).toLowerCase() === want);
      if (!match) {
        errors.push(`${t.issueKey} (status ${issue.status}) has no transition to '${op.toStatus}'`);
        continue;
      }
      plan.transitionIds[t.issueKey] = match.id;
      t.toStatus = match.to ?? match.name;
    }
  }
  return { plan, errors };
}

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
      const r = await write(jira, key, op, plan);
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
