import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ReviewLine } from '@/platform/data/disk-records';
import { diskAvailable, groupReview, readReviewLines, requestDiskAccess } from '@/platform/data/disk-records';
import { applications, profile } from '../store';
import type { Application } from '@/engine/types';
import { href, route, setQuery } from '../router';
import { Card, Empty, Pill, StatusPill } from '../components/common';
import { AppDetail } from '../components/AppDetail';
import { FixAnswer } from '../components/FixAnswer';
import { WarningsBanner } from '../components/WarningsBanner';
import {
  exactYears,
  keyOf,
  parkedQuestion,
  questionGroupsFromApps,
  questionGroupsFromReview,
  reviewGroups,
  yearsIssues,
  type CauseGroup,
  type QuestionGroup,
  type RichApp,
  offTargetApplications,
  roleOf,
} from '../app-view';

// The inbox. Two things wait for a human and they are not the same thing:
//   1. QUESTIONS we could not answer confidently — one row per question, with every job it blocked
//      and a control that writes the profile right there. Answer once, unblock all of them.
//   2. RECORDS that need a decision (parked, failed, submitted with a guess), bucketed by cause.
//
// Questions come from the richest source available. With a profile folder linked that is
// `<profile>/applications/review.jsonl` — one line per uncertain answer, with the options the form
// offered and the intent the matcher assigned, and it survives a chrome.storage prune. Without a
// folder the same grouping is recovered from the lean chrome.storage records. The page always says
// which one you are looking at, because the two do not contain the same amount of truth.

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

/* ---- the on-disk review file --------------------------------------------------------------- */

interface DiskReview {
  readonly linked: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly lines: readonly ReviewLine[];
  readonly reload: () => void;
}

function useDiskReview(): DiskReview {
  const [state, setState] = useState<{ linked: boolean; loading: boolean; error: string | null; lines: readonly ReviewLine[] }>({
    linked: false,
    loading: true,
    error: null,
    lines: [],
  });

  const load = useCallback((): void => {
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      try {
        const { linked } = await diskAvailable();
        setState({ linked, loading: false, error: null, lines: linked ? await readReviewLines() : [] });
      } catch (e) {
        setState({ linked: false, loading: false, error: (e as Error).message, lines: [] });
      }
    })();
  }, []);

  useEffect(load, [load]);
  return { ...state, reload: load };
}


/** Applications already SENT that the profile's own title filter would reject. The Instahyre pack
 *  never received `want`, so 540 of these went out. The wiring is fixed; these are the ones that
 *  already exist, and only the user can withdraw them — so the job has to be reachable from here. */
function OffTarget(): JSX.Element | null {
  const want = profile.value?.want;
  const [open, setOpen] = useState(false);
  if (!want) return null;
  const off = offTargetApplications(applications.value, want);
  if (off.length === 0) return null;

  const bySite = new Map<string, Application[]>();
  for (const a of off) bySite.set(a.company, [...(bySite.get(a.company) ?? []), a]);

  return (
    <Card
      title={
        <div class="row wrap">
          <h2 class="grow">Applied, but outside what you asked for</h2>
          <Pill tone="err">{off.length}</Pill>
        </div>
      }
      right={
        <button class="sm ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show them'}
        </button>
      }
    >
      <p class="muted small">
        These were submitted to roles your title filter excludes — {[...bySite].map(([c, list]) => `${list.length} on ${c}`).join(', ')}. The
        bug that caused it is fixed, but an application cannot be withdrawn by this extension. Open each one to withdraw it yourself.
      </p>
      {open && (
        <div class="scroll-x" style={{ maxHeight: 420, overflowY: 'auto', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Role</th>
                <th>Site</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {off.slice(0, 400).map((a) => (
                <tr key={`${a.jobId}@${a.at ?? a.date}`}>
                  <td class="nowrap muted">{a.date}</td>
                  <td>{roleOf(a)}</td>
                  <td class="muted">{a.company}</td>
                  <td class="nowrap">
                    {a.url && a.url !== 'u' ? (
                      <a href={a.url} target="_blank" rel="noreferrer">
                        open ↗
                      </a>
                    ) : (
                      <span class="muted tiny">no link recorded</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {off.length > 400 && <p class="muted tiny">Showing the first 400 of {off.length}.</p>}
        </div>
      )}
    </Card>
  );
}

/* ---- one question -------------------------------------------------------------------------- */

function QuestionCard({
  group,
  exact,
  disk,
  dismissed,
  onDismiss,
  onSaved,
}: {
  group: QuestionGroup;
  exact: number | undefined;
  disk: boolean;
  dismissed: boolean;
  onDismiss: () => void;
  onSaved: (ok: boolean) => void;
}): JSX.Element {
  const issues = yearsIssues(group, exact);
  const n = group.jobs.length;

  return (
    <Card
      title={
        <div class="row wrap">
          <h2 class="grow" title={group.label}>
            {group.label}
          </h2>
          <Pill tone={n > 1 ? 'warn' : 'idle'}>{n === 1 ? '1 job' : `${n} jobs`}</Pill>
          {group.sources.map((s) => (
            <Pill key={s} tone={s === 'unanswered' ? 'err' : 'warn'} title="how the answer was produced">
              {s}
            </Pill>
          ))}
        </div>
      }
      right={
        <button class="sm ghost" onClick={onDismiss}>
          {dismissed ? 'Restore' : 'Dismiss'}
        </button>
      }
    >
      {issues.map((i) => (
        <p key={i.value} class="banner err small">
          <span>
            ⚠ <b>Answered “{i.value}”</b> — your résumé says <b>{i.exact} years</b> (
            <a href={href('/profile/answers', { intent: 'answers.exact_years_of_experience' })}>answers.exact_years_of_experience</a>).{' '}
            {i.message}
          </span>
        </p>
      ))}

      <FixAnswer
        label={group.label}
        {...(group.intent ? { intent: group.intent } : {})}
        {...(group.kind ? { kind: group.kind } : {})}
        options={group.options}
        {...(group.value ? { current: group.value } : {})}
        jobCount={n}
        disk={disk}
        onSaved={(r) => onSaved(r.ok)}
      />

      <details style={{ marginTop: 8 }}>
        <summary class="small muted">
          {n === 1 ? 'the job it affected' : `the ${n} jobs it affected`}
          {exact !== undefined && ' · résumé: ' + exact + ' years'}
        </summary>
        <div class="scroll-x">
          <table>
            <tbody>
              {group.jobs.slice(0, 60).map((j, i) => (
                <tr key={`${j.jobId}-${j.at}-${i}`}>
                  <td style={{ width: 84 }}>
                    <Pill tone={j.status === 'applied' ? 'ok' : j.status === 'failed' ? 'err' : 'warn'}>{j.status}</Pill>
                  </td>
                  <td>
                    <div class="ellipsis" title={j.title}>
                      <a href={j.url} target="_blank" rel="noreferrer">
                        {j.title || j.jobId}
                      </a>
                    </div>
                    <div class="muted tiny">
                      {j.company} · {j.at.slice(0, 16).replace('T', ' ')} · answered{' '}
                      {j.value ? <span class="mono">{j.value}</span> : <i>nothing</i>}
                      {j.error ? <span class="err-text"> · {j.error}</span> : ''}
                    </div>
                  </td>
                  <td style={{ width: 90 }}>
                    <a class="tiny" href={href('/apps', { q: j.jobId })}>
                      record →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

/* ---- records, bucketed by cause (unchanged behaviour) -------------------------------------- */

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
            “{q.label}” blocked <b>{q.count} jobs</b> — answer it once in the questions above, or{' '}
            <a href={href('/profile/overrides', { label: q.label })}>in Profile</a>.
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

/* ---- the page ------------------------------------------------------------------------------ */

export function Review(): JSX.Element {
  const { keys, toggle } = useDismissed();
  const showDismissed = route.value.query['dismissed'] === '1';
  const all = applications.value as RichApp[];
  const disk = useDiskReview();
  const [linking, setLinking] = useState(false);

  // A linked folder wins — but only when it actually has lines. An empty review.jsonl (older
  // records, or a run that predates it) must not hide what the extension's own records still know.
  const usingDisk = disk.linked && disk.lines.length > 0;
  const questionsAll = usingDisk ? questionGroupsFromReview(groupReview(disk.lines)) : questionGroupsFromApps(all);
  const questions = questionsAll.filter((g) => showDismissed || !keys.includes(g.id));
  const exact = exactYears(profile.value);

  const groups = reviewGroups(all, { dismissed: keys, showDismissed });
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const selectedKey = route.value.query['key'];
  const selected = selectedKey ? all.find((a) => keyOf(a) === selectedKey) : undefined;

  const link = async (): Promise<void> => {
    setLinking(true);
    await requestDiskAccess();
    setLinking(false);
    disk.reload();
  };

  const source = disk.loading ? (
    <span class="muted small">checking for a linked profile folder…</span>
  ) : usingDisk ? (
    <span class="muted small">
      from <code class="tiny">applications/review.jsonl</code> in your profile folder — {disk.lines.length} uncertain answer
      {disk.lines.length === 1 ? '' : 's'} recorded, with the options each form offered.{' '}
      <button class="link tiny" onClick={disk.reload}>
        reload
      </button>
    </span>
  ) : disk.linked ? (
    <span class="muted small">
      from the extension's own records — the linked folder's <code class="tiny">applications/review.jsonl</code> is empty (these records
      predate it).{' '}
      <button class="link tiny" onClick={disk.reload}>
        reload
      </button>
    </span>
  ) : (
    <span class="muted small">
      from the extension's own records (no profile folder linked, so the options each form offered are not available).{' '}
      <button class="link tiny" disabled={linking} onClick={() => void link()}>
        {linking ? 'asking…' : 'link the profile folder'}
      </button>
      {disk.error && <span class="err-text"> {disk.error}</span>}
    </span>
  );

  const list = (
    <div class="col">
      <div class="page-head">
        <h1>Review</h1>
        <span class="muted small">
          {questions.length === 0 ? 'no open questions' : `${questions.length} question${questions.length === 1 ? '' : 's'} to answer`} ·{' '}
          {total === 0 ? 'no records waiting' : `${total} record${total === 1 ? '' : 's'} need a decision`}
          {keys.length > 0 && ` · ${keys.length} dismissed`}
        </span>
        <button class="sm ghost right" onClick={() => setQuery({ dismissed: showDismissed ? '' : '1' })}>
          {showDismissed ? 'Hide dismissed' : 'Show dismissed'}
        </button>
      </div>

      <WarningsBanner />

      <OffTarget />

      <Card title="Questions to answer" right={source}>
        <p class="muted small">
          One answer per question, not per job: the profile is keyed by intent (or by the question's exact text), so saving here
          fixes every job the question blocked and every future one that asks it.
          {exact === undefined && ' Set answers.exact_years_of_experience to have years answers checked against your résumé.'}
        </p>
        {questions.length === 0 && (
          <Empty title={questionsAll.length === 0 ? 'Nothing was guessed or left blank' : 'All questions dismissed'}>
            <p class="small">Every question the forms asked was answered from your profile.</p>
          </Empty>
        )}
      </Card>

      {questions.map((g) => (
        <QuestionCard
          key={g.id}
          group={g}
          exact={exact}
          disk={disk.linked}
          dismissed={keys.includes(g.id)}
          onDismiss={() => toggle(g.id)}
          onSaved={(ok) => {
            // The record files are append-only: answering does not erase the lines that asked. So
            // a saved question is dismissed (restorable), which is what "handled" means here.
            if (ok && !keys.includes(g.id)) toggle(g.id);
            disk.reload();
          }}
        />
      ))}

      {groups.length === 0 ? (
        <Empty title="No records waiting">
          <p class="small">Nothing is parked or failed.</p>
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
