// At-a-glance cards above the tabs.
import React from 'react';
import { Badge, Inline, Lozenge, Stack, Text } from '@forge/react';
import { Card } from './ui.jsx';
import { graphStatusLabel } from '../format.js';

function Stat({ label, children }) {
  return (
    <Card>
      <Stack space="space.075">
        <Text size="small">{label}</Text>
        {children}
      </Stack>
    </Card>
  );
}

function GraphStatus({ policy, status }) {
  const s = graphStatusLabel(policy, status);
  return (
    <Stack space="space.050">
      <Lozenge appearance={s.appearance} isBold={s.appearance === 'new'}>{s.text}</Lozenge>
      {s.detail && <Text size="small" color="color.text.subtlest">{s.detail}</Text>}
    </Stack>
  );
}

export function Summary({ data, pending }) {
  const { policy } = data;
  return (
    <Inline space="space.200" shouldWrap>
      <Stat label="Waiting for approval">
        <Badge appearance={pending ? 'important' : 'default'} max={99}>{pending}</Badge>
      </Stat>
      <Stat label="Attempted targets today (site)">
        <Inline space="space.050" alignBlock="center">
          <Badge appearance="primary" max={9999}>{data.siteUsageToday}</Badge>
          <Text size="small">of {policy.siteDailyLimit}</Text>
        </Inline>
      </Stat>
      <Stat label="Agent writes">
        <Lozenge appearance={policy.agentWritesPaused ? 'removed' : 'success'} isBold>
          {policy.agentWritesPaused ? 'Paused' : 'Active'}
        </Lozenge>
      </Stat>
      <Stat label="Context source">
        <GraphStatus policy={policy} status={data.graphStatus} />
      </Stat>
      <Stat label="Your role">
        <Lozenge appearance={data.isAdmin || data.isApprover ? 'inprogress' : 'default'}>
          {data.isAdmin ? 'Jira admin' : data.isApprover ? 'Approver' : 'Requester'}
        </Lozenge>
      </Stat>
    </Inline>
  );
}
