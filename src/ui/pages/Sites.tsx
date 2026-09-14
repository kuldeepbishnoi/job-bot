import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ZodIssue } from 'zod';
import type { FieldSpec, SitePack } from '@/sites/packs';
import { packById } from '@/sites/packs';
import { ProfileSchema } from '@/config/schema';
import { saveProfile, resolveRunInputs } from '@/platform/data/profile-store';
import { dailySchedule, disableDaily, enableDaily, DAILY_HOUR } from '@/platform/schedule';
import { packRequirements, type Requirement } from '../facts';
import { packs, profile, resumes, runs } from '../store';
import { activeRunFor, hasResume, lastEndedRun, StartButton } from '../components/SiteCard';
import { Requirements } from '../components/Requirements';
import { Ago, Card, Empty, Pill } from '../components/common';
import { href, route } from '../router';

// Sites = the catalogue and the per-site settings. The form is GENERATED from the pack's own
// FieldSpecs, so adding a knob to a pack adds a field here with no UI change.

function needsLine(pack: SitePack): string {
  const bits: string[] = [];
  if (pack.needs.resume) bits.push('résumé');
  if (pack.needs.gmail) bits.push('Gmail (emailed code)');
  if (pack.needs.loggedInTab) bits.push(`a logged-in tab on ${pack.needs.loggedInTab}`);
  if (pack.needs.accounts) bits.push('an account list');
  return bits.length ? bits.join(', ') : 'nothing beyond a profile';
}

function limitsLine(pack: SitePack): string {
  if (!pack.limits) return 'no cap of our own';
  const bits: string[] = [];
  if (pack.limits.perDay) bits.push(`${pack.limits.perDay}/day`);
  if (pack.limits.note) bits.push(pack.limits.note);
  return bits.join(' · ') || 'no cap of our own';
}

// ---- list ----------------------------------------------------------------------------------

function SiteRow({ pack, armed }: { pack: SitePack; armed: boolean | undefined }): JSX.Element {
  const active = activeRunFor(runs.value.filter((r) => r.phase === 'running' || r.phase === 'discovering' || r.phase === 'paused'), pack.id);
  const last = lastEndedRun(runs.value, pack.id);
  return (
    <section class="card col">
      <div class="row wrap">
        <span class="site-icon" aria-hidden="true">
          {pack.icon}
        </span>
        <h2>{pack.label}</h2>
        <Pill tone="idle">{pack.kind}</Pill>
        {active ? <Pill tone="ok">running</Pill> : null}
        <div class="right row">
          <a href={href(`/sites/${pack.id}`)}>Settings</a>
          <a href={href('/live')}>Live</a>
        </div>
      </div>
      <div class="kv small">
        <span class="muted">Hosts</span>
        <code>{pack.hosts.join(', ')}</code>
        <span class="muted">Needs</span>
        <span>{needsLine(pack)}</span>
        <span class="muted">Limits</span>
        <span>{limitsLine(pack)}</span>
        <span class="muted">Daily</span>
        <span>
          {!pack.supports.schedule ? 'not supported by this pack' : armed === undefined ? 'reading…' : armed ? `armed for ${DAILY_HOUR}:00 (cached profile + résumé snapshot)` : 'off'}
        </span>
        <span class="muted">Last run</span>
        <span>
          {last ? (
            <>
              <Ago at={last.endedAt ?? last.startedAt} /> · {last.counts.applied} applied{last.endReason ? ` · ${last.endReason}` : ''}
            </>
          ) : (
            'never run'
          )}
        </span>
      </div>
      <div class="row wrap">
        <StartButton pack={pack} disabled={!!active} title={active ? 'already running' : `start ${pack.label}`} />
      </div>
    </section>
  );
}

function SiteList(): JSX.Element {
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void Promise.all(packs.map(async (p) => [p.id, (await dailySchedule(p.id)) !== null] as const)).then((pairs) =>
      setArmed(Object.fromEntries(pairs)),
    );
  }, []);
  return (
    <>
      <div class="page-head">
        <h1>Sites</h1>
        <span class="muted small">{packs.length} packs — each is a source of jobs plus the way its form gets filled</span>
      </div>
      <div class="grid two">
        {packs.map((p) => (
          <SiteRow key={p.id} pack={p} armed={armed[p.id]} />
        ))}
      </div>
    </>
  );
}

// ---- settings form -------------------------------------------------------------------------

/** The editor keeps everything as strings (or a boolean) — one shape for every input type. */
type Draft = Record<string, string | boolean>;

export function toDraft(fields: readonly FieldSpec[], block: Record<string, unknown> | undefined): Draft {
  const d: Draft = {};
  for (const f of fields) {
    const v = block?.[f.key];
    if (f.type === 'boolean') d[f.key] = v === true;
    else if (f.type === 'url[]' || f.type === 'string[]') d[f.key] = Array.isArray(v) ? v.join('\n') : '';
    else d[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return d;
}

/** Draft → the profile block zod will judge. Empty optional values are omitted rather than sent
 *  as '' — an empty string fails `z.string().url()` and that error would be a lie about intent. */
export function fromDraft(fields: readonly FieldSpec[], draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.key];
    if (f.type === 'boolean') {
      out[f.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (f.type === 'url[]' || f.type === 'string[]') {
      const items = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length || f.required) out[f.key] = items;
      continue;
    }
    if (f.type === 'number') {
      if (text !== '') out[f.key] = Number(text);
      continue;
    }
    if (text !== '' || f.required) out[f.key] = text;
  }
  return out;
}

function Field({ spec, value, onChange, issue }: { spec: FieldSpec; value: string | boolean; onChange: (v: string | boolean) => void; issue?: string }): JSX.Element {
  const common = { placeholder: spec.placeholder ?? '', onInput: (e: Event) => onChange((e.target as HTMLInputElement).value) };
  return (
    <label class="field">
      <div class="row">
        <b class="small">{spec.label}</b>
        {spec.required && <span class="tiny muted">required</span>}
        <code class="right tiny muted">{spec.key}</code>
      </div>
      {spec.type === 'boolean' ? (
        <div class="row">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
          <span class="small muted">{spec.help ?? ''}</span>
        </div>
      ) : spec.type === 'url[]' || spec.type === 'string[]' ? (
        <textarea value={typeof value === 'string' ? value : ''} placeholder={spec.placeholder ?? 'one per line'} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />
      ) : spec.type === 'number' ? (
        <input type="number" value={typeof value === 'string' ? value : ''} {...common} />
      ) : (
        <input type={spec.type === 'url' ? 'url' : 'text'} value={typeof value === 'string' ? value : ''} {...common} />
      )}
      {spec.type !== 'boolean' && spec.help && <span class="tiny muted">{spec.help}</span>}
      {issue && <span class="issue">{issue}</span>}
    </label>
  );
}

function SettingsForm({ pack }: { pack: SitePack }): JSX.Element {
  const cfg = pack.config;
  const p = profile.value;
  const [draft, setDraft] = useState<Draft>({});
  const [issues, setIssues] = useState<ZodIssue[]>([]);
  const [saved, setSaved] = useState(0);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!cfg) return;
    const block = (p as unknown as Record<string, unknown> | null)?.[cfg.key] as Record<string, unknown> | undefined;
    setDraft(toDraft(cfg.fields, block));
  }, [pack.id, p]);

  if (!cfg) return <Card title="Settings">This pack has no settings of its own — it uses your profile as-is.</Card>;
  const fields = cfg.fields;

  const save = async (): Promise<void> => {
    setErr('');
    if (!p) {
      setErr('there is no profile to attach these settings to yet — set one up first');
      return;
    }
    const merged = { ...(p as unknown as Record<string, unknown>), [cfg.key]: fromDraft(fields, draft) };
    const parsed = ProfileSchema.safeParse(merged);
    if (!parsed.success) {
      setIssues(parsed.error.issues);
      return;
    }
    setIssues([]);
    try {
      await saveProfile(parsed.data, 'ui');
      setSaved(Date.now());
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const issueFor = (key: string): string | undefined =>
    issues.find((i) => i.path[0] === cfg.key && i.path[1] === key)?.message;
  const otherIssues = issues.filter((i) => i.path[0] !== cfg.key);

  return (
    <Card
      title={`${pack.label} settings`}
      right={
        <>
          {cfg.doc && (
            <a class="tiny" href={cfg.doc} target="_blank" rel="noreferrer">
              docs
            </a>
          )}
          <code class="tiny muted">profile.{cfg.key}</code>
        </>
      }
    >
      {!p && (
        <div class="banner warn">
          <div>
            No profile loaded — <a href={href('/profile/identity')}>set one up</a> and these settings will save with it.
          </div>
        </div>
      )}
      <div class="col">
        {fields.map((f) => (
          <Field key={f.key} spec={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft({ ...draft, [f.key]: v })} issue={issueFor(f.key)} />
        ))}
      </div>
      {otherIssues.length > 0 && (
        <div class="banner err">
          <div class="col" style={{ gap: 2 }}>
            <strong>The rest of the profile is not valid, so this can't be saved:</strong>
            {otherIssues.map((i) => (
              <span key={i.path.join('.')} class="small">
                {i.path.join('.')}: {i.message}
              </span>
            ))}
          </div>
        </div>
      )}
      {err && <div class="banner err">{err}</div>}
      <div class="row" style={{ marginTop: 10 }}>
        <button class="primary" disabled={!p} onClick={() => void save()}>
          Save
        </button>
        {saved > 0 && issues.length === 0 && !err && (
          <span class="small" style={{ color: 'var(--ok)' }}>
            saved at {new Date(saved).toLocaleTimeString()}
          </span>
        )}
      </div>
    </Card>
  );
}

function DailyToggle({ pack }: { pack: SitePack }): JSX.Element {
  const [state, setState] = useState<'reading' | 'on' | 'off'>('reading');
  const [snapshot, setSnapshot] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const read = (): void => {
    void dailySchedule(pack.id).then((s) => {
      setState(s ? 'on' : 'off');
      setSnapshot(s ? s.resume.name : '');
    });
  };
  useEffect(read, [pack.id]);

  // Arming has to happen HERE, not in the service worker: the snapshot may come from the picked
  // folder, and File System Access needs this click.
  const toggle = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      if (state === 'on') await disableDaily(pack.id);
      else {
        const { profile: pr, resume } = await resolveRunInputs({ allowFolder: true });
        await enableDaily(pack.id, pr, resume);
      }
      read();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!pack.supports.schedule) return <Card title="Daily run">This pack can't be scheduled — start it by hand.</Card>;

  return (
    <Card title="Daily run">
      <div class="row wrap">
        <button disabled={busy || state === 'reading'} onClick={() => void toggle()}>
          {busy ? 'working…' : state === 'on' ? 'Turn off' : `Run every day at ${DAILY_HOUR}:00`}
        </button>
        <span class="small muted">
          {state === 'reading'
            ? 'reading chrome.storage…'
            : state === 'on'
              ? `armed — the alarm runs from a snapshot of your profile + ${snapshot || 'résumé'} taken when you armed it, so re-arm after editing either`
              : 'off — nothing will start this site on its own'}
        </span>
      </div>
      {err && <div class="banner err">{err}</div>}
    </Card>
  );
}

function SiteDetail({ pack }: { pack: SitePack }): JSX.Element {
  const p = profile.value;
  const res = resumes.value;
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const recheck = (): void => {
    void packRequirements(pack, p, hasResume(p, res)).then(setReqs);
  };
  useEffect(recheck, [pack.id, p, res]);

  return (
    <>
      <div class="page-head">
        <a href={href('/sites')}>← Sites</a>
        <span class="site-icon" aria-hidden="true">
          {pack.icon}
        </span>
        <h1>{pack.label}</h1>
        <Pill tone="idle">{pack.kind}</Pill>
        <div class="right">
          <StartButton pack={pack} />
        </div>
      </div>

      <Card title="Before it can run" right={<code class="tiny muted">{pack.hosts.join(', ')}</code>}>
        <Requirements reqs={reqs} hosts={pack.hosts} onRecheck={recheck} />
        <div class="kv small" style={{ marginTop: 10 }}>
          <span class="muted">Steps</span>
          <span>{pack.steps.join(' → ')}</span>
          <span class="muted">Needs</span>
          <span>{needsLine(pack)}</span>
          <span class="muted">Limits</span>
          <span>{limitsLine(pack)}</span>
          <span class="muted">Watchdog</span>
          <span>
            stalled after {Math.round(pack.stallMs / 60000)} min, dead after {Math.round(pack.deadMs / 60000)} min without a heartbeat
          </span>
        </div>
      </Card>

      <div style={{ height: 12 }} />
      <SettingsForm pack={pack} />
      <div style={{ height: 12 }} />
      <DailyToggle pack={pack} />
    </>
  );
}

export function Sites(): JSX.Element {
  const id = route.value.segments[1];
  if (!id) return <SiteList />;
  const pack = packById(id);
  if (!pack)
    return (
      <Empty title={`No site pack called “${id}”`}>
        <p class="small">
          <a href={href('/sites')}>Back to the site list</a> — packs come from src/sites/packs.ts.
        </p>
      </Empty>
    );
  return <SiteDetail pack={pack} />;
}
