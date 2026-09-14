import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { activeRuns, runs, applications, health, reviewCount, packs, profile, resumes, now } from './store';
import { RunPill, Ago, Bar, Pill, duration } from './components/common';
import { startSite, stopRuns, resumeRun, openDashboard } from './actions';
import { packById, type SitePack } from '@/sites/packs';
import type { Run } from '@/engine/records';

// The popup is a REMOTE CONTROL, nothing more. It dies the moment the worker tab activates, so it
// owns no state: it renders the same signals the console does and sends the same actions. Anything
// that needs to be read, compared or fixed lives in the console.

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function SiteRow({ pack }: { pack: SitePack }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = activeRuns.value.find((r) => r.siteId === pack.id);
  const last = runs.value.filter((r) => r.siteId === pack.id).at(-1);
  const appliedToday = applications.value.filter(
    (a) => a.company === pack.id && a.status === 'applied' && a.date === today(),
  ).length;

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const res = await startSite(pack);
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'could not start');
  };

  return (
    <div class="card" style={{ padding: 10 }}>
      <div class="row">
        <span aria-hidden="true">{pack.icon}</span>
        <strong class="grow ellipsis">{pack.label}</strong>
        {run ? (
          <RunPill run={run} health={health.value[run.runId] ?? 'alive'} />
        ) : (
          <Pill tone="idle">Idle</Pill>
        )}
      </div>

      {run ? (
        <div class="col" style={{ marginTop: 8, gap: 6 }}>
          <Bar value={run.counts.done} total={Math.max(run.counts.queued, run.counts.done, 1)} />
          <div class="row tiny muted">
            <span>
              {run.counts.done}
              {run.counts.queued ? `/${run.counts.queued}` : ''} · ✓{run.counts.applied} ⚠{run.counts.parked} ✗{run.counts.failed}
            </span>
            <span class="right">
              <Ago at={run.heartbeatAt} prefix="♥ " />
            </span>
          </div>
          {run.current && <div class="tiny ellipsis">{run.current.title}</div>}
          {run.pause && <div class="tiny" style={{ color: 'var(--info)' }}>{run.pause.reason}</div>}
          <div class="row" style={{ gap: 6 }}>
            <button class="sm" onClick={() => void stopRuns()}>
              Stop
            </button>
            {run.phase === 'paused' && (
              <button class="sm primary" onClick={() => void resumeRun()}>
                Resume
              </button>
            )}
          </div>
        </div>
      ) : (
        <div class="col" style={{ marginTop: 8, gap: 6 }}>
          <div class="tiny muted">
            {appliedToday > 0 ? `${appliedToday} applied today · ` : ''}
            {last ? <>last run <Ago at={last.endedAt ?? last.startedAt} />{last.endReason ? ` · ${last.endReason}` : ''}</> : 'no runs yet'}
          </div>
          <button class="sm primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : `Apply on ${pack.label}`}
          </button>
        </div>
      )}
      {error && (
        <div class="tiny" style={{ color: 'var(--err)', marginTop: 6 }}>
          ⚠ {error}{' '}
          <button class="link tiny" onClick={() => openDashboard(`/sites/${pack.id}`)}>
            Fix in console
          </button>
        </div>
      )}
    </div>
  );
}

/** A run that stopped reporting is the single most important thing this popup can tell the user. */
function DeadNotice({ run }: { run: Run }): JSX.Element {
  const pack = packById(run.siteId);
  return (
    <div class="banner err" style={{ marginBottom: 8 }}>
      <div class="tiny">
        <strong>{pack?.label ?? run.siteId} run is not responding.</strong> No heartbeat for{' '}
        {duration(now.value - run.heartbeatAt)}.{' '}
        <button class="link tiny" onClick={() => openDashboard('/live')}>
          Open console
        </button>
      </div>
    </div>
  );
}

export function Popup(): JSX.Element {
  const dead = runs.value.filter((r) => health.value[r.runId] === 'dead' && r.phase !== 'dead');
  const s = applications.value;
  const t = today();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const count = (day: string): number => s.filter((a) => a.status === 'applied' && a.date === day).length;

  return (
    <div class="popup">
      <header class="row" style={{ marginBottom: 10 }}>
        <span class="dot" style={{ color: 'var(--accent)' }} />
        <strong class="grow">JobBot</strong>
        <button class="link tiny" onClick={() => openDashboard('/')}>
          Open console ↗
        </button>
      </header>

      {dead.map((r) => (
        <DeadNotice key={r.runId} run={r} />
      ))}

      {profile.value === null && (
        <div class="banner warn" style={{ marginBottom: 8 }}>
          <div class="tiny">
            <strong>No profile yet.</strong>{' '}
            <button class="link tiny" onClick={() => openDashboard('/profile/identity')}>
              Set one up
            </button>{' '}
            or link your profile folder in the console.
          </div>
        </div>
      )}

      <div class="col" style={{ gap: 8 }}>
        {packs.map((p) => (
          <SiteRow key={p.id} pack={p} />
        ))}
      </div>

      <div class="row tiny muted" style={{ marginTop: 10 }}>
        <span>
          {count(t)} today · {count(yesterday)} yesterday · {s.filter((a) => a.status === 'applied').length} total
        </span>
        {reviewCount.value > 0 && (
          <button class="link tiny right" onClick={() => openDashboard('/review')}>
            ⚑ {reviewCount.value} need review
          </button>
        )}
      </div>
      {resumes.value.length === 0 && profile.value !== null && (
        <div class="tiny muted" style={{ marginTop: 6 }}>
          Résumé comes from the linked folder.{' '}
          <button class="link tiny" onClick={() => openDashboard('/profile/resumes')}>
            Upload one instead
          </button>
        </div>
      )}
    </div>
  );
}
