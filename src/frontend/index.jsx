// Approval dashboard (Jira global page, UI Kit). Approve/reject agent changes,
// read the audit log, and (Jira admins) edit the policy or hit the kill switch.
// Everything on the page comes from ONE resolver call (getDashboard).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ForgeReconciler, { Box, Button, Inline, SectionMessage, Spinner, Stack, Tab, TabList, TabPanel, Tabs, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { countPending } from './format.js';
import { Summary } from './components/Summary.jsx';
import { Approvals } from './components/Approvals.jsx';
import { AuditLog } from './components/AuditLog.jsx';
import { PolicyPanel } from './components/PolicyPanel.jsx';

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadId = useRef(0);

  // Refreshes keep the current data on screen; only the first load shows a spinner.
  const load = useCallback(async () => {
    const id = ++loadId.current;
    setLoading(true);
    try {
      const next = await invoke('getDashboard');
      if (id === loadId.current) { setData(next); setError(null); }
    } catch (e) {
      if (id === loadId.current) setError(String(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) {
    return (
      <Box padding="space.400">
        {error ? (
          <SectionMessage appearance="error" title="Could not load the Agent Change Gate">
            <Stack space="space.100">
              <Text>{error}</Text>
              <Button onClick={load}>Try again</Button>
            </Stack>
          </SectionMessage>
        ) : (
          <Inline space="space.100" alignBlock="center" alignInline="center">
            <Spinner size="large" label="Loading" />
            <Text>Loading approvals and audit log…</Text>
          </Inline>
        )}
      </Box>
    );
  }

  const pending = countPending(data.requests);
  return (
    <Box paddingInline="space.300" paddingBlockEnd="space.300">
      <Stack space="space.300">
        <Inline spread="space-between" alignBlock="center" shouldWrap>
          <Text>Every Jira write an AI agent makes through this app passes a deterministic policy check first.</Text>
          <Button appearance="subtle" isDisabled={loading} onClick={load}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
        </Inline>
        {error && <SectionMessage appearance="warning"><Text>{`Refresh failed, showing earlier data: ${error}`}</Text></SectionMessage>}
        <Summary data={data} pending={pending} />
        <Tabs id="acg-tabs">
          <TabList>
            <Tab>{pending ? `Approvals (${pending})` : 'Approvals'}</Tab>
            <Tab>Audit log</Tab>
            <Tab>Policy</Tab>
          </TabList>
          <TabPanel><Box paddingBlock="space.200"><Approvals data={data} loading={loading} reload={load} /></Box></TabPanel>
          <TabPanel><Box paddingBlock="space.200"><AuditLog data={data} loading={loading} /></Box></TabPanel>
          <TabPanel><Box paddingBlock="space.200"><PolicyPanel data={data} reload={load} /></Box></TabPanel>
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
