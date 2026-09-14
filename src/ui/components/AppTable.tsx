import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Pill, StatusPill } from './common';
import { appFlags, appTime, keyOf, siteIdOf, type RichApp } from '../app-view';

// The list. No virtualiser: chrome.storage caps `applications` well under 10k and a plain <table>
// of a few hundred rows paints instantly — so we render a page of 300 and let the user ask for more,
// which costs nothing and keeps the DOM (and the browser's find-in-page) honest.

export const PAGE = 300;

function time(a: RichApp): string {
  const t = appTime(a);
  if (!t) return a.date;
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

/** The flags are the reason to open a row — they say "this one has something to look at". */
function Flags({ app }: { app: RichApp }): JSX.Element {
  const f = appFlags(app);
  return (
    <span class="row" style={{ gap: 4 }}>
      {f.guessed > 0 && (
        <Pill tone="warn" title={`${f.guessed} guessed answers`}>
          G{f.guessed}
        </Pill>
      )}
      {f.unanswered > 0 && (
        <Pill tone="err" title={`${f.unanswered} unanswered questions`}>
          ∅{f.unanswered}
        </Pill>
      )}
      {f.errors > 0 && (
        <Pill tone="err" title={`${f.errors} fields the form rejected`}>
          !{f.errors}
        </Pill>
      )}
      {f.captures && (
        <Pill tone="idle" title="a capture is attached">
          ▣
        </Pill>
      )}
    </span>
  );
}

export function AppTable({
  apps,
  selectedKey,
  onSelect,
}: {
  apps: readonly RichApp[];
  selectedKey?: string | undefined;
  onSelect: (app: RichApp) => void;
}): JSX.Element {
  const [limit, setLimit] = useState(PAGE);
  const shown = apps.slice(0, limit);

  return (
    <div>
      <div class="scroll-x">
        <table>
          <thead>
            <tr>
              <th style={{ width: 76 }}>Time</th>
              <th style={{ width: 88 }}>Site</th>
              <th style={{ width: 120 }}>Employer</th>
              <th>Title</th>
              <th style={{ width: 130 }}>Location</th>
              <th style={{ width: 84 }}>Status</th>
              <th style={{ width: 140 }}>Account</th>
              <th style={{ width: 110 }}>Résumé</th>
              <th style={{ width: 120 }}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const k = keyOf(a);
              return (
                <tr key={k} class={`clickable${k === selectedKey ? ' selected' : ''}`} onClick={() => onSelect(a)}>
                  <td class="nowrap muted tiny" title={a.at ?? a.date}>
                    {time(a)}
                  </td>
                  <td class="tiny">{siteIdOf(a)}</td>
                  <td class="ellipsis" title={a.company}>
                    {a.company}
                  </td>
                  <td>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={a.title}
                    >
                      {a.title}
                    </a>
                    {a.note && <div class="muted tiny ellipsis" title={a.note}>{a.note}</div>}
                  </td>
                  <td class="tiny ellipsis" title={a.location ?? ''}>
                    {a.location ?? '—'}
                  </td>
                  <td>
                    <StatusPill status={a.status} />
                  </td>
                  <td class="tiny ellipsis" title={a.account ?? ''}>
                    {a.account || '—'}
                  </td>
                  <td class="tiny ellipsis" title={a.resume ?? ''}>
                    {a.resume ?? '—'}
                  </td>
                  <td>
                    <Flags app={a} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {apps.length > shown.length && (
        <div class="row" style={{ justifyContent: 'center', padding: 10 }}>
          <button class="sm" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, apps.length - shown.length)} more ({shown.length} of {apps.length})
          </button>
        </div>
      )}
    </div>
  );
}
