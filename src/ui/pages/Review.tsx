import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { applications } from '../store';
import { href, route, setQuery } from '../router';
import { Card, Empty, Pill, StatusPill } from '../components/common';
import { AppDetail } from '../components/AppDetail';
import { keyOf, parkedQuestion, reviewGroups, type CauseGroup, type RichApp } from '../app-view';

// The inbox: everything a run could not finish by itself, bucketed by *why*. A bucket is worth more
// than a list because the fix is usually one profile answer that unblocks a dozen jobs — which is
// exactly what "this question parked N jobs" says out loud.

const DISMISSED_KEY = 'reviewed_keys';

/** Dismissing hides a record from the inbox; it never deletes history (the Applications page still
 *  shows it). That is why the key list lives beside the data instead of mutating the record. */
function useDismissed(): { keys: string[]; toggle: (key: string) => void } {
  const [keys, setKeys] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void chrome.storage.local
      .get(DISMISSED_KEY)
      .then((got) => live && setKeys((got[DISMISSED_KEY] as string[] | undefined) ?? []))
      .catch(() => undefined);
    const onChange = (ch: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && ch[DISMISSED_KEY]) setKeys((ch[DISMISSED_KEY].newValue as string[] | undefined) ?? []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const toggle = (key: string): void => {
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    setKeys(next); // optimistic: the storage listener confirms it
    void chrome.storage.local.set({ [DISMISSED_KEY]: next });
  };

  return { keys, toggle };
}

function Group({
  group,
  dismissed,
  selectedKey,
  onSelect,
  onDismiss,
}: {
  group: CauseGroup;
  dismissed: readonly string[];
  selectedKey: string | undefined;
  onSelect: (a: RichApp) => void;
  onDismiss: (key: string) => void;
}): JSX.Element {
  return (
    <Card
      title={
        <div class="row">
          <h2>{group.label}</h2>
          <Pill tone="idle">{group.items.length}</Pill>
        </div>
      }
    >
      <p class="muted small" style={{ marginBottom: 8 }}>
        {group.hint}
      </p>
      {group.repeatedQuestions.map((q) => (
        <p key={q.label} class="banner warn small">
          <span>
            “{q.label}” blocked <b>{q.count} jobs</b> —{' '}
            <a href={href('/profile/overrides', { label: q.label })}>answer it once</a>.
          </span>
        </p>
      ))}
      <div class="scroll-x">
        <table>
          <tbody>
            {group.items.map((a) => {
              const k = keyOf(a);
              const q = parkedQuestion(a.note);
              return (
                <tr key={k} class={`clickable${k === selectedKey ? ' selected' : ''}`} onClick={() => onSelect(a)}>
                  <td style={{ width: 84 }}>
                    <StatusPill status={a.status} />
                  </td>
                  <td>
                    <div class="ellipsis" title={a.title}>
                      {a.title}
                    </div>
                    <div class="muted tiny">
                      {a.company} · {(a.at ?? a.date).slice(0, 16).replace('T', ' ')}
                      {a.account ? ` · ${a.account}` : ''}
                    </div>
                    {a.note && (
                      <div class="tiny muted" title={a.note}>
                        {q ? <b>“{q}”</b> : a.note.slice(0, 160)}
                      </div>
                    )}
                  </td>
                  <td style={{ width: 96 }}>
                    <button
                      class="sm ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDismiss(k);
                      }}
                    >
                      {dismissed.includes(k) ? 'Restore' : 'Dismiss'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Review(): JSX.Element {
  const { keys, toggle } = useDismissed();
  const showDismissed = route.value.query['dismissed'] === '1';
  const all = applications.value as RichApp[];
  const groups = reviewGroups(all, { dismissed: keys, showDismissed });
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const selectedKey = route.value.query['key'];
  const selected = selectedKey ? all.find((a) => keyOf(a) === selectedKey) : undefined;

  const list = (
    <div class="col">
      <div class="page-head">
        <h1>Review</h1>
        <span class="muted small">
          {total === 0 ? 'nothing waiting' : `${total} record${total === 1 ? '' : 's'} need a decision`}
          {keys.length > 0 && ` · ${keys.length} dismissed`}
        </span>
        <button class="sm ghost right" onClick={() => setQuery({ dismissed: showDismissed ? '' : '1' })}>
          {showDismissed ? 'Hide dismissed' : 'Show dismissed'}
        </button>
      </div>
      {groups.length === 0 ? (
        <Empty title="Inbox zero">
          <p class="small">Nothing is parked, failed, guessed or left blank.</p>
        </Empty>
      ) : (
        groups.map((g) => (
          <Group
            key={g.id}
            group={g}
            dismissed={keys}
            selectedKey={selectedKey}
            onSelect={(a) => setQuery({ key: keyOf(a) })}
            onDismiss={toggle}
          />
        ))
      )}
    </div>
  );

  if (!selected) return list;
  return (
    <div class="with-drawer">
      {list}
      <AppDetail app={selected} onClose={() => setQuery({ key: '' })} />
    </div>
  );
}
