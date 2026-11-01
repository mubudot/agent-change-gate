// Approvals tab: pending agent changes, with a review dialog that shows the exact payload.
import React, { useRef, useState } from 'react';
import {
  Button,
  CodeBlock,
  DynamicTable,
  Inline,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Stack,
  Strong,
  Text,
  TextArea,
  User,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { approvalDetails } from '../approval-details.js';
import { approvalReasonText, changeSummary, formatTime, operationLabel, relativeTime, sourceLabel, targetList } from '../format.js';
import { EmptyNotice, Feedback, Section, StatusLozenge, resultMessage } from './ui.jsx';
import { AdminTools } from './AdminTools.jsx';
import { ContextSignals, SourceLozenge } from './ContextSignals.jsx';
import { AskAgentButton } from './AskAgent.jsx';
import { canRunFromChat, runApprovedPrompt } from '../rovo-prompts.js';

const HEAD = {
  cells: [
    { key: 'requested', content: 'Requested' },
    { key: 'requester', content: 'Requester' },
    { key: 'change', content: 'Change' },
    { key: 'issues', content: 'Issues' },
    { key: 'why', content: 'Why it needs a human' },
    { key: 'status', content: 'Status' },
    { key: 'action', content: '' },
  ],
};

function ReviewModal({ request, data, onClose, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState(null);
  const ownRequest = data.policy.requireDistinctApprover && request.requester === data.actor && request.status === 'PENDING';
  const canDecide = data.isApprover && request.status === 'PENDING';

  const decide = async (approve) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke('decide', { approvalId: request.id, approve, note: note.trim() || undefined });
      const msg = resultMessage(r, (res) => `Request ${String(res.approvalStatus ?? '').toLowerCase()}.`);
      if (r?.status === 'OK') await onDecided(msg);
      else setMessage(msg);
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not record the decision: ${String(e)}` });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => { if (!inFlight.current) onClose(); }} width="large">
      <ModalHeader>
        <ModalTitle>{`${operationLabel(request.op.kind)} · ${targetList(request.op.targets)}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Feedback message={message} />
          <Inline space="space.100" alignBlock="center">
            <Text>Requested by</Text>
            <User accountId={request.requester} />
            <Text>{`${relativeTime(request.createdAt)} · expires ${relativeTime(request.expiresAt)}`}</Text>
          </Inline>
          {request.source === 'simulated' && (
            <SectionMessage appearance="information" title={sourceLabel(request)}>
              <Text>An admin created this request with the demo panel. It went through the same gate as an agent request.</Text>
            </SectionMessage>
          )}
          <SectionMessage appearance="warning" title="Why this needs a human">
            <Text>{approvalReasonText(request)}</Text>
          </SectionMessage>
          {request.context && (
            <Stack space="space.100">
              <Text><Strong>What this work is connected to</Strong>{` (checked ${relativeTime(request.context.checkedAt)})`}</Text>
              <ContextSignals context={request.context} />
            </Stack>
          )}
          <Text><Strong>Exact change the agent will make</Strong> (untruncated)</Text>
          <CodeBlock language="json" text={approvalDetails(request)} showLineNumbers={false} shouldWrapLongLines />
          {ownRequest && (
            <SectionMessage appearance="information">
              <Text>Two-person rule: you requested this change, so another approver must decide it.</Text>
            </SectionMessage>
          )}
          {canRunFromChat(request, data.actor) && (
            <SectionMessage appearance="success" title="Approved">
              <Text>Ask the Change Gate Agent to run it once. The gate re-checks policy and context first.</Text>
            </SectionMessage>
          )}
          {canDecide && !ownRequest && (
            <TextArea placeholder="Optional note for the audit log" value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" isDisabled={busy} onClick={onClose}>Close</Button>
        {canRunFromChat(request, data.actor) && (
          <AskAgentButton
            appearance="primary"
            prompt={runApprovedPrompt(request.id)}
            onError={(text) => setMessage({ tone: 'error', text: `Could not open Rovo chat: ${text}` })}
            onOpened={onClose}
          >
            Run it from Rovo chat
          </AskAgentButton>
        )}
        {canDecide && (
          <>
            <Button appearance="danger" isDisabled={busy} onClick={() => decide(false)}>Reject</Button>
            <Button appearance="primary" isDisabled={busy || ownRequest} onClick={() => decide(true)}>Approve</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

/** Reasons, with context-derived ones tagged by where the gate learned them. */
function WhyCell({ reasons }) {
  return (
    <Stack space="space.050">
      {reasons.map((x, i) => (
        <Inline key={`${x.code}-${i}`} space="space.050" alignBlock="center" shouldWrap>
          {x.source && <SourceLozenge source={x.source} />}
          <Text size="small">{x.message}</Text>
        </Inline>
      ))}
    </Stack>
  );
}

export function Approvals({ data, loading, reload }) {
  const [reviewing, setReviewing] = useState(null);
  const [message, setMessage] = useState(null);
  // Pending requests, plus the viewer's own approved ones (run them once from Rovo chat).
  const pendingIds = new Set(data.requests.map((r) => r.id));
  const listed = [...data.requests, ...(data.myApproved ?? []).filter((r) => !pendingIds.has(r.id))];
  const request = listed.find((r) => r.id === reviewing);
  const now = Date.now();

  const rows = listed.map((r) => ({
    key: r.id,
    cells: [
      { key: 'requested', content: <Stack space="space.0"><Text>{formatTime(r.createdAt)}</Text><Text size="small" color="color.text.subtlest">{relativeTime(r.createdAt, now)}</Text></Stack> },
      { key: 'requester', content: <User accountId={r.requester} /> },
      {
        key: 'change',
        content: (
          <Stack space="space.0">
            <Inline space="space.050" alignBlock="center"><Strong>{operationLabel(r.op.kind)}</Strong>{r.source === 'simulated' && <Lozenge>{sourceLabel(r)}</Lozenge>}</Inline>
            <Text size="small">{changeSummary(r.op)}</Text>
          </Stack>
        ),
      },
      { key: 'issues', content: <Text>{targetList(r.op.targets)}</Text> },
      { key: 'why', content: <WhyCell reasons={r.reasons} /> },
      { key: 'status', content: <StatusLozenge status={r.status} /> },
      {
        key: 'action',
        content: (
          <Button isDisabled={loading} appearance={data.isApprover && r.status === 'PENDING' ? 'primary' : 'default'} onClick={() => setReviewing(r.id)}>
            {data.isApprover && r.status === 'PENDING' ? 'Review' : 'View'}
          </Button>
        ),
      },
    ],
  }));

  return (
    <Section>
      {data.isAdmin && <AdminTools data={data} reload={reload} />}
      <Feedback message={message} />
      {!data.isApprover && (
        <SectionMessage appearance="information">
          <Text>You see your own requests here. Approvers (or Jira admins) make the decision.</Text>
        </SectionMessage>
      )}
      {rows.length === 0 ? (
        <EmptyNotice title="Nothing waiting for approval">
          When an agent asks for a risky or bulk Jira change, it appears here for a human to approve or reject. Small, safe changes run immediately.
        </EmptyNotice>
      ) : (
        <DynamicTable head={HEAD} rows={rows} rowsPerPage={10} isLoading={loading} />
      )}
      <ModalTransition>
        {request && (
          <ReviewModal
            key={request.id}
            request={request}
            data={data}
            onClose={() => setReviewing(null)}
            onDecided={async (msg) => { setReviewing(null); setMessage(msg); await reload(); }}
          />
        )}
      </ModalTransition>
    </Section>
  );
}
