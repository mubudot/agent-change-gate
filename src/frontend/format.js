// Pure display helpers for the dashboard. No Forge or React imports, so they are unit-tested.

const OPERATION_LABELS = {
  'jira.issue.comment': 'Comment',
  'jira.issue.transition': 'Transition',
  'jira.issue.assign': 'Assign',
  'jira.issue.edit': 'Edit fields',
  'jira.issue.create': 'Create issue',
  'jira.issue.delete': 'Delete',
  'policy.update': 'Policy update',
};

export const operationLabel = (kind) => OPERATION_LABELS[kind] ?? kind;

// Lozenge appearances: success (green), removed (red), moved (yellow), inprogress (blue), default (grey).
const STATUS_APPEARANCE = {
  PENDING: 'moved',
  APPROVED: 'success',
  EXECUTED: 'success',
  REJECTED: 'removed',
  FAILED: 'removed',
  EXPIRED: 'default',
};
export const statusAppearance = (status) => STATUS_APPEARANCE[status] ?? 'default';

const VERDICT_APPEARANCE = { ALLOW: 'success', DENY: 'removed', NEEDS_APPROVAL: 'moved', ADMIN: 'inprogress' };
export const verdictAppearance = (verdict) => VERDICT_APPEARANCE[verdict] ?? 'default';

/** "30 Oct 2026, 16:31" in the viewer's locale and time zone. */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "just now", "5 min ago", "in 3 h", "2 d ago". */
export function relativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const [value, unit] =
    abs < 3_600_000 ? [Math.round(abs / 60_000), 'min'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] : [Math.round(abs / 86_400_000), 'd'];
  return diff < 0 ? `${value} ${unit} ago` : `in ${value} ${unit}`;
}

/** Issue keys of a request, or "new issue in DEMO" for creates. */
export function targetList(targets = []) {
  const keys = targets.map((t) => t.issueKey ?? (t.projectKey ? `new issue in ${t.projectKey}` : null)).filter(Boolean);
  return keys.length ? keys.join(', ') : '—';
}

/** One-line human summary of a pending change; the full payload is shown in the review dialog. */
export function changeSummary(op) {
  const p = op?.payload ?? {};
  switch (op?.kind) {
    case 'jira.issue.comment':
      return `Add a comment (${String(p.body ?? '').length} characters)`;
    case 'jira.issue.transition':
      return `Move to "${p.toStatus ?? 'another status'}"`;
    case 'jira.issue.assign':
      return p.assignee ? 'Change the assignee' : 'Unassign';
    case 'jira.issue.edit':
      return `Change ${Object.keys(p.changes ?? {}).join(', ') || 'fields'}`;
    case 'jira.issue.create':
      return `Create "${p.summary ?? ''}"`;
    case 'jira.issue.delete':
      return 'Delete permanently';
    default:
      return operationLabel(op?.kind);
  }
}

export const countPending = (requests = []) => requests.filter((r) => r.status === 'PENDING').length;

/** Who started a gate decision: an agent (Rovo/MCP), the admin demo panel, or an admin. */
export function sourceLabel(entry) {
  if (entry?.source === 'simulated') return entry.dryRun || entry.simulation?.mode === 'dry-run' ? 'Simulated (dry run)' : 'Simulated (live)';
  if (entry?.source === 'admin' || entry?.kind === 'policy.update') return 'Admin';
  return 'Agent';
}

/** Feedback text for a simulate / runSimulated result. tone: success | warning | error | information. */
export function simulationMessage(r) {
  const why = (r?.reasons ?? []).map((x) => x.message).join(' · ');
  const dry = r?.dryRun ? ' Dry run: Jira was not changed.' : '';
  switch (r?.status) {
    case 'EXECUTED':
      // runApproved results carry approvedBy; a direct ALLOW from simulate does not.
      if (r.approvedBy) {
        return { tone: 'success', text: r.dryRun ? 'Approved change ran once (dry run): Jira was not changed.' : 'Approved change ran once and was written to Jira.' };
      }
      return { tone: 'success', text: `Gate verdict ALLOW: the change ran.${dry}` };
    case 'PARTIAL':
    case 'FAILED':
      return { tone: 'warning', text: `The gate allowed it but Jira refused some writes: ${(r.results ?? []).filter((x) => !x.ok).map((x) => `${x.key}: ${x.error}`).join('; ')}` };
    case 'PENDING_APPROVAL':
      return {
        tone: 'information',
        text: `Gate verdict NEEDS APPROVAL (${why}). It is waiting in the approvals table; nothing was changed.`,
        approvalId: r.approvalId,
      };
    case 'DENIED':
      return { tone: 'error', text: `Gate verdict DENY: ${why}. Nothing was changed.` };
    case 'REFUSED':
      return { tone: 'warning', text: r.message || `Refused (${r.code}).` };
    default:
      return { tone: 'warning', text: (r?.errors ?? []).join('; ') || r?.message || 'The request was not completed.' };
  }
}

/**
 * The simulator's NEEDS APPROVAL banner describes a request at the moment it was queued. Once that
 * request is decided elsewhere (Approvals tab), replace the stale banner with its current state.
 */
export function currentSimulationMessage(message, simulations = []) {
  if (!message?.approvalId) return message;
  const req = simulations.find((s) => s.id === message.approvalId);
  if (!req || req.status === 'PENDING') return message;
  switch (req.status) {
    case 'APPROVED':
      return { tone: 'success', text: 'Approved. Click "Run approved change" below to run it once.' };
    case 'REJECTED':
      return { tone: 'warning', text: 'The approver rejected this request. Nothing was changed.' };
    case 'EXPIRED':
      return { tone: 'warning', text: 'This request expired before it ran. Nothing was changed.' };
    default:
      return null; // EXECUTED / FAILED: the table row now shows the outcome.
  }
}

/** One-line caps summary. The gate asks for approval only when a call touches MORE than the threshold. */
export function capsSummary(policy) {
  const n = policy.bulkApprovalThreshold;
  return [
    `More than ${n} ${n === 1 ? 'issue' : 'issues'} in one call need approval`,
    `max ${policy.maxTargetsPerCall} per call`,
    `${policy.perActorHourlyLimit}/h and ${policy.perActorDailyLimit}/day per user`,
    `${policy.siteDailyLimit}/day per site`,
  ].join(' · ');
}
