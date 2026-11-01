// UI Kit (@forge/react) forwards some props, e.g. DynamicTable's emptyView, to the host
// without reconciling them; a React element there breaks the bridge payload. Guard statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/frontend/components/', import.meta.url);

test('no frontend component passes JSX to DynamicTable emptyView', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsx'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(src, /emptyView=\{\s*</, `${file} passes a React element as emptyView`);
  }
});
