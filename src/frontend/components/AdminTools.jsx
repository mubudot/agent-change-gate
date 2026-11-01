// Admin demo tools on the Approvals tab. On a fresh install (no allowed projects yet) the Guided demo and the
// simulator are shown at once; once the gate is configured the approval queue comes first and the tools open on demand.
import React, { useState } from 'react';
import { Button, Inline, Stack } from '@forge/react';
import { adminToolsExpanded } from '../demo-format.js';
import { GuidedDemo } from './GuidedDemo.jsx';
import { Simulator } from './Simulator.jsx';

const TOOLS = [
  { id: 'demo', label: 'Try guided demo', hide: 'Hide guided demo' },
  { id: 'simulate', label: 'Test a request', hide: 'Hide request simulator' },
];

export function AdminTools({ data, reload }) {
  const [open, setOpen] = useState(null);
  if (adminToolsExpanded(data)) {
    return (
      <Stack space="space.300">
        <GuidedDemo />
        <Simulator data={data} reload={reload} />
      </Stack>
    );
  }
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        {TOOLS.map((t) => (
          <Button key={t.id} appearance={open === t.id ? 'primary' : 'default'} onClick={() => setOpen(open === t.id ? null : t.id)}>
            {open === t.id ? t.hide : t.label}
          </Button>
        ))}
      </Inline>
      {open === 'demo' && <GuidedDemo />}
      {open === 'simulate' && <Simulator data={data} reload={reload} />}
    </Stack>
  );
}
