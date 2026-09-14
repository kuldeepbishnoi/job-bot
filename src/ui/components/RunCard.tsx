import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Capture, LogEvent, LogLevel, Run } from '@/engine/records';
import { packById } from '@/sites/packs';
import { queryEvents } from '@/platform/data/events';
import { getCapture, listCaptures } from '@/platform/data/captures';
import { endRun } from '@/platform/data/runs';
import { armedAlarms } from '../facts';
import { stopRuns, resumeRun } from '../actions';
import { health, now } from '../store';
import { href } from '../router';
import { Ago, Bar, BlobImage, Pill, RunPill, duration } from './common';
import { countsLine, progressFor } from './SiteCard';

// The whole of one run on one card: what it is doing, which step, what it just logged, what it
// last saw. Nothing here is a spinner — every line is a number or a timestamp we actually read.

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Index of the current step in the pack's timeline; -1 when the step isn't one of them. */
export function stepIndex(steps: readonly string[], current: string | undefined): number {
  return current === undefined ? -1 : steps.indexOf(current);
}

export function shortRunId(runId: string): string {
  const tail = runId.split('-').pop() ?? runId;
  return tail.length > 10 ? tail.slice(-10) : tail;
}

function hhmmss(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function RunCard({ run }: { run: Run }): JSX.Element {
  const pack = packById(run.siteId);
  const h = health.value[run.runId] ?? 'alive';
  const steps = pack?.steps ?? [];
  const curIdx = stepIndex(steps, run.current?.step);
  const prog = pack ? progressFor(run, pack) : { value: run.counts.done, total: run.counts.done + run.counts.queued, label: '' };

  const [level, setLevel] = useState<LogLevel>('info');
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [logErr, setLogErr] = useState('');
  const tail = useRef<HTMLDivElement | null>(null);

  // Poll while mounted: events are written by the service worker into IDB, and IDB has no
  // "changed" event of its own for another context's writes beyond the broadcast channel.
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      queryEvents({ runId: run.runId, limit: 60, level })
        .then((es) => {
          if (!alive) return;
          setLines(es);
          setLogErr('');
        })
        .catch((e: unknown) => {
          if (alive) setLogErr((e as Error).message);
        });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [run.runId, level]);

  useEffect(() => {
    if (follow && tail.current) tail.current.scrollTop = tail.current.scrollHeight;
  }, [lines, follow]);

  const [cap, setCap] = useState<Capture | null>(null);
  const lastCapId = useRef('');
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      void listCaptures({ runId: run.runId, limit: 1 })
        .then(async (metas) => {
          const m = metas[0];
          if (!alive || !m || m.captureId === lastCapId.current) return;
          lastCapId.current = m.captureId;
          const full = await getCapture(m.captureId);
          if (alive && full) setCap(full);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [run.runId]);

  // Only asked for when it matters: "is anything going to drive this run?" is the honest answer
  // to a dead/stalled heartbeat, and only chrome.alarms can give it.
  const [alarms, setAlarms] = useState<chrome.alarms.Alarm[] | null>(null);
  useEffect(() => {
    if (h === 'dead' || h === 'stalled') void armedAlarms().then(setAlarms);
  }, [h]);

  const [note, setNote] = useState('');
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    const r = await fn();
    setNote(r.ok ? '' : r.error ?? 'no answer from the background');
  };
  const discard = async (): Promise<void> => {
    await endRun(run.runId, 'dead', 'discarded from the dashboard');
  };

  const age = now.value - run.heartbeatAt;

  return (
    <section class="card col run-card">
      <div class="row wrap">
        <span class="site-icon" aria-hidden="true">
          {pack?.icon ?? '▦'}
        </span>
        <h2>{pack?.label ?? run.siteId}</h2>
        <RunPill run={run} health={h} />
        <code class="tiny muted" title={run.runId}>
          {shortRunId(run.runId)}
        </code>
        <Pill tone="idle">{run.trigger}</Pill>
        {run.account && <span class="small muted">{run.account}</span>}
        <span class="small muted">
          started <Ago at={run.startedAt} />
        </span>
        <span class="small muted">
          heartbeat <Ago at={run.heartbeatAt} />
        </span>
        {run.endReason && <span class="small">ended: {run.endReason}</span>}
        <div class="right row">
          <button class="danger" onClick={() => void act(stopRuns)}>
            Stop
          </button>
          {run.phase === 'paused' && <button onClick={() => void act(resumeRun)}>Resume</button>}
          {(h === 'dead' || h === 'stalled') && <button onClick={() => void discard()}>Discard</button>}
        </div>
      </div>

      {(h === 'dead' || h === 'stalled') && (
        <div class={`banner ${h === 'dead' ? 'err' : 'warn'}`}>
          <div class="col" style={{ gap: 4 }}>
            <strong>
              {h === 'dead' ? 'This run is dead.' : 'This run is stalled.'} No heartbeat for {duration(age)}.
            </strong>
            <span class="small">
              {pack ? `${pack.label} counts ${duration(pack.stallMs)} as stalled and ${duration(pack.deadMs)} as dead.` : 'No pack thresholds — using the defaults.'}{' '}
              {alarms === null
                ? 'checking which alarms are armed…'
                : alarms.length
                  ? `Armed alarms: ${alarms.map((a) => a.name).join(', ')} — one of these may still wake it.`
                  : 'No alarm is armed, so nothing will drive it further: Stop it and start again.'}
            </span>
          </div>
        </div>
      )}

      {run.pause && (
        <div class="banner warn">
          <div>
            <strong>Waiting for you.</strong> {run.pause.reason}
            {run.pause.nextAccount ? ` (next account: ${run.pause.nextAccount})` : ''}
          </div>
        </div>
      )}

      <div class="col" style={{ gap: 6 }}>
        <div class="row wrap small">
          <span>{prog.label}</span>
          <span class="muted">{countsLine(run)}</span>
          {run.counts.queued > 0 && <span class="muted">{run.counts.queued} still queued</span>}
        </div>
        <Bar value={prog.value} total={prog.total} />
      </div>

      {steps.length > 0 && (
        <div class="steps">
          {steps.map((s, i) => (
            <span key={s} class={`step ${i === curIdx ? 'on' : curIdx >= 0 && i < curIdx ? 'done' : ''}`}>
              {s}
              {i === curIdx && run.current && <em> {duration(now.value - run.current.since)}</em>}
            </span>
          ))}
        </div>
      )}

      {run.current ? (
        <div class="small">
          Now:{' '}
          <a href={href('/apps', { job: run.current.jobId })} title={run.current.jobId}>
            {run.current.title}
          </a>{' '}
          <span class="muted">
            · step <span class="mono">{run.current.step}</span> for {duration(now.value - run.current.since)}
          </span>
        </div>
      ) : (
        <div class="small muted">No job in flight — the last heartbeat was {duration(age)} ago.</div>
      )}

      <div class="row">
        <h3>Log</h3>
        <span class="tiny muted">{lines.length} events, newest last, refreshed every 2s</span>
        <div class="right row">
          <label class="row tiny nowrap">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} /> follow
          </label>
          <select
            value={level}
            style={{ width: 'auto' }}
            onChange={(e) => setLevel((e.target as HTMLSelectElement).value as LogLevel)}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}+
              </option>
            ))}
          </select>
        </div>
      </div>
      {logErr && <div class="banner err">Could not read the log: {logErr}</div>}
      <div class="logtail" ref={tail}>
        {lines.length === 0 && !logErr && <div class="muted tiny">nothing at {level}+ yet for this run</div>}
        {[...lines].reverse().map((e) => (
          <div key={e.seq ?? `${e.ts}-${e.msg}`} class={`logline ${e.level}`}>
            <span>{hhmmss(e.ts)}</span>
            <span>{e.level}</span>
            <span class="ellipsis">{e.scope}</span>
            <span>{e.msg}</span>
          </div>
        ))}
      </div>

      <div class="row" style={{ alignItems: 'flex-start' }}>
        <div class="col" style={{ gap: 4 }}>
          <h3>Last capture</h3>
          {cap ? (
            <span class="tiny muted">
              {cap.label} · {Math.round(cap.bytes / 1024)} KB · <Ago at={cap.ts} />
            </span>
          ) : (
            <span class="tiny muted">none captured for this run yet</span>
          )}
        </div>
        {cap && <div class="right">{cap.mime.startsWith('image/') ? <BlobImage blob={cap.blob} alt={cap.label} cls="thumb cap-thumb" /> : <span class="tiny muted">{cap.mime}</span>}</div>}
      </div>

      {note && <div class="banner err">{note}</div>}
    </section>
  );
}
