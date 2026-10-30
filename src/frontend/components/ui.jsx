// Small shared building blocks for the dashboard.
import React from 'react';
import { Box, Lozenge, SectionMessage, Stack, Text, xcss } from '@forge/react';
import { statusAppearance } from '../format.js';

export const cardStyle = xcss({
  borderColor: 'color.border',
  borderStyle: 'solid',
  borderWidth: 'border.width',
  borderRadius: 'border.radius',
  padding: 'space.200',
  backgroundColor: 'elevation.surface.raised',
});

export function Card({ children }) {
  return <Box xcss={cardStyle}>{children}</Box>;
}

export function StatusLozenge({ status }) {
  return <Lozenge appearance={statusAppearance(status)}>{status}</Lozenge>;
}

/** Friendly empty state shown instead of an empty table. */
export function EmptyNotice({ title, children }) {
  return (
    <SectionMessage appearance="information" title={title}>
      <Text>{children}</Text>
    </SectionMessage>
  );
}

/** Feedback after an action: success, warning or error. */
export function Feedback({ message }) {
  if (!message) return null;
  return (
    <SectionMessage appearance={message.tone}>
      <Text>{message.text}</Text>
    </SectionMessage>
  );
}

export function Section({ children }) {
  return <Stack space="space.200">{children}</Stack>;
}

/** Turn a resolver result into a Feedback message. */
export function resultMessage(r, okText) {
  if (r?.status === 'OK') return { tone: 'success', text: okText(r) };
  return { tone: 'warning', text: r?.message || (r?.errors ?? []).join('; ') || 'The request was not completed.' };
}
