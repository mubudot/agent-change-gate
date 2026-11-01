import React, { useEffect, useRef, useState } from 'react';
import { Button, DynamicTable, Heading, Inline, Lozenge, SectionMessage, Spinner, Stack, Strong, Tag, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { DEMO_STEPS, demoResult, demoStepButton } from '../demo-format.js';
import { approvalReasonText, formatTime } from '../format.js';
import { Card, Feedback, StatusLozenge } from './ui.jsx';
import { ContextSignals } from './ContextSignals.jsx';

const AUDIT_HEAD = { cells: [
  { key: 'time', content: 'Time' }, { key: 'event', content: 'Event' },
  { key: 'status', content: 'Status' }, { key: 'reason', content: 'Reason' },
] };

function Result({ result }) {
  const display = demoResult(result);
  if (!display) return null;
  return (
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <StatusLozenge status={display.label} />
      {display.detail && <Text size="small">{display.detail}</Text>}
      {display.codes.map((code) => <Tag key={code} text={code} />)}
    </Inline>
  );
}

export function GuidedDemo() {
  const [demo, setDemo] = useState(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState(null);
  const inFlight = useRef(false);
  // Protect the initial load from StrictMode's effect cleanup and late responses.
  const loadId = useRef(0);
  useEffect(() => {
    const id = ++loadId.current;
    invoke('demoState').then((r) => {
      if (id !== loadId.current) return;
      if (r.demo) setDemo(r.demo);
      else setMessage({ tone: 'warning', text: r.message || (r.errors ?? []).join('; ') || 'Could not load the demo.' });
    }).catch((e) => {
      if (id === loadId.current) setMessage({ tone: 'error', text: `Could not load the demo: ${String(e)}` });
    }).finally(() => { if (id === loadId.current) setBusy(false); });
    return () => { loadId.current++; };
  }, []);

  const call = async (fn, payload) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke(fn, payload);
      if (r.demo) setDemo(r.demo);
      if (r.status === 'INVALID' || (r.status === 'REFUSED' && payload?.step !== 'replay')) {
        setMessage({ tone: 'warning', text: r.message || (r.errors ?? []).join('; ') || 'The demo step was not completed.' });
      }
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not reach the demo: ${String(e)}` });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const rows = (demo?.audit ?? []).slice(0, 10).map((entry) => ({
    key: entry.id,
    cells: [
      { key: 'time', content: <Text size="small">{formatTime(entry.at)}</Text> },
      { key: 'event', content: <Text size="small">{entry.outcome}</Text> },
      { key: 'status', content: <StatusLozenge status={entry.outcome === 'REFUSED' ? 'REFUSED' : entry.verdict.replaceAll('_', ' ')} /> },
      { key: 'reason', content: <Text size="small">{entry.codes.join(', ') || '—'}</Text> },
    ],
  }));

  return (
    <Card>
      <Stack space="space.200">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Heading size="small">Guided demo</Heading>
          <Lozenge appearance="new">Sample data · no Jira writes</Lozenge>
        </Inline>
        <Text>Run a routine change, review a release-critical change, then block a bulk request. Uses sample issues and this app's policy engine. No Rovo, no setup and no connected Teamwork Graph data needed.</Text>
        <Feedback message={message} />
        {busy && !demo && <Spinner label="Loading guided demo" />}
        <Stack space="space.300">
          {DEMO_STEPS.map((step) => (
            <Stack key={step.id} space="space.100">
              <Text><Strong>{`${step.id}. ${step.title}`}</Strong></Text>
              <Text>{step.explanation}</Text>
              {step.id === 3 && (
                <>
                  {demo?.review && (
                    <SectionMessage appearance="warning" title="Why this needs a human">
                      <Text>{approvalReasonText(demo.review)}</Text>
                      <ContextSignals context={demo.review.context} />
                    </SectionMessage>
                  )}
                  <Text size="small">Two-person rule is off inside the demo only.</Text>
                </>
              )}
              <Inline space="space.100" alignBlock="center" shouldWrap>
                <Button {...demoStepButton(demo, step.id, busy)} onClick={() => call('demoStep', { step: step.id })}>{step.action}</Button>
                <Result result={demo?.results[step.id]} />
              </Inline>
              {step.id === 4 && demo?.results[4]?.status === 'EXECUTED' && (
                <Inline space="space.100" alignBlock="center" shouldWrap>
                  <Button appearance="default" isDisabled={busy || Boolean(demo.replay)} onClick={() => call('demoStep', { step: 'replay' })}>Try to run it again</Button>
                  <Result result={demo.replay} />
                </Inline>
              )}
            </Stack>
          ))}
        </Stack>
        {demo?.nextStep === null && (
          <SectionMessage appearance="success">
            <Text>That's the whole loop. To use it on real issues: Policy tab → add your project key to allowedProjects. Rovo users: open Rovo chat → Change Gate Agent.</Text>
          </SectionMessage>
        )}
        <Stack space="space.100">
          <Heading size="xsmall">Demo audit trail</Heading>
          <DynamicTable head={AUDIT_HEAD} rows={rows} emptyView={<Text size="small">Run the first step to see the demo audit trail.</Text>} />
        </Stack>
        <Inline alignInline="end">
          <Button appearance="subtle" isDisabled={busy} onClick={() => call('demoReset')}>Reset demo</Button>
        </Inline>
      </Stack>
    </Card>
  );
}
