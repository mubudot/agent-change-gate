// "What this work is connected to": the context the gate found, each line tagged with its source.
import React from 'react';
import { Inline, Lozenge, Stack, Text } from '@forge/react';
import { signalLabel, sourceAppearance, sourceNames } from '../format.js';

export function SourceLozenge({ source }) {
  const names = sourceNames(source);
  if (!names.length) return null;
  return <Lozenge appearance={sourceAppearance(source)}>{names.join(' + ')}</Lozenge>;
}

export function ContextSignals({ context }) {
  const signals = context?.signals ?? [];
  const gaps = context?.gaps ?? [];
  if (!signals.length && !gaps.length) {
    return <Text size="small" color="color.text.subtlest">No release, blocker, priority, goal, pull request or deployment links found.</Text>;
  }
  return (
    <Stack space="space.100">
      {signals.map((s, i) => (
        <Inline key={`${s.issueKey}-${s.signal}-${i}`} space="space.100" alignBlock="center" shouldWrap>
          <SourceLozenge source={s.source} />
          <Text weight="medium">{signalLabel(s.signal)}</Text>
          <Text>{s.message}</Text>
        </Inline>
      ))}
      {gaps.map((g, i) => (
        <Text key={`gap-${i}`} size="small" color="color.text.subtlest">{`Not checked: ${g}`}</Text>
      ))}
    </Stack>
  );
}
