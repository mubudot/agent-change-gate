// Approvals tab: pending agent changes, with a review dialog that shows the exact payload.
import React, { useState } from 'react';
import {
  Button,
  CodeBlock,
  DynamicTable,
  Inline,
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
import { changeSummary, formatTime, operationLabel, relativeTime, targetList } from '../format.js';
import { EmptyNotice, Feedback, Section, StatusLozenge, resultMessage } from './ui.jsx';

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
  const [message, setMessage] = useState(null);
  const ownRequest = data.policy.requireDistinctApprover && request.requester === data.actor;
  const canDecide = data.isApprover && request.status === 'PENDING';

  const decide = async (approve) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await invoke('decide', { approvalId: request.id, approve, note: note.trim() || undefined });
      const msg = resultMessage(r, (res) => `Request ${String(res.approvalStatus ?? '').toLowerCase()}.`);
      if (r?.status === 'OK') onDecided(msg);
      else setMessage(msg);
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not record the decision: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width="large">
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
          <SectionMessage appearance="warning" title="Why this needs a human">
            <Text>{request.reasons.map((x) => x.message).join(' · ') || 'Policy requires approval.'}</Text>
          </SectionMessage>
          <Text><Strong>Exact change the agent will make</Strong> (untruncated)</Text>
          <CodeBlock language="json" text={approvalDetails(request)} showLineNumbers={false} shouldWrapLongLines />
          {ownRequest && (
            <SectionMessage appearance="information">
              <Text>Two-person rule: you requested this change, so another approver must decide it.</Text>
            </SectionMessage>
          )}
          {canDecide && !ownRequest && (
            <TextArea placeholder="Optional note for the audit log" value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>Close</Button>
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

export function Approvals({ data, loading, reload }) {
  const [reviewing, setReviewing] = useState(null);
  const [message, setMessage] = useState(null);
  const now = Date.now();

  const rows = data.requests.map((r) => ({
    key: r.id,
    cells: [
      { key: 'requested', content: <Stack space="space.0"><Text>{formatTime(r.createdAt)}</Text><Text size="small" color="color.text.subtlest">{relativeTime(r.createdAt, now)}</Text></Stack> },
      { key: 'requester', content: <User accountId={r.requester} /> },
      { key: 'change', content: <Stack space="space.0"><Strong>{operationLabel(r.op.kind)}</Strong><Text size="small">{changeSummary(r.op)}</Text></Stack> },
      { key: 'issues', content: <Text>{targetList(r.op.targets)}</Text> },
      { key: 'why', content: <Text size="small">{r.reasons.map((x) => x.message).join(' · ')}</Text> },
      { key: 'status', content: <StatusLozenge status={r.status} /> },
      {
        key: 'action',
        content: (
          <Button appearance={data.isApprover && r.status === 'PENDING' ? 'primary' : 'default'} onClick={() => setReviewing(r)}>
            {data.isApprover && r.status === 'PENDING' ? 'Review' : 'View'}
          </Button>
        ),
      },
    ],
  }));

  return (
    <Section>
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
        {reviewing && (
          <ReviewModal
            request={reviewing}
            data={data}
            onClose={() => setReviewing(null)}
            onDecided={(msg) => { setReviewing(null); setMessage(msg); reload(); }}
          />
        )}
      </ModalTransition>
    </Section>
  );
}
