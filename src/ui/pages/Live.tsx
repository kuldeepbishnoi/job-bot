import type { JSX } from 'preact';
import { activeRuns, packs } from '../store';
import { RunCard } from '../components/RunCard';
import { StartButton } from '../components/SiteCard';
import { Card, Empty } from '../components/common';
import { href } from '../router';

// Live = the runs that are actually in flight, one card each, stacked newest first. When nothing
// is running the page's job is to say what to press, not to show an empty box.

export function Live(): JSX.Element {
  const running = [...activeRuns.value].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <>
      <div class="page-head">
        <h1>Live</h1>
        <span class="muted small">
          {running.length ? `${running.length} run${running.length > 1 ? 's' : ''} in flight` : 'nothing in flight'}
        </span>
        <div class="right">
          <a class="small" href={href('/runs')}>
            Run history →
          </a>
        </div>
      </div>

      {running.length === 0 ? (
        <Card title="Nothing is running">
          <Empty title="Start a site and this page fills up">
            <p class="small">Each start is one run: a queue, a heartbeat, a log tail and the captures it took.</p>
          </Empty>
          <div class="grid three">
            {packs.map((p) => (
              <div key={p.id} class="card col" style={{ gap: 8 }}>
                <div class="row">
                  <span class="site-icon" aria-hidden="true">
                    {p.icon}
                  </span>
                  <strong>{p.label}</strong>
                  <span class="right tiny muted">{p.kind}</span>
                </div>
                <div class="row wrap">
                  <StartButton pack={p} />
                  <a class="small" href={href(`/sites/${p.id}`)}>
                    Configure
                  </a>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <div class="col" style={{ gap: 12 }}>
          {running.map((r) => (
            <RunCard key={r.runId} run={r} />
          ))}
        </div>
      )}
    </>
  );
}
