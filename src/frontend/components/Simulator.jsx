// Admin-only "Simulate agent request" card. Sends a preset through the same gate the Rovo/MCP
// actions use, so the approvals table and audit log fill with real gate decisions when Rovo is off.
import React, { useRef, useState } from 'react';
import { Button, DynamicTable, Heading, Inline, Lozenge, SectionMessage, Stack, Strong, Text, Textfield } from '@forge/react';
import { invoke } from '@forge/bridge';
import { changeSummary, currentSimulationMessage, operationLabel, relativeTime, simulationMessage, targetList } from '../format.js';
import { Card, Feedback, StatusLozenge } from './ui.jsx';

const PRESETS = [
  { id: 'allow-comment', label: 'Low-risk comment', expect: 'Expected: allowed' },
  { id: 'approval-transition', label: 'Move to protected status', expect: 'Expected: needs approval' },
  { id: 'blocked-bulk', label: 'Runaway bulk close', expect: 'Expected: blocked' },
];

const HEAD = {
  cells: [
    { key: 'when', content: 'Simulated' },
    { key: 'change', content: 'Change' },
    { key: 'mode', content: 'Mode' },
    { key: 'status', content: 'Status' },
    { key: 'action', content: '' },
  ],
};

export function Simulator({ data, reload }) {
  const [issueKey, setIssueKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const inFlight = useRef(false);
  const twoPerson = data.policy.requireDistinctApprover;

  const call = async (fn, payload) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(simulationMessage(await invoke(fn, payload)));
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not reach the gate: ${String(e)}` });
    } finally {
      await reload();
      inFlight.current = false;
      setBusy(false);
    }
  };

  const key = issueKey.trim();
  const rows = (data.simulations ?? []).map((r) => {
    const canRun = r.status === 'APPROVED' && r.requester === data.actor;
    return {
      key: r.id,
      cells: [
        { key: 'when', content: <Text>{relativeTime(r.createdAt)}</Text> },
        { key: 'change', content: <Stack space="space.0"><Strong>{`${operationLabel(r.op.kind)} · ${targetList(r.op.targets.slice(0, 3))}`}</Strong><Text size="small">{changeSummary(r.op)}</Text></Stack> },
        { key: 'mode', content: <Lozenge appearance={r.simulation?.mode === 'live' ? 'inprogress' : 'default'}>{r.simulation?.mode === 'live' ? 'live' : 'dry run'}</Lozenge> },
        { key: 'status', content: <StatusLozenge status={r.status} /> },
        {
          key: 'action',
          content: canRun ? (
            <Button appearance="primary" isDisabled={busy} onClick={() => call('runSimulated', { approvalId: r.id })}>Run approved change</Button>
          ) : <Text>—</Text>,
        },
      ],
    };
  });

  return (
    <Card>
      <Stack space="space.200">
        <Inline space="space.100" alignBlock="center">
          <Heading size="small">Simulate an agent request</Heading>
          <Lozenge appearance="new">Admin demo</Lozenge>
        </Inline>
        <Text>
          Sends a realistic agent change through the same gate the Rovo agent and MCP tools use: policy, caps, approval and audit.
          Entries are marked "Simulated" in the audit log.
        </Text>
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Textfield
            placeholder="Issue key, e.g. KAN-1 (optional)"
            value={issueKey}
            isDisabled={busy}
            onChange={(e) => setIssueKey(e.target.value)}
          />
          <Text size="small">
            {key ? `Live: an allowed or approved change really writes to ${key.toUpperCase()}.` : 'Dry run: no issue key, so Jira is never changed.'}
          </Text>
        </Inline>
        <Inline space="space.100" shouldWrap>
          {PRESETS.map((p) => (
            <Stack key={p.id} space="space.050">
              <Button isDisabled={busy} onClick={() => call('simulate', { preset: p.id, ...(key ? { issueKey: key } : {}) })}>{p.label}</Button>
              <Text size="small" color="color.text.subtlest">{p.expect}</Text>
            </Stack>
          ))}
        </Inline>
        {twoPerson && (
          <SectionMessage appearance="information">
            <Text>
              Two-person rule is on: a different approver must approve requests you simulate. For a one-person demo, set
              "requireDistinctApprover": false in the Policy tab first.
            </Text>
          </SectionMessage>
        )}
        <Feedback message={currentSimulationMessage(message, data.simulations)} />
        {rows.length > 0 && <DynamicTable head={HEAD} rows={rows} rowsPerPage={5} />}
      </Stack>
    </Card>
  );
}
