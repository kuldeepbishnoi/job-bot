import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { IntentMeta } from '@/engine/intent-catalog';
import { answersKeys, intentMeta } from '@/engine/intent-catalog';
import { saveProfile } from '@/platform/data/profile-store';
import { setAccount } from '@/platform/store';
import { account, profile, profileMeta } from '../store';
import { go, href, route, setQuery } from '../router';
import { Banner, Card, Empty, SearchInput } from '../components/common';
import { ChipInput, Checkbox, Field, NumberInput, Radios, SaveBar, Select, TextField, TextInput } from '../components/SchemaForm';
import { AnswerControl, answerAnchorId } from '../components/AnswerControl';
import { ResumeManager } from '../components/ResumeManager';
import {
  answersOf,
  bareAnswerKey,
  getAt,
  identityFields,
  isDirty,
  matchesSearch,
  overridesOf,
  removeAt,
  sameData,
  setAnswer,
  setAt,
  setOverrides,
  toDraft,
  validateDraft,
  type Draft,
  type Errors,
} from '../profile-draft';

// The page that replaces hand-editing profile.yaml. It edits a DRAFT (plain data) and asks
// ProfileSchema what is wrong after every keystroke: the schema is the single source of truth, so
// the editor can never save something a run would then refuse to parse.

const TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'resumes', label: 'Résumés' },
  { id: 'want', label: 'What I want' },
  { id: 'answers', label: 'Answers' },
  { id: 'overrides', label: 'Overrides' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'safety', label: 'Safety' },
] as const;

type TabId = (typeof TABS)[number]['id'];
const isTab = (s: string): s is TabId => TABS.some((t) => t.id === s);

export function ProfilePage(): JSX.Element {
  const seg = route.value.segments[1] ?? '';
  const tab: TabId = isTab(seg) ? seg : 'identity';
  const stored = profile.value;

  const [draft, setDraft] = useState<Draft>(() => toDraft(stored));
  const [baseline, setBaseline] = useState<Draft>(() => toDraft(stored));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The profile signal loads asynchronously and refreshes on every storage change. Adopt the new
  // value only when the user has nothing unsaved — never clobber what they are typing.
  useEffect(() => {
    if (isDirty(draft, baseline)) return;
    const next = toDraft(stored);
    if (!sameData(next, baseline)) {
      setDraft(next);
      setBaseline(next);
    }
  }, [stored]);

  const { profile: valid, errors } = useMemo(() => validateDraft(draft), [draft]);
  const dirty = isDirty(draft, baseline);
  const edit = (next: Draft): void => {
    setSaveError(null);
    setDraft(next);
  };

  const onSave = async (): Promise<void> => {
    if (!valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveProfile(valid, 'ui');
      const saved = toDraft(valid); // what zod actually stored (defaults applied) is the new baseline
      setDraft(saved);
      setBaseline(saved);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const meta = profileMeta.value;

  return (
    <>
      <div class="page-head">
        <h1>Profile</h1>
        <span class="small muted">
          {stored ? (
            <>
              Rev {meta?.rev ?? '?'} · saved {meta?.savedAt ? new Date(meta.savedAt).toLocaleString() : 'at an unknown time'} ·{' '}
              {meta?.source ?? 'ui'}
            </>
          ) : (
            'Nothing saved yet — this replaces profile.yaml'
          )}
        </span>
        <div class="right row">
          <a class="small" href={href('/settings')}>
            Import / export YAML →
          </a>
        </div>
      </div>

      {!stored && (
        <Banner>
          <div>
            <strong>No profile stored in the extension yet.</strong>{' '}
            <span class="muted">
              Fill this in and press Save, or import your existing <code>profile.yaml</code> from Settings. Until then runs fall
              back to the linked profile folder, if one is granted.
            </span>
          </div>
        </Banner>
      )}
      {saveError && <Banner tone="err">{saveError}</Banner>}

      <div class="tabs">
        {TABS.map((t) => (
          <button key={t.id} class={t.id === tab ? 'on' : ''} onClick={() => go(`/profile/${t.id}`)}>
            {t.label}
            {tabIssues(t.id, errors) > 0 && <span class="tab-bad" title={`${tabIssues(t.id, errors)} problem(s)`}>●</span>}
          </button>
        ))}
      </div>

      <SaveBar
        dirty={dirty}
        canSave={valid !== null}
        issues={Object.keys(errors).length}
        saving={saving}
        savedAt={meta?.savedAt ? new Date(meta.savedAt).toLocaleTimeString() : undefined}
        onSave={() => void onSave()}
        onDiscard={() => setDraft(baseline)}
      />

      {tab === 'identity' && <IdentityTab draft={draft} errors={errors} onChange={edit} />}
      {tab === 'resumes' && <ResumesTab draft={draft} errors={errors} onChange={edit} />}
      {tab === 'want' && <WantTab draft={draft} errors={errors} onChange={edit} />}
      {tab === 'answers' && <AnswersTab draft={draft} onChange={edit} />}
      {tab === 'overrides' && <OverridesTab draft={draft} onChange={edit} />}
      {tab === 'accounts' && <AccountsTab draft={draft} errors={errors} onChange={edit} />}
      {tab === 'safety' && <SafetyTab draft={draft} errors={errors} onChange={edit} />}
    </>
  );
}

/** Which tab owns a failing path — so a problem on a tab you are not looking at still shows up. */
function tabIssues(tab: TabId, errors: Errors): number {
  const owns: Record<TabId, (path: string) => boolean> = {
    identity: (p) => p.startsWith('identity'),
    resumes: (p) => p === 'resume',
    want: (p) => p.startsWith('want') || p.startsWith('careers'),
    answers: (p) => p.startsWith('answers'),
    overrides: (p) => p.startsWith('overrides'),
    accounts: (p) => p.startsWith('accounts'),
    safety: (p) => p === 'on_unknown' || p === 'auto_submit' || p === 'max_per_run' || p === 'per_account_limit',
  };
  return Object.keys(errors).filter(owns[tab]).length;
}

interface TabProps {
  readonly draft: Draft;
  readonly errors: Errors;
  readonly onChange: (d: Draft) => void;
}

// ---- identity ---------------------------------------------------------------------------------

function IdentityTab({ draft, errors, onChange }: TabProps): JSX.Element {
  return (
    <Card title="Who you are">
      <p class="small muted" style={{ marginBottom: 12 }}>
        These fill the standard fields on every form (<code>first_name</code>, <code>email</code>, <code>phone</code>…). The
        inputs are generated from <code>IdentitySchema</code>, so they always match what the engine reads.
      </p>
      <div class="form-grid">
        {identityFields().map((spec) => (
          <TextField
            key={spec.key}
            spec={spec}
            value={String(getAt(draft, `identity.${spec.key}`) ?? '')}
            error={errors[`identity.${spec.key}`]}
            onChange={(v) => onChange(setAt(draft, `identity.${spec.key}`, v))}
          />
        ))}
      </div>
    </Card>
  );
}

// ---- résumés ----------------------------------------------------------------------------------

function ResumesTab({ draft, errors, onChange }: TabProps): JSX.Element {
  const current = String(draft['resume'] ?? '');
  return (
    <Card title="Résumé" right={errors['resume'] ? <span class="ferr">{errors['resume']}</span> : undefined}>
      <ResumeManager current={current} onPick={(id) => onChange(setAt(draft, 'resume', id))} />
      <div class="hint" style={{ marginTop: 10 }}>
        <code>profile.resume</code> = <code>{current || '(unset)'}</code> — the id (or folder path) a run uploads.
      </div>
    </Card>
  );
}

// ---- what I want ------------------------------------------------------------------------------

const WANT_FIELDS = [
  { key: 'titles_any', label: 'Title must contain one of', help: 'A job is considered only if its title matches one of these. Empty = every title.' },
  { key: 'titles_none', label: 'Never these titles', help: 'Matches here are dropped even if titles_any matched (Manager, Director, Intern…).' },
  { key: 'locations', label: 'Locations', help: 'Used twice: to pick jobs, and to answer "in which cities can you work?" (options ∩ this list ∪ the job\'s own locations).' },
  { key: 'seniority', label: 'Seniority', help: 'Datadog lists "Individual Contributor"; Amazon lists none — leave empty or Amazon jobs all filter out.' },
] as const;

function WantTab({ draft, errors, onChange }: TabProps): JSX.Element {
  const list = (key: string): string[] => (getAt(draft, `want.${key}`) as string[] | undefined) ?? [];
  const careers = (draft['careers'] as string[] | undefined) ?? [];
  return (
    <>
      <Card title="What counts as a job you want">
        <div class="col" style={{ gap: 14 }}>
          {WANT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.help} error={errors[`want.${f.key}`]}>
              <ChipInput
                value={list(f.key)}
                errors={errors}
                errorPrefix={`want.${f.key}`}
                onChange={(v) => onChange(setAt(draft, `want.${f.key}`, v))}
                placeholder="Add and press Enter"
              />
            </Field>
          ))}
        </div>
      </Card>
      <Card title="Careers pages" cls="mt">
        <Field
          label="Search URLs"
          hint="Careers/search pages (with your filters applied) that the apply-jobs skill walks. Per-site search URLs live on the Sites page instead."
          error={errors['careers']}
        >
          <ChipInput
            value={careers}
            errors={errors}
            errorPrefix="careers"
            onChange={(v) => onChange(setAt(draft, 'careers', v))}
            placeholder="https://…"
          />
        </Field>
      </Card>
    </>
  );
}

// ---- answers ----------------------------------------------------------------------------------

const GROUP_ORDER = ['Eligibility', 'Screening', 'Compensation', 'Availability', 'Education', 'Self-identification', 'Consent', 'Other'] as const;

function AnswersTab({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const answers = answersOf(draft);
  const wanted = route.value.query['intent'];
  const scrolled = useRef('');

  // Every intent the catalog knows, plus anything already in the profile (an imported YAML may
  // carry a key a newer engine added) — so nothing you saved becomes invisible here.
  const entries = useMemo(
    () => answersKeys(answers).map((intent) => {
      const key = bareAnswerKey(intent);
      return { key, meta: intentMeta(intent, answers[key]) as IntentMeta };
    }),
    [Object.keys(answers).join(',')],
  );

  const visible = entries.filter((e) => matchesSearch(search, e.key, e.meta.label, e.meta.help));
  const groups = GROUP_ORDER.map((g) => ({ group: g, items: visible.filter((e) => e.meta.group === g) })).filter(
    (g) => g.items.length > 0,
  );
  const ungrouped = visible.filter((e) => !GROUP_ORDER.includes(e.meta.group as (typeof GROUP_ORDER)[number]));

  // `?intent=` (the Review page links here): scroll to that control and focus it, once.
  useEffect(() => {
    if (!wanted || scrolled.current === wanted) return;
    const id = answerAnchorId(wanted);
    const el = document.getElementById(id);
    if (!el) return;
    scrolled.current = wanted;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    (document.getElementById(`${id}-input`) as HTMLElement | null)?.focus();
  }, [wanted, visible.length]);

  const set = (key: string, v: unknown): void => onChange(setAnswer(draft, key, v));
  const answered = entries.filter((e) => answers[e.key] !== undefined).length;

  return (
    <Card
      title={`Answers (${answered} of ${entries.length} set)`}
      right={
        <>
          <SearchInput value={search} onInput={setSearch} placeholder="Find a question…" />
          {wanted && (
            <button class="sm ghost" onClick={() => setQuery({ intent: undefined })}>
              Clear link ↗
            </button>
          )}
        </>
      }
    >
      <p class="small muted" style={{ marginBottom: 12 }}>
        Answers are matched by <b>intent</b>, not by exact wording: one setting here answers every company's phrasing of the
        same question. Unset questions fall to <code>on_unknown</code> (Safety tab).
      </p>
      {visible.length === 0 && <Empty title="No question matches that search" />}
      {[...groups, ...(ungrouped.length ? [{ group: 'Other' as const, items: ungrouped }] : [])].map((g) => (
        <section key={g.group} class="answer-group">
          <h3 class="group-title">{g.group}</h3>
          <div class="answer-grid">
            {g.items.map((e) => (
              <AnswerControl key={e.key} intentKey={e.key} meta={e.meta} value={answers[e.key]} onChange={(v) => set(e.key, v)} />
            ))}
          </div>
        </section>
      ))}
    </Card>
  );
}

// ---- overrides --------------------------------------------------------------------------------

type OverrideType = 'text' | 'boolean' | 'list';
interface OverrideRow {
  rid: number;
  key: string;
  value: unknown;
  type: OverrideType;
}

const typeOf = (v: unknown): OverrideType => (typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'list' : 'text');
let rid = 0;
const toRows = (rec: Record<string, unknown>): OverrideRow[] =>
  Object.entries(rec).map(([key, value]) => ({ rid: ++rid, key, value, type: typeOf(value) }));

function OverridesTab({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }): JSX.Element {
  const preset = route.value.query['label'];
  const [rows, setRows] = useState<OverrideRow[]>(() => {
    const base = toRows(overridesOf(draft));
    // The Review page links here with the exact label of a question we could not answer.
    return preset && !base.some((r) => r.key === preset) ? [...base, { rid: ++rid, key: preset, value: '', type: 'text' }] : base;
  });

  // Re-seed if the draft's overrides changed underneath us (Discard, YAML import), but not from
  // our own commits — those already agree with `rows`.
  useEffect(() => {
    const mine = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    if (!sameData(mine, overridesOf(draft))) setRows(toRows(overridesOf(draft)));
  }, [draft]);

  const commit = (next: OverrideRow[]): void => {
    setRows(next);
    onChange(setOverrides(draft, next));
  };
  const patch = (rowId: number, p: Partial<OverrideRow>): void => commit(rows.map((r) => (r.rid === rowId ? { ...r, ...p } : r)));

  return (
    <Card
      title="Exact-question overrides"
      right={
        <button class="sm" onClick={() => commit([...rows, { rid: ++rid, key: '', value: '', type: 'text' }])}>
          + Add
        </button>
      }
    >
      <p class="small muted" style={{ marginBottom: 12 }}>
        The one place keyed by <b>exact question text</b>, for the rare one-off no intent rule covers. It wins over everything
        else, and only on a form that asks that question with exactly this label (trimmed, case-sensitive).
      </p>
      {preset && <Banner>Pre-filled from Review: <code>{preset}</code> — give it an answer and Save.</Banner>}
      {rows.length === 0 ? (
        <Empty title="No overrides">
          <span>Good — it means the intent rules have covered every question so far.</span>
        </Empty>
      ) : (
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th style={{ width: '46%' }}>Question label (exact)</th>
                <th style={{ width: 110 }}>Type</th>
                <th>Answer</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rid}>
                  <td>
                    <TextInput value={r.key} placeholder="Paste the question exactly as the form shows it" onChange={(v) => patch(r.rid, { key: v })} />
                  </td>
                  <td>
                    <Select
                      value={r.type}
                      options={[
                        { value: 'text', label: 'Text' },
                        { value: 'boolean', label: 'Yes / No' },
                        { value: 'list', label: 'List' },
                      ]}
                      onChange={(v) => {
                        const type = v as OverrideType;
                        patch(r.rid, { type, value: type === 'boolean' ? false : type === 'list' ? [] : '' });
                      }}
                    />
                  </td>
                  <td>
                    {r.type === 'boolean' ? (
                      <div class="seg">
                        <button type="button" class={r.value === true ? 'on' : ''} onClick={() => patch(r.rid, { value: true })}>
                          Yes
                        </button>
                        <button type="button" class={r.value === false ? 'on' : ''} onClick={() => patch(r.rid, { value: false })}>
                          No
                        </button>
                      </div>
                    ) : r.type === 'list' ? (
                      <ChipInput value={Array.isArray(r.value) ? (r.value as string[]) : []} onChange={(v) => patch(r.rid, { value: v })} />
                    ) : (
                      <TextInput value={String(r.value ?? '')} onChange={(v) => patch(r.rid, { value: v })} placeholder="The exact option text, or free text" />
                    )}
                  </td>
                  <td>
                    <button class="sm ghost danger" title="Remove" onClick={() => commit(rows.filter((x) => x.rid !== r.rid))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- accounts ---------------------------------------------------------------------------------

function AccountsTab({ draft, errors, onChange }: TabProps): JSX.Element {
  const list = (draft['accounts'] as string[] | undefined) ?? [];
  const mine = account.value;
  return (
    <>
      <Card title="Logins you apply from">
        <Field
          label="Accounts"
          hint="One Chrome profile per login, all sharing this list. A run rotates to the next account when one hits its limit; applications/registry.jsonl keeps any job from being applied to twice."
          error={errors['accounts']}
        >
          <ChipInput
            value={list}
            errors={errors}
            errorPrefix="accounts"
            onChange={(v) => onChange(setAt(draft, 'accounts', v))}
            placeholder="you.01@gmail.com"
          />
        </Field>
      </Card>

      <Card title="This Chrome profile" cls="mt">
        <Field
          label="Applies as"
          hint="Stamped onto every application record so the history says which login made it. Stored per Chrome profile, not in the profile itself — that is why it saves immediately."
        >
          <div class="row wrap">
            <Select
              value={list.includes(mine) ? mine : ''}
              options={[{ value: '', label: mine ? `(custom) ${mine}` : '(not set)' }, ...list.map((a) => ({ value: a, label: a }))]}
              onChange={(v) => {
                if (v) void setAccount(v);
              }}
            />
            <button class="sm ghost" onClick={() => void setAccount('')} disabled={!mine}>
              Clear
            </button>
          </div>
        </Field>
        <div class="hint">
          Current: <code>{mine || '(none)'}</code>
        </div>
      </Card>

      <Card title="Passwords" cls="mt">
        <p class="small muted">
          Passwords are never stored in the extension. Rotation reads them from{' '}
          <code>profile/accounts.csv</code> (<code>email,site,password</code>) in the linked folder, only when a run needs to
          log the next account in — read-only, at run time, from your machine. Without that file the run simply pauses and
          asks you to log in.
        </p>
      </Card>
    </>
  );
}

// ---- safety -----------------------------------------------------------------------------------

function SafetyTab({ draft, errors, onChange }: TabProps): JSX.Element {
  const autoSubmit = draft['auto_submit'] === true;
  const onUnknown = (draft['on_unknown'] as string | undefined) ?? 'park';
  const num = (key: string): number | undefined => (typeof draft[key] === 'number' ? (draft[key] as number) : undefined);
  const setNum = (key: string, v: number | undefined): void => onChange(v === undefined ? removeAt(draft, key) : setAt(draft, key, v));

  return (
    <>
      <Card title="Submitting">
        <Checkbox checked={autoSubmit} onChange={(v) => onChange(setAt(draft, 'auto_submit', v))}>
          <b>Submit automatically</b>
        </Checkbox>
        <p class="small muted" style={{ marginTop: 8 }}>
          {autoSubmit ? (
            <>
              <b>On:</b> the bot fills the form, enters the emailed code and presses Submit itself. Required for unattended
              daily runs — and it means an answer you got wrong here gets sent.
            </>
          ) : (
            <>
              <b>Off (default):</b> the bot fills everything, enters the emailed code, then <b>parks</b> the tab with Submit
              unpressed so you can read it and click. Nothing is ever sent without you.
            </>
          )}
        </p>
      </Card>

      <Card title="When a required question has no answer" cls="mt">
        <Radios
          name="on_unknown"
          value={onUnknown}
          onChange={(v) => onChange(setAt(draft, 'on_unknown', v))}
          options={[
            { id: 'park', label: 'Park and ask me', help: 'Stop on that job, leave it filled, and list it in Review. Nothing is submitted. (default)' },
            { id: 'skip', label: 'Skip the question', help: 'Leave it blank and carry on — submission may fail if the field was required.' },
            { id: 'guess', label: 'Guess safely', help: 'Pick "decline to answer" if offered, else "No", record it as (guessed), and keep going. Never stuck.' },
          ]}
        />
        {errors['on_unknown'] && <div class="ferr">{errors['on_unknown']}</div>}
      </Card>

      <Card title="Limits" cls="mt">
        <div class="form-grid">
          <Field label="Max applications per run" hint="Empty = the whole queue. Handy for a small hands-free test batch." error={errors['max_per_run']}>
            <NumberInput value={num('max_per_run')} placeholder="no cap" onChange={(v) => setNum('max_per_run', v)} />
          </Field>
          <Field
            label="Per-account daily limit"
            hint="Optional safety cap. The real signal is the ATS's own limit page (Amazon rotates accounts by itself when it appears)."
            error={errors['per_account_limit']}
          >
            <NumberInput value={num('per_account_limit')} placeholder="no cap" onChange={(v) => setNum('per_account_limit', v)} />
          </Field>
        </div>
      </Card>
    </>
  );
}
