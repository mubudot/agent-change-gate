// Shared by both live comparison presets. The gate still resolves and checks the
// selected transition again under its mutation lease before any write.
export function progressDestination(issueKey, transitions) {
  const named = (value) => String(value ?? '').toLowerCase() === 'in progress';
  const match = transitions.find((t) => named(t.to) || named(t.name))
    ?? transitions.find((t) => t.toCategory === 'indeterminate');
  if (match?.to) return { destination: match.to };
  const available = transitions.map((t) => `${t.name || '(unnamed)'} → ${t.to || '(unknown status)'}`).join(', ') || 'none';
  return { error: `${issueKey} has no available In Progress destination or transition into an in-progress status category. Available transitions: ${available}.` };
}
