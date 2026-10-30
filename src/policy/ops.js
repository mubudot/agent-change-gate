// Turn raw action inputs (flat strings/numbers chosen by an LLM) into a strict,
// normalized operation. Pure. Anything ambiguous is rejected, never guessed.

export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,9}-[1-9][0-9]{0,9}$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = /^[^\s]{1,255}$/;
const MAX_KEYS_PARSED = 200; // hard parser ceiling, independent of policy

function str(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

export function parseIssueKeys(raw, errors) {
  const s = str(raw);
  if (!s) {
    errors.push('issueKeys is required');
    return [];
  }
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (parts.length > MAX_KEYS_PARSED) {
    errors.push(`too many issue keys (${parts.length}); the parser accepts at most ${MAX_KEYS_PARSED}`);
    return [];
  }
  const keys = [];
  for (const p of parts) {
    const k = p.toUpperCase();
    if (!ISSUE_KEY.test(k)) errors.push(`'${p}' is not a valid issue key`);
    else if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

function list(raw) {
  const s = str(raw);
  if (!s) return [];
  return [...new Set(s.split(/[\s,;]+/).filter(Boolean))];
}

function targetsFromKeys(keys) {
  return keys.map((issueKey) => ({ issueKey, projectKey: issueKey.split('-')[0] }));
}

/**
 * @param {string} kind one of OPERATION_KINDS
 * @param {object} input raw action payload
 * @returns {{ op: object|null, errors: string[] }}
 */
export function buildOperation(kind, input = {}) {
  const errors = [];
  let op = null;
  switch (kind) {
    case 'jira.issue.comment': {
      const keys = parseIssueKeys(input.issueKeys, errors);
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (!body) errors.push('body is required');
      op = { kind, targets: targetsFromKeys(keys), payload: { body }, fields: [] };
      break;
    }
    case 'jira.issue.transition': {
      const keys = parseIssueKeys(input.issueKeys, errors);
      const to = str(input.toStatus);
      if (!to) errors.push('toStatus is required');
      op = { kind, targets: targetsFromKeys(keys), payload: { toStatus: to }, fields: [], toStatus: to };
      break;
    }
    case 'jira.issue.assign': {
      const keys = parseIssueKeys(input.issueKeys, errors);
      const a = str(input.assigneeAccountId);
      let assignee;
      if (!a) errors.push('assigneeAccountId is required (use "none" to unassign)');
      else if (a.toLowerCase() === 'none') assignee = null;
      else if (!ACCOUNT_ID.test(a)) errors.push('assigneeAccountId is not a valid accountId');
      else assignee = a;
      op = { kind, targets: targetsFromKeys(keys), payload: { assignee }, fields: ['assignee'] };
      break;
    }
    case 'jira.issue.edit': {
      const keys = parseIssueKeys(input.issueKeys, errors);
      const changes = {};
      const summary = str(input.summary);
      if (summary !== undefined) {
        if (summary.length > 255) errors.push('summary must be at most 255 characters');
        changes.summary = summary;
      }
      const priority = str(input.priority);
      if (priority !== undefined) changes.priority = priority;
      const due = str(input.dueDate);
      if (due !== undefined) {
        if (!DATE.test(due)) errors.push('dueDate must be YYYY-MM-DD');
        changes.duedate = due;
      }
      const add = list(input.labelsAdd);
      const remove = list(input.labelsRemove);
      for (const l of [...add, ...remove]) if (!LABEL.test(l)) errors.push(`invalid label '${l}'`);
      if (add.some((l) => remove.includes(l))) errors.push('a label cannot be both added and removed');
      if (add.length || remove.length) changes.labels = { add: add.sort(), remove: remove.sort() };
      if (Object.keys(changes).length === 0) errors.push('no supported field to change (summary, priority, dueDate, labelsAdd, labelsRemove)');
      op = { kind, targets: targetsFromKeys(keys), payload: { changes }, fields: Object.keys(changes) };
      break;
    }
    case 'jira.issue.create': {
      const projectKey = str(input.projectKey)?.toUpperCase();
      if (!projectKey || !PROJECT_KEY.test(projectKey)) errors.push('projectKey is required and must be a valid project key');
      const issueType = str(input.issueType) ?? 'Task';
      const summary = str(input.summary);
      if (!summary) errors.push('summary is required');
      else if (summary.length > 255) errors.push('summary must be at most 255 characters');
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      op = {
        kind,
        targets: [{ issueKey: null, projectKey: projectKey ?? '' }],
        payload: { projectKey, issueType, summary, description },
        fields: ['summary', 'issuetype', ...(description ? ['description'] : [])],
      };
      break;
    }
    case 'jira.issue.delete': {
      const keys = parseIssueKeys(input.issueKeys, errors);
      op = { kind, targets: targetsFromKeys(keys), payload: {}, fields: [] };
      break;
    }
    default:
      errors.push(`unsupported operation '${kind}'`);
  }
  if (op && op.targets.length === 0 && !errors.length) errors.push('no targets');
  return { op: errors.length ? null : op, errors };
}
