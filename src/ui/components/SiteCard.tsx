import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Profile } from '@/config/schema';
import type { ResumeMeta, Run } from '@/engine/records';
import type { SitePack } from '@/sites/packs';
import type { DailySchedule } from '@/platform/schedule';
import { dailySchedule, DAILY_HOUR } from '@/platform/schedule';
import { packRequirements, type Requirement } from '../facts';
import { saveProfile } from '@/platform/data/profile-store';
import { startSite, stopRuns, resumeRun } from '../actions';
import { profile, profileSource, resumes, runs, activeRuns, health, now } from '../store';
import { href } from '../router';
import { Ago, Bar, Pill, RunPill, duration } from './common';
import { Requirements } from './Requirements';
import { WarningsBanner } from './WarningsBanner';

// One card per site pack: what it is, what it needs, what it is doing RIGHT NOW (with the
// heartbeat age that proves it), and the four buttons that change any of that.

// ---- pure logic (unit-tested in tests/ui-sitecard.test.ts) ---------------------------------

/** Is a résumé actually available? Either an uploaded one is referenced, or profile.resume is a
 *  legacy on-disk file name that the folder fallback can still load. */
export function hasResume(p: Profile | null, list: readonly ResumeMeta[]): boolean {
  if (!p) return false;
  if (list.some((r) => r.id === p.resume)) return true;
  return /\.(pdf|docx?|txt)$/i.test(p.resume);
}

/** Newest run that has ended, for the "Idle · last run … · N applied" line. */
export function lastEndedRun(all: readonly Run[], siteId: string): Run | undefined {
  return all
    .filter((r) => r.siteId === siteId && r.endedAt !== undefined)
    .reduce<Run | undefined>((best, r) => (!best || (r.endedAt ?? 0) > (best.endedAt ?? 0) ? r : best), undefined);
}

export function activeRunFor(all: readonly Run[], siteId: string): Run | undefined {
  return all.find((r) => r.siteId === siteId);
}

/** Worker packs measure progress against their queue; in-page packs against the run's budget
 *  (the page IS the queue, so `queued` is 0 and only "applied so far" is knowable). */
export function progressFor(run: Run, pack: SitePack): { value: number; total: number; label: string } {
  const c = run.counts;
  if (pack.kind === 'worker') {
    const total = c.done + c.queued;
    return { value: c.done, total, label: total > 0 ? `${c.done} of ${total} jobs` : `${c.done} jobs` };
  }
  const budget = Number(run.config?.['budget'] ?? pack.limits?.perDay ?? 0);
  const total = Number.isFinite(budget) && budget > 0 ? budget : c.applied;
  return { value: c.applied, total, label: total > 0 ? `${c.applied} of ${total} applied` : `${c.applied} applied` };
}

/** Counts as words — the evidence behind any status pill. */
export function countsLine(run: Run): string {
  const c = run.counts;
  const parts = [`${c.applied} applied`];
  if (c.parked) parts.push(`${c.parked} parked`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(' · ');
}

/** Why Start can't help right now — null means "go ahead". */
export function startBlock(active: Run | undefined, reqs: readonly Requirement[]): string | null {
  if (active) return `already running (${active.phase})`;
  const missing = reqs.filter((r) => r.ok === false);
  return missing.length ? `missing: ${missing.map((r) => r.label).join(', ')}` : null;
}

// ---- components ----------------------------------------------------------------------------

/** Start for one pack, with the background's own error shown inline instead of a silent no-op. */
export function StartButton({
  pack,
  disabled,
  title,
  dryRun = false,
}: {
  pack: SitePack;
  disabled?: boolean;
  title?: string;
  dryRun?: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    const res = await startSite(pack, { dryRun }); // first await of the click — keeps the gesture for permissions
    if (!res.ok) setErr(res.error ?? 'the background did not say why');
    setBusy(false);
  };
  const label = dryRun ? 'Dry run one job' : 'Start';
  return (
    <>
      <button class={dryRun ? '' : 'primary'} disabled={disabled || busy} title={title} onClick={() => void start()}>
        {busy ? 'Starting…' : label}
      </button>
      {err && (
        <span class="small" style={{ color: 'var(--err)' }}>
          {err}
        </span>
      )}
    </>
  );
}

/** A dry run only means something where the pack fills a form we can leave open for inspection —
 *  the in-page packs. A worker-window pack would park in a hidden window you cannot look at, so it
 *  is not offered here (Profile › Safety's `auto_submit` is that knob). */
export function offersDryRun(pack: SitePack): boolean {
  return pack.supports.dryRun && pack.kind === 'in-page';
}

const DRY_RUN_HELP =
  'Fills exactly one application and stops with the form open in the tab, so you can read every answer before anything is submitted. ' +
  'One job, not N: the run budget counts submitted applications, and a dry run never submits — so it ends as soon as the first job halts.';

/** What pressing Start will actually do, said plainly. One global setting (Profile › Safety), shown
 *  on every card because the card is where Start is: "auto apply is on" was a question the owner
 *  had to leave the run page to answer, and the answer decides whether applications get sent. */
export function autoSubmitState(p: Profile | null): { on: boolean; label: string; title: string } {
  const on = p?.auto_submit === true;
  return {
    on,
    label: on ? 'Auto-submit ON' : 'Auto-submit OFF',
    title: on
      ? 'Start fills each application and SUBMITS it. Applies to every site, not just this one.'
      : 'Start fills each application and leaves it unsubmitted for your review — nothing is sent. Applies to every site, not just this one.',
  };
}

/** The same flag as Profile › Safety, flipped from here. Writing through saveProfile means the
 *  storage listener refreshes the shared signal, so every card re-renders together. */
function AutoSubmit(): JSX.Element | null {
  const p = profile.value;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!p) return null;
  const s = autoSubmitState(p);
  const flip = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      await saveProfile({ ...p, auto_submit: !s.on }, 'ui');
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <>
      <Pill tone={s.on ? 'ok' : 'warn'} title={s.title}>
        {s.label}
      </Pill>
      <button class="small" disabled={busy} title={s.title} onClick={() => void flip()}>
        {busy ? 'saving…' : s.on ? 'Turn off' : 'Turn on'}
      </button>
      {err && (
        <span class="small" style={{ color: 'var(--err)' }}>
          {err}
        </span>
      )}
    </>
  );
}

export function SiteCard({ pack }: { pack: SitePack }): JSX.Element {
  const p = profile.value;
  const res = resumes.value;
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [sched, setSched] = useState<DailySchedule | null | 'reading'>('reading');
  const [note, setNote] = useState('');

  const recheck = (): void => {
    void packRequirements(pack, p, hasResume(p, res), profileSource.value).then(setReqs);
  };
  useEffect(recheck, [pack.id, p, res]);
  useEffect(() => {
    void dailySchedule(pack.id).then(setSched);
  }, [pack.id]);

  const active = activeRunFor(activeRuns.value, pack.id);
  const last = lastEndedRun(runs.value, pack.id);
  const h = active ? health.value[active.runId] ?? 'alive' : undefined;
  const prog = active ? progressFor(active, pack) : null;
  const block = startBlock(active, reqs);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    const r = await fn();
    setNote(r.ok ? '' : r.error ?? 'no answer from the background');
  };

  return (
    <section class="card col site-card">
      <div class="row">
        <span class="site-icon" aria-hidden="true">
          {pack.icon}
        </span>
        <h2>{pack.label}</h2>
        <Pill tone="idle" title={pack.kind === 'worker' ? 'runs in a hidden worker window' : 'runs in your own logged-in tab'}>
          {pack.kind}
        </Pill>
        <div class="right row">
          <a href={href(`/sites/${pack.id}`)}>Configure</a>
          <a href={href('/live')}>Live</a>
        </div>
      </div>

      {active && h && prog ? (
        <div class="col" style={{ gap: 6 }}>
          <div class="row wrap">
            <RunPill run={active} health={h} />
            <span class="small muted">{prog.label}</span>
            <Ago at={active.heartbeatAt} prefix="heartbeat " />
          </div>
          <Bar value={prog.value} total={prog.total} />
          <div class="small muted">
            {countsLine(active)}
            {active.current && (
              <>
                {' · '}
                <span class="mono">{active.current.step}</span> on “{active.current.title}” for {duration(now.value - active.current.since)}
              </>
            )}
            {active.pause && <> · waiting: {active.pause.reason}</>}
          </div>
        </div>
      ) : last ? (
        <div class="row wrap small">
          <Pill tone="idle">Idle</Pill>
          <span class="muted">
            last run <Ago at={last.endedAt ?? last.startedAt} /> · {last.counts.applied} applied
            {last.endReason ? ` · ${last.endReason}` : ''}
          </span>
        </div>
      ) : (
        <div class="row wrap small">
          <Pill tone="idle">Never run</Pill>
          <span class="muted">press Start — the first run discovers jobs and reports here</span>
        </div>
      )}

      <Requirements reqs={reqs} hosts={pack.hosts} onRecheck={recheck} />

      <div class="small muted">
        {sched === 'reading' ? (
          'reading the daily schedule…'
        ) : sched ? (
          <>
            Daily run armed for {DAILY_HOUR}:00 — it uses the profile + résumé snapshot taken when you armed it (
            {sched.resume.name}), so profile edits need a re-arm.
          </>
        ) : pack.supports.schedule ? (
          <>
            Daily run off — <a href={href(`/sites/${pack.id}`)}>arm it in Configure</a>
          </>
        ) : (
          'no daily schedule for this pack'
        )}
      </div>

      <WarningsBanner siteId={pack.id} />

      <div class="row wrap">
        <AutoSubmit />
        <StartButton pack={pack} disabled={!!active} title={block ?? `start ${pack.label}`} />
        {offersDryRun(pack) && <StartButton pack={pack} dryRun disabled={!!active} title={DRY_RUN_HELP} />}
        {pack.supports.stop && (
          <button class="danger" disabled={!active} onClick={() => void act(stopRuns)}>
            Stop
          </button>
        )}
        {pack.supports.resume && active?.phase === 'paused' && <button onClick={() => void act(resumeRun)}>Resume</button>}
        {block && !active && <span class="small muted">{block}</span>}
        {note && (
          <span class="small" style={{ color: 'var(--err)' }}>
            {note}
          </span>
        )}
      </div>
      {offersDryRun(pack) && <div class="tiny muted">{DRY_RUN_HELP}</div>}
    </section>
  );
}
