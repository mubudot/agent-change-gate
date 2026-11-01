// Guided demo presentation only; the server enforces order and chooses the data.
export const DEMO_STEPS = [
  { id: 1, title: 'Routine change', explanation: 'Move DEMO-1 to In Progress. No release, no links.', action: 'Run routine change' },
  { id: 2, title: 'Same command, risky context', explanation: 'Move DEMO-2 to In Progress. Its fix version ships in 3 days and it is linked to a company goal.', action: 'Request risky change' },
  { id: 3, title: 'Review as the approver', explanation: "Approve the request. Approvers see count-only context, e.g. 'linked to 1 active goal'.", action: 'Approve' },
  { id: 4, title: 'Run the approved change once', explanation: 'The approval is single-use. No Jira writes.', action: 'Run approved change' },
  { id: 5, title: 'Runaway bulk close', explanation: 'An agent tries to close 21 issues in one call.', action: 'Try bulk close' },
];

export const showGuidedDemoHint = (data) => Boolean(data?.isAdmin && data.policy?.allowedProjects?.length === 0);

/** Fresh install: show the demo tools expanded. Configured gate: approval queue first, tools on demand. */
export const adminToolsExpanded = (data) => showGuidedDemoHint(data);

export function demoStepButton(demo, step, busy = false) {
  return { appearance: demo?.nextStep === step ? 'primary' : 'default', isDisabled: busy || demo?.nextStep !== step };
}

/** Gate verdict for decisions, approval/execution status for the rest. */
export function demoResult(result) {
  if (!result) return null;
  return {
    label: result.verdict ? result.verdict.replaceAll('_', ' ') : result.status === 'OK' ? result.approvalStatus : result.status,
    detail: result.dryRun && result.status === 'EXECUTED' ? (result.verdict === 'ALLOW' ? 'EXECUTED (dry run)' : '(dry run)') : '',
    codes: [...new Set([...(result.reasons ?? []).map((r) => r.code), result.code].filter(Boolean))],
  };
}
