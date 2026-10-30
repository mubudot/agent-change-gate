// Audit log tab: every gate decision, newest first.
import React from 'react';
import { DynamicTable, Lozenge, Stack, Strong, Text, User } from '@forge/react';
import { formatTime, operationLabel, relativeTime, sourceLabel, verdictAppearance } from '../format.js';
import { EmptyNotice, Section } from './ui.jsx';

const HEAD = {
  cells: [
    { key: 'when', content: 'When' },
    { key: 'who', content: 'On behalf of' },
    { key: 'source', content: 'Source' },
    { key: 'op', content: 'Operation' },
    { key: 'issues', content: 'Issues' },
    { key: 'verdict', content: 'Gate verdict' },
    { key: 'outcome', content: 'Outcome' },
    { key: 'codes', content: 'Reason codes' },
  ],
};

const outcomeText = (outcome) => String(outcome ?? '').replaceAll('_', ' ').toLowerCase();

export function AuditLog({ data, loading }) {
  const now = Date.now();
  const rows = data.audit.map((e) => ({
    key: e.id,
    cells: [
      { key: 'when', content: <Stack space="space.0"><Text>{formatTime(e.at)}</Text><Text size="small" color="color.text.subtlest">{relativeTime(e.at, now)}</Text></Stack> },
      { key: 'who', content: e.actor ? <User accountId={e.actor} /> : <Text>—</Text> },
      { key: 'source', content: <Lozenge appearance={e.source === 'simulated' ? 'new' : 'default'}>{sourceLabel(e)}</Lozenge> },
      { key: 'op', content: <Strong>{operationLabel(e.kind)}</Strong> },
      { key: 'issues', content: <Text>{e.targets.join(', ') || '—'}</Text> },
      { key: 'verdict', content: <Lozenge appearance={verdictAppearance(e.verdict)}>{String(e.verdict).replaceAll('_', ' ')}</Lozenge> },
      { key: 'outcome', content: <Text>{outcomeText(e.outcome)}{e.failed?.length ? ` (failed: ${e.failed.join(', ')})` : ''}</Text> },
      { key: 'codes', content: <Text size="small">{e.codes.join(', ') || '—'}</Text> },
    ],
  }));
  return (
    <Section>
      <Text>
        {data.isApprover || data.isAdmin ? 'The 50 most recent gate decisions on this site.' : 'Your 50 most recent agent changes and requests.'}
      </Text>
      {rows.length === 0 ? (
        <EmptyNotice title="No agent activity yet">
          Ask the Change Gate Agent in Rovo, call a guarded tool over MCP, or (Jira admins) use "Simulate an agent request" on the Approvals tab, and each decision is recorded here.
        </EmptyNotice>
      ) : (
        <DynamicTable head={HEAD} rows={rows} rowsPerPage={15} isLoading={loading} />
      )}
    </Section>
  );
}
