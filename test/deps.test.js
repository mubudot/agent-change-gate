import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// @forge/react 12 renders through react-reconciler 0.29 (React 18). A second React major at the
// root makes the app's hooks run against a different React copy than the reconciler, so the
// UI Kit page throws before its first render and Jira shows loading skeletons forever.
test('frontend pins the same React major that @forge/react renders with', () => {
  assert.match(pkg.dependencies['@forge/react'] ?? '', /^\^?12\./);
  assert.match(pkg.dependencies.react ?? '', /^\^?18\./);
  assert.ok(pkg.dependencies['@forge/bridge'], '@forge/bridge must be a direct dependency for invoke()');
});
