// Buttons that open Rovo chat with the Change Gate Agent (Forge bridge rovo API).
// Hidden when Rovo is not enabled on the site, so the page still works without Rovo.
import React, { useEffect, useState } from 'react';
import { Button } from '@forge/react';
import { rovo } from '@forge/bridge';
import { CHANGE_GATE_AGENT } from '../rovo-prompts.js';

export function useRovoEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    rovo.isEnabled().then((on) => { if (live) setEnabled(on === true); }, () => {});
    return () => { live = false; };
  }, []);
  return enabled;
}

/** Opens a new Rovo conversation with the Change Gate Agent; prompt is optional. */
export function AskAgentButton({ prompt, children, appearance = 'default', onError }) {
  const enabled = useRovoEnabled();
  if (!enabled) return null;
  const open = () =>
    rovo.open(prompt ? { ...CHANGE_GATE_AGENT, prompt } : { ...CHANGE_GATE_AGENT }).catch((e) => onError?.(String(e)));
  return <Button appearance={appearance} onClick={open}>{children}</Button>;
}
