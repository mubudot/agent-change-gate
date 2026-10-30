// Canonical JSON + SHA-256 so an approval is bound to one exact operation.
import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Fingerprint of the parts of an operation that change what gets written. */
export function fingerprintOperation(op) {
  const material = {
    kind: op.kind,
    targets: [...op.targets].map((t) => t.issueKey ?? `new:${t.projectKey}`).sort(),
    payload: op.payload,
  };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}
