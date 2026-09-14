import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { requestHosts, type Requirement } from '../facts';
import { getToken } from '@/platform/gmail-api';
import { go } from '../router';
import { openTab } from '../actions';

// Requirement chips. Every chip carries the evidence facts.ts produced (the detail string), and a
// requirement that could NOT be checked renders "?" — never a tick we didn't earn.

export function mark(ok: boolean | null): string {
  return ok === true ? '✓' : ok === false ? '✗' : '?';
}

export function chipTone(ok: boolean | null): 'ok' | 'err' | 'idle' {
  return ok === true ? 'ok' : ok === false ? 'err' : 'idle';
}

export function Requirements({
  reqs,
  hosts,
  onRecheck,
}: {
  reqs: readonly Requirement[];
  /** Needed for the "Grant" fix — chrome.permissions.request wants the origins, not the chip. */
  hosts?: readonly string[];
  onRecheck?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState('');

  // Must stay the FIRST await of the click: granting hosts needs the user gesture and Chrome
  // drops it across an await of anything else.
  const fix = async (r: Requirement): Promise<void> => {
    if (!r.fix) return;
    setBusy(r.id);
    try {
      if (r.fix.action === 'grantHosts') await requestHosts(hosts ?? []);
      else if (r.fix.action === 'connectGmail') await getToken(true);
      else if (r.fix.action === 'openUrl' && r.fix.arg) await openTab(r.fix.arg);
      else if (r.fix.action === 'goto' && r.fix.arg) go(r.fix.arg);
    } finally {
      setBusy('');
      onRecheck?.();
    }
  };

  if (reqs.length === 0) return <div class="chips muted tiny">nothing required</div>;

  return (
    <div class="chips">
      {reqs.map((r) => (
        <span key={r.id} class={`chip ${chipTone(r.ok)}`} title={r.detail ?? r.label}>
          <b>{mark(r.ok)}</b>
          <span>{r.label}</span>
          {r.detail && <span class="muted ellipsis">{r.detail}</span>}
          {r.fix && (
            <button class="link" disabled={busy === r.id} onClick={() => void fix(r)}>
              {busy === r.id ? 'working…' : r.fix.label}
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
