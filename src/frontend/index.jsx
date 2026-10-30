// Approval dashboard (Jira global page, UI Kit). Approve/reject agent changes,
// read the audit log, and (Jira admins) edit the policy or hit the kill switch.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { approvalDetails } from './approval-details.js';

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const appearance = { PENDING: 'inprogress', APPROVED: 'success', REJECTED: 'removed', EXPIRED: 'default', EXECUTED: 'success', FAILED: 'removed' };

function Requests({ data, reload }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const act = async (id, approve) => {
    setBusy(id);
    try {
      const r = await invoke('decide', { approvalId: id, approve });
      setMsg(r.status === 'OK' ? `Request ${r.approvalStatus.toLowerCase()}.` : r.message ?? (r.errors ?? []).join('; '));
      reload();
    } catch (e) {
      setMsg(String(e));
    } finally { setBusy(null); }
  };
  const rows = data.requests.map((r) => ({
    key: r.id,
    cells: [
      { key: 'when', content: fmt(r.createdAt) },
      { key: 'op', content: <Text>{approvalDetails(r)}</Text> },
      { key: 'why', content: r.reasons.map((x) => x.message).join(' · ') },
      { key: 'status', content: <Lozenge appearance={appearance[r.status] ?? 'default'}>{r.status}</Lozenge> },
      {
        key: 'act',
        content:
          data.isApprover && r.status === 'PENDING' ? (
            <Inline space="space.100">
              <Button appearance="primary" isDisabled={busy === r.id || (data.policy.requireDistinctApprover && r.requester === data.actor)} onClick={() => act(r.id, true)}>Approve</Button>
              <Button appearance="warning" isDisabled={busy === r.id} onClick={() => act(r.id, false)}>Reject</Button>
            </Inline>
          ) : (
            <Text>—</Text>
          ),
      },
    ],
  }));
  return (
    <Stack space="space.200">
      {msg && <SectionMessage><Text>{msg}</Text></SectionMessage>}
      {!data.isApprover && <SectionMessage appearance="information"><Text>You can see your own requests. Only approvers can decide.</Text></SectionMessage>}
      <DynamicTable
        head={{ cells: ['Requested', 'Change', 'Why it needs a human', 'Status', ''].map((c, i) => ({ key: String(i), content: c })) }}
        rows={rows}
        emptyView="No agent changes are waiting for approval."
      />
    </Stack>
  );
}

function Audit({ data }) {
  const rows = data.audit.map((e) => ({
    key: e.id,
    cells: [
      { key: 'at', content: fmt(e.at) },
      { key: 'kind', content: e.kind },
      { key: 't', content: e.targets.join(', ') || '—' },
      { key: 'v', content: <Lozenge appearance={e.verdict === 'DENY' ? 'removed' : e.verdict === 'ALLOW' ? 'success' : 'inprogress'}>{e.verdict}</Lozenge> },
      { key: 'o', content: e.outcome },
      { key: 'c', content: e.codes.join(', ') || '—' },
    ],
  }));
  return (
    <DynamicTable
      head={{ cells: ['When', 'Operation', 'Issues', 'Verdict', 'Outcome', 'Reason codes'].map((c, i) => ({ key: String(i), content: c })) }}
      rows={rows}
      rowsPerPage={20}
      emptyView="No agent activity yet."
    />
  );
}

function Policy({ data, reload }) {
  const [text, setText] = useState(JSON.stringify(data.policy, null, 2));
  const [msg, setMsg] = useState(null);
  const save = async (policy) => {
    const r = await invoke('savePolicy', { policy });
    setMsg(r.status === 'OK' ? 'Policy saved.' : r.message ?? (r.errors ?? []).join('; '));
    if (r.status === 'OK') setText(JSON.stringify(r.policy, null, 2));
    reload();
  };
  const parsed = () => {
    try {
      return JSON.parse(text);
    } catch {
      setMsg('Policy is not valid JSON.');
      return null;
    }
  };
  return (
    <Stack space="space.200">
      {data.policyErrors.length > 0 && (
        <SectionMessage appearance="error"><Text>Stored policy is invalid, so all agent writes are blocked: {data.policyErrors.join('; ')}</Text></SectionMessage>
      )}
      {msg && <SectionMessage><Text>{msg}</Text></SectionMessage>}
      <Inline space="space.100" alignBlock="center">
        <Text>Kill switch:</Text>
        <Lozenge appearance={data.policy.agentWritesPaused ? 'removed' : 'success'}>{data.policy.agentWritesPaused ? 'AGENT WRITES PAUSED' : 'ACTIVE'}</Lozenge>
        {data.isAdmin && (
          <Button appearance={data.policy.agentWritesPaused ? 'primary' : 'danger'} onClick={() => save({ ...data.policy, agentWritesPaused: !data.policy.agentWritesPaused })}>
            {data.policy.agentWritesPaused ? 'Resume agent writes' : 'Pause all agent writes'}
          </Button>
        )}
      </Inline>
      <TextArea value={text} onChange={(e) => setText(e.target.value)} isReadOnly={!data.isAdmin} resize="vertical" />
      {data.isAdmin ? (
        <Button appearance="primary" onClick={() => { const p = parsed(); if (p) save(p); }}>Save policy</Button>
      ) : (
        <Text>Only Jira administrators can change the policy.</Text>
      )}
    </Stack>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => invoke('getDashboard').then(setData).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, []);
  if (error) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (!data) return <Text>Loading…</Text>;
  return (
    <Box padding="space.200">
      <Stack space="space.200">
        <Heading size="large">Agent Change Gate</Heading>
        <Text>Every Jira write through this app passes a deterministic policy check. Agent write targets reserved on this site today: {data.siteUsageToday} (includes failed attempts).</Text>
        <Tabs id="acg-tabs">
          <TabList>
            <Tab>Approvals ({data.requests.filter((r) => r.status === 'PENDING').length})</Tab>
            <Tab>Audit log</Tab>
            <Tab>Policy</Tab>
          </TabList>
          <TabPanel><Requests data={data} reload={load} /></TabPanel>
          <TabPanel><Audit data={data} /></TabPanel>
          <TabPanel><Policy data={data} reload={load} /></TabPanel>
        </Tabs>
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
