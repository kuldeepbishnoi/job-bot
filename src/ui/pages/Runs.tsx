import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { LogEvent, Run, RunCounts } from '@/engine/records';
import { queryEvents } from '@/platform/data/events';
import { applications, health, now, runs } from '../store';
import { go, href, route } from '../router';
import { Ago, Bar, Card, Empty, RunPill, download, duration } from '../components/common';
import { AppTable } from '../components/AppTable';
import { appsForRun, keyOf, runDurationMs, runNdjson, type RichApp } from '../app-view';

// A run is the unit you reason about when something went wrong ("the 09:12 LinkedIn run stopped at
// 14 of 40"). Everything here is the recorded numbers — no derived optimism: a run with no end
// reason says so, and applications joined by time rather than runId are labelled as such.

const COUNT_KEYS = ['queued', 'done', 'applied', 'parked', 'failed', 'skipped'] as const;

function Counts({ counts }: { counts: RunCounts }): JSX.Element {
  return (
    <span class="row wrap tiny" style={{ gap: 6 }}>
      {COUNT_KEYS.filter((k) => counts[k] > 0).map((k) => (
        <span key={k} class="muted">
          <b style={{ color: 'var(--fg)' }}>{counts[k]}</b> {k}
        </span>
      ))}
      {COUNT_KEYS.every((k) => counts[k] === 0) && <span class="muted">nothing yet</span>}
    </span>
  );
}

/** The funnel is the whole story of a run in one block: how many were queued, how many got through. */
function Funnel({ counts }: { counts: RunCounts }): JSX.Element {
  const total = Math.max(counts.queued, counts.done, 1);
  const rows: readonly (readonly [string, number])[] = [
    ['queued', counts.queued],
    ['attempted', counts.done],
    ['applied', counts.applied],
    ['parked', counts.parked],
    ['failed', counts.failed],
    ['skipped', counts.skipped],
  ];
  return (
    <div class="funnel">
      {rows.map(([label, n]) => (
        <div key={label} class="funnel-row">
          <span class="muted tiny">{label}</span>
          <Bar value={n} total={total} />
          <b class="tiny">{n}</b>
        </div>
      ))}
    </div>
  );
}

/* ---- detail ------------------------------------------------------------------------------- */

function RunDetail({ run }: { run: Run }): JSX.Element {
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    void queryEvents({ runId: run.runId, limit: 500 })
      .then((e) => live && setEvents(e))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [run.runId]);

  const joined = appsForRun(applications.value as RichApp[], run);
  const h = health.value[run.runId] ?? 'ended';

  const exportRun = (): void => {
    void queryEvents({ runId: run.runId, limit: 5000 }).then((all) =>
      download(`${run.runId}.ndjson`, runNdjson(run, joined.items, all), 'application/x-ndjson'),
    );
  };

  return (
    <div class="col">
      <div class="page-head">
        <a href={href('/runs')} class="small">
          ← Runs
        </a>
        <h1>{run.siteId}</h1>
        <RunPill run={run} health={h} />
        <button class="sm ghost right" onClick={exportRun}>
          Export run
        </button>
      </div>

      <Card>
        <div class="kvs">
          <div class="kv">
            <span class="muted tiny">Run id</span>
            <span class="mono tiny">{run.runId}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Trigger</span>
            <span>{run.trigger}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Account</span>
            <span>{run.account || '—'}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Started</span>
            <span>
              {new Date(run.startedAt).toLocaleString()} · <Ago at={run.startedAt} />
            </span>
          </div>
          <div class="kv">
            <span class="muted tiny">Duration</span>
            <span>{duration(runDurationMs(run, now.value))}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Last heartbeat</span>
            <span>
              <Ago at={run.heartbeatAt} />
            </span>
          </div>
          <div class="kv">
            <span class="muted tiny">Auto-submit</span>
            <span>{run.autoSubmit ? 'on' : 'off'}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Unknown question</span>
            <span>{run.onUnknown}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Résumé</span>
            <span>{run.resumeName ?? '—'}</span>
          </div>
          <div class="kv">
            <span class="muted tiny">Ended</span>
            <span>{run.endReason ?? (run.endedAt ? 'ended, no reason recorded' : 'still open')}</span>
          </div>
        </div>
        {run.pause && <p class="banner warn small">Waiting on you: {run.pause.reason}</p>}
        {run.current && (
          <p class="small muted">
            Current: {run.current.title} — {run.current.step} (<Ago at={run.current.since} />)
          </p>
        )}
        {run.config && Object.keys(run.config).length > 0 && (
          <div class="chips" style={{ marginTop: 8 }}>
            {Object.entries(run.config).map(([k, v]) => (
              <span key={k} class="chip tiny">
                {k}: {v}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card title="Funnel">
        <Funnel counts={run.counts} />
      </Card>

      <Card
        title={`Applications (${joined.items.length})`}
        right={!joined.exact && joined.items.length > 0 ? <span class="muted tiny">matched by time + site — these records predate run ids</span> : undefined}
      >
        {joined.items.length === 0 ? (
          <Empty title="No applications recorded for this run" />
        ) : (
          <AppTable apps={joined.items} onSelect={(a) => go(`/apps/${encodeURIComponent(keyOf(a))}`)} />
        )}
      </Card>

      <Card title={`Events${events ? ` (${events.length})` : ''}`}>
        {err && <p class="err-text small">Events could not be read: {err}</p>}
        {events === null && !err && <p class="muted small">Loading…</p>}
        {events !== null && events.length === 0 && <p class="muted small">No events carry this run id.</p>}
        <div class="loglines">
          {(events ?? []).map((e, i) => (
            <div key={e.seq ?? i} class={`logline ${e.level}`}>
              <span class="muted">{new Date(e.ts).toLocaleTimeString()}</span>
              <span>{e.level}</span>
              <span class="muted ellipsis">{e.scope}</span>
              <span>
                {e.msg}
                {e.data && <span class="muted"> {JSON.stringify(e.data)}</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---- list --------------------------------------------------------------------------------- */

export function Runs(): JSX.Element {
  const list = [...runs.value].sort((a, b) => b.startedAt - a.startedAt);
  const runId = route.value.segments[1] ? decodeURIComponent(route.value.segments[1]) : undefined;
  const selected = runId ? list.find((r) => r.runId === runId) : undefined;

  if (runId && !selected) {
    return <Empty title="That run is no longer in the index">
      <p class="small">Only the last 200 runs are kept. <a href={href('/runs')}>Back to runs</a>.</p>
    </Empty>;
  }
  if (selected) return <RunDetail run={selected} />;

  return (
    <Card title={`Runs (${list.length})`}>
      {list.length === 0 ? (
        <Empty title="No runs recorded yet">
          <p class="small">Start one from Sites — every run is indexed here with its end reason.</p>
        </Empty>
      ) : (
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Site</th>
                <th style={{ width: 80 }}>Trigger</th>
                <th style={{ width: 150 }}>Started</th>
                <th style={{ width: 90 }}>Duration</th>
                <th>Counts</th>
                <th>End reason</th>
                <th style={{ width: 130 }}>Health</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.runId} class="clickable" onClick={() => go(`/runs/${encodeURIComponent(r.runId)}`)}>
                  <td>{r.siteId}</td>
                  <td class="tiny muted">{r.trigger}</td>
                  <td class="tiny nowrap" title={new Date(r.startedAt).toISOString()}>
                    {new Date(r.startedAt).toLocaleString()}
                  </td>
                  <td class="tiny nowrap">{duration(runDurationMs(r, now.value))}</td>
                  <td>
                    <Counts counts={r.counts} />
                  </td>
                  <td class="tiny ellipsis" title={r.endReason ?? ''}>
                    {r.endReason ?? <span class="muted">{r.endedAt ? 'not recorded' : 'still open'}</span>}
                  </td>
                  <td>
                    <RunPill run={r} health={health.value[r.runId] ?? 'ended'} />
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
