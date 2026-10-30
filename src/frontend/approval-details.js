// Render all approved material as plain text, including the full write payload.
// Do not truncate: the approver must be able to inspect the exact change.
export function approvalDetails(request) {
  return JSON.stringify({
    requester: request.requester,
    expiresAt: new Date(request.expiresAt).toISOString(),
    operation: request.op.kind,
    targets: request.op.targets,
    payload: request.op.payload,
    fingerprint: request.fingerprint,
  }, null, 2);
}
