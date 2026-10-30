// Runtime wiring: the things that only break on a live Forge site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildResolver } from '../src/resolvers.js';

// Node and the Forge bundler both treat "type": "module" code strictly, so a default import of a
// CommonJS @forge/* package is its whole module.exports object. That crashed every function at
// load time ("resolver_out_namespaceObject is not a constructor"). Backend code must use named imports.
test('backend never default-imports a CommonJS @forge package', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'frontend') walk(p); } else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk('src');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /import\s+[\w$]+\s*(,|from)[^;]*['"]@forge\//, `${f} default-imports an @forge package`);
    assert.doesNotMatch(src, /import\s+\*\s+as\s+[\w$]+\s+from\s+['"]@forge\//, `${f} namespace-imports an @forge package`);
  }
});

test('UI resolver loads under ESM and dispatches with the Forge principal', async () => {
  const calls = [];
  const service = {
    dashboard: async (accountId) => { calls.push(['dashboard', accountId]); return { status: 'OK' }; },
    decideRequest: async (...args) => { calls.push(['decide', ...args]); return { status: 'OK' }; },
    savePolicy: async (policy, accountId) => { calls.push(['savePolicy', policy, accountId]); return { status: 'OK' }; },
  };
  const handler = buildResolver(() => service);
  assert.equal(typeof handler, 'function');

  const runtime = { principal: { accountId: 'acct-alice' } };
  assert.deepEqual(await handler({ call: { functionKey: 'getDashboard' }, context: {} }, runtime), { status: 'OK' });
  await handler({ call: { functionKey: 'decide', payload: { approvalId: 'a1', approve: true } }, context: {} }, runtime);
  await handler({ call: { functionKey: 'savePolicy', payload: { policy: { x: 1 } } }, context: {} }, runtime);
  assert.deepEqual(calls, [
    ['dashboard', 'acct-alice'],
    ['decide', 'a1', true, undefined, 'acct-alice'],
    ['savePolicy', { x: 1 }, 'acct-alice'],
  ]);
  await assert.rejects(handler({ call: { functionKey: 'nope' }, context: {} }, runtime), /no definition/);
});
