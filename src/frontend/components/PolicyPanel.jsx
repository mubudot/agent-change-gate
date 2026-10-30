// Policy tab: readable summary for everyone, JSON editor and kill switch for Jira admins.
import React, { useEffect, useRef, useState } from 'react';
import { Button, Heading, Inline, Lozenge, SectionMessage, Stack, Tag, TagGroup, Text, TextArea, User, UserGroup } from '@forge/react';
import { invoke } from '@forge/bridge';
import { capsSummary, contextRulesSummary } from '../format.js';
import { Card, Feedback, Section, resultMessage } from './ui.jsx';

function Row({ label, children }) {
  return (
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <Text weight="medium">{label}</Text>
      {children}
    </Inline>
  );
}

function Tags({ items, empty }) {
  if (!items?.length) return <Text>{empty}</Text>;
  return <TagGroup>{items.map((t) => <Tag key={t} text={t} />)}</TagGroup>;
}

function PolicySummary({ policy }) {
  const needsApproval = Object.entries(policy.operations ?? {}).filter(([, v]) => v === 'approve').map(([k]) => k.replace('jira.issue.', ''));
  return (
    <Card>
      <Stack space="space.150">
        <Heading size="small">Current rules</Heading>
        <Row label="Projects agents may write to:"><Tags items={policy.allowedProjects} empty="none yet (all agent writes are refused)" /></Row>
        <Row label="Always needs approval:"><Tags items={needsApproval} empty="nothing" /></Row>
        <Row label="Context that needs a human:">
          <Tags items={contextRulesSummary(policy)} empty="context checks are off" />
          {policy.contextRisk?.enabled && <Text size="small">{`release window ${policy.contextRisk.releaseWindowDays} days · ${policy.contextRisk.useTeamworkGraph ? 'Jira + Teamwork Graph' : 'Jira only'}`}</Text>}
        </Row>
        <Row label="Protected statuses:"><Tags items={policy.protectedStatuses} empty="none" /></Row>
        <Row label="Protected fields:"><Tags items={policy.protectedFields} empty="none" /></Row>
        <Row label="Caps:">
          <Text>{capsSummary(policy)}</Text>
        </Row>
        <Row label="Approvers:">
          {policy.approvers?.length ? (
            <UserGroup>{policy.approvers.map((id) => <User key={id} accountId={id} />)}</UserGroup>
          ) : (
            <Text>Jira administrators</Text>
          )}
          {policy.requireDistinctApprover && <Lozenge appearance="inprogress">two-person rule</Lozenge>}
        </Row>
      </Stack>
    </Card>
  );
}

export function PolicyPanel({ data, reload }) {
  const policyJson = JSON.stringify(data.policy, null, 2);
  const [text, setText] = useState(policyJson);
  const [base, setBase] = useState(policyJson);
  const inFlight = useRef(false);
  const observedPolicy = useRef(policyJson);
  const conflict = base !== policyJson;
  useEffect(() => {
    if (observedPolicy.current !== policyJson) {
      if (text === base) { setText(policyJson); setBase(policyJson); }
      observedPolicy.current = policyJson;
    }
  }, [policyJson, text, base]);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const paused = data.policy.agentWritesPaused;

  const save = async (policy, okText) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const r = await invoke('savePolicy', { policy });
      setMessage(resultMessage(r, () => okText));
      if (r?.status === 'OK') {
        const saved = JSON.stringify(r.policy, null, 2);
        setText(saved); setBase(saved);
      }
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not save the policy: ${String(e)}` });
    } finally {
      await reload();
      inFlight.current = false;
      setSaving(false);
    }
  };

  const saveJson = () => {
    if (conflict || inFlight.current) return;
    let policy;
    try {
      policy = JSON.parse(text);
    } catch {
      setMessage({ tone: 'error', text: 'Policy is not valid JSON.' });
      return;
    }
    save(policy, 'Policy saved.');
  };

  return (
    <Section>
      {data.policyErrors.length > 0 && (
        <SectionMessage appearance="error" title="Stored policy is invalid">
          <Text>{`All agent writes are blocked until it is fixed: ${data.policyErrors.join('; ')}`}</Text>
        </SectionMessage>
      )}
      <Feedback message={message} />
      <Card>
        <Inline space="space.200" alignBlock="center" spread="space-between" shouldWrap>
          <Stack space="space.050">
            <Heading size="small">Kill switch</Heading>
            <Text>{paused ? 'All agent writes are paused. Reads and approvals still work.' : 'Agents can write within the rules below.'}</Text>
          </Stack>
          {data.isAdmin ? (
            <Button
              appearance={paused ? 'primary' : 'danger'}
              isDisabled={saving}
              onClick={() => save({ ...data.policy, agentWritesPaused: !paused }, paused ? 'Agent writes resumed.' : 'All agent writes paused.')}
            >
              {paused ? 'Resume agent writes' : 'Pause all agent writes'}
            </Button>
          ) : (
            <Lozenge appearance={paused ? 'removed' : 'success'} isBold>{paused ? 'Paused' : 'Active'}</Lozenge>
          )}
        </Inline>
      </Card>
      <PolicySummary policy={data.policy} />
      <Stack space="space.100">
        <Heading size="small">Policy JSON</Heading>
        {conflict && text !== base && (
          <SectionMessage appearance="warning"><Text>The policy changed since you started editing. Discard edits to load the current rules before saving.</Text></SectionMessage>
        )}
        <TextArea value={text} isDisabled={saving} onChange={(e) => setText(e.target.value)} isReadOnly={!data.isAdmin} isMonospaced resize="vertical" minimumRows={12} />
        {data.isAdmin ? (
          <Inline space="space.100">
            <Button appearance="primary" isDisabled={saving || conflict} onClick={saveJson}>Save policy</Button>
            <Button appearance="subtle" isDisabled={saving} onClick={() => { setText(policyJson); setBase(policyJson); setMessage(null); }}>Discard edits</Button>
          </Inline>
        ) : (
          <Text>Only Jira administrators can change the policy.</Text>
        )}
      </Stack>
    </Section>
  );
}
