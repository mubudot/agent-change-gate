// Demo presets for the admin "Simulate agent request" panel. Pure: (preset, policy, issueKey) -> a raw
// action input, exactly what a Rovo/MCP action would send. The gate decides; presets never pick a verdict.
import { ISSUE_KEY, PROJECT_KEY } from '../policy/ops.js';

const DRY_RUN_ISSUE = 9001; // synthetic issue numbers in dry-run mode, never read from or written to Jira

export const PRESETS = Object.freeze({
  'allow-comment': {
    label: 'Low-risk comment',
    expect: 'ALLOW',
    build: ({ keys }) => ({
      kind: 'jira.issue.comment',
      input: {
        issueKeys: keys(1).join(','),
        body: 'Status summary from the Change Gate Agent (simulated request): no blockers, review scheduled for Thursday.',
      },
    }),
  },
  'approval-transition': {
    label: 'Move into a protected status',
    expect: 'NEEDS_APPROVAL',
    build: ({ keys, policy }) => ({
      kind: 'jira.issue.transition',
      input: { issueKeys: keys(1).join(','), toStatus: policy.protectedStatuses[0] ?? 'Done' },
    }),
  },
  'blocked-bulk': {
    label: 'Runaway bulk close',
    expect: 'DENY',
    // One more issue than the hard per-call limit: the gate denies on size before any Jira read.
    build: ({ keys, policy }) => ({
      kind: 'jira.issue.transition',
      input: { issueKeys: keys(policy.maxTargetsPerCall + 1).join(','), toStatus: policy.protectedStatuses[0] ?? 'Done' },
    }),
  },
});

/**
 * @param {string} presetId key of PRESETS
 * @param {object} policy normalized policy
 * @param {string|undefined} rawIssueKey optional real issue; without it the request is a dry run
 * @returns {{ plan?: {kind:string, input:object, simulation:object}, error?: string }}
 */
export function buildPreset(presetId, policy, rawIssueKey) {
  const preset = Object.hasOwn(PRESETS, presetId) ? PRESETS[presetId] : null;
  if (!preset) return { error: `unknown preset '${presetId}'` };
  const issueKey = typeof rawIssueKey === 'string' ? rawIssueKey.trim().toUpperCase() : '';
  if (issueKey && !ISSUE_KEY.test(issueKey)) return { error: `'${rawIssueKey}' is not a valid issue key` };

  const live = Boolean(issueKey);
  const fallbackProject = policy.allowedProjects.find((p) => PROJECT_KEY.test(p)) ?? 'DEMO';
  const projectKey = live ? issueKey.split('-')[0] : fallbackProject;
  const first = live ? Number(issueKey.split('-')[1]) : DRY_RUN_ISSUE;
  const keys = (n) => Array.from({ length: n }, (_, i) => `${projectKey}-${first + i}`);
  const { kind, input } = preset.build({ keys, policy });
  const simulation = {
    preset: presetId,
    mode: live ? 'live' : 'dry-run',
    projectKey,
    extraStatuses: input.toStatus ? [input.toStatus] : [],
  };
  return { plan: { kind, input, simulation } };
}

export const presetList = () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, expect: p.expect }));
