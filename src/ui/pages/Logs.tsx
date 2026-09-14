import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LogEvent, LogLevel } from '@/engine/records';
import { importLegacyDebugLog, queryEvents, type EventQuery } from '@/platform/data/events';
import { packs, runs, storage } from '../store';
import { href, route, setQuery } from '../router';
import { Card, CopyButton, Empty, LEVEL_TONE, Pill, SearchInput, download } from '../components/common';

// The structured log explorer. Every filter lives in the URL, so a link to "what happened in this
// run" is just a link — Live, Runs and Review all point here with the run/job already filtered.

const PAGE = 200;
const FOLLOW_MS = 2000;
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function Logs(): JSX.Element {
  const q = route.value.query;
  const level = (LEVELS as string[]).includes(q['level'] ?? '') ? (q['level'] as LogLevel) : undefined;
  const scope = q['scope'] ?? '';
  const follow = q['follow'] === '1';

  const [rows, setRows] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [legacyLines, setLegacyLines] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const base: EventQuery = useMemo(
    () => ({
      ...(level ? { level } : {}),
      ...(q['site'] ? { siteId: q['site'] } : {}),
      ...(q['run'] ? { runId: q['run'] } : {}),
      ...(q['job'] ? { jobId: q['job'] } : {}),
      ...(q['q'] ? { text: q['q'] } : {}),
      limit: PAGE,
    }),
    [level, q['site'], q['run'], q['job'], q['q']],
  );

  const load = async (): Promise<void> => {
    setError(null);
    try {
      const got = await queryEvents(base);
      setRows(got);
      setExhausted(got.length < PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const older = async (): Promise<void> => {
    const last = rows[rows.length - 1];
    if (!last?.seq) return setExhausted(true);
    setLoading(true);
    try {
      const got = await queryEvents({ ...base, beforeSeq: last.seq });
      setRows((r) => [...r, ...got]);
      setExhausted(got.length < PAGE);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void load();
  }, [base]);

  // "Follow" re-reads the newest page on a timer. It replaces the page rather than merging, so what
  // you see is always a consistent query result and not a patchwork.
  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void load(), FOLLOW_MS);
    return () => clearInterval(t);
  }, [follow, base]);

  // Old runs logged to chrome.storage `debug_log`. Offer the one-click conversion rather than
  // showing an empty page and letting the user think the history is gone.
  useEffect(() => {
    void chrome.storage.local.get('debug_log').then((got) => setLegacyLines(((got['debug_log'] as string[] | undefined) ?? []).length));
  }, []);

  const scopes = useMemo(() => [...new Set(rows.map((r) => r.scope))].sort(), [rows]);
  const visible = scope ? rows.filter((r) => r.scope === scope) : rows;
  const asText = (): string => visible.map(line).join('\n');

  const importLegacy = async (): Promise<void> => {
    const n = await importLegacyDebugLog();
    setNote(n ? `Imported ${n} legacy line(s).` : 'Nothing new to import.');
    await load();
  };

  return (
    <>
      <div class="page-head">
        <h1>Logs</h1>
        <span class="small muted">
          {storage.value.events.toLocaleString()} events stored · showing {visible.length}
          {scope && ` in scope "${scope}"`}
        </span>
        <div class="right row">
          <label class="check" title={`Re-read the newest ${PAGE} every ${FOLLOW_MS / 1000}s`}>
            <input type="checkbox" checked={follow} onChange={(e) => setQuery({ follow: (e.target as HTMLInputElement).checked ? '1' : undefined })} />
            <span>Follow</span>
          </label>
          <CopyButton text={asText} label="Copy all" />
          <button class="sm ghost" disabled={visible.length === 0} onClick={() => download('jobbot-events.ndjson', visible.map((e) => JSON.stringify(e)).join('\n'), 'application/x-ndjson')}>
            Export NDJSON
          </button>
        </div>
      </div>

      <Card cls="filterbar">
        <div class="row wrap">
          <select value={q['level'] ?? ''} onChange={(e) => setQuery({ level: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="">All levels</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l} and above
              </option>
            ))}
          </select>

          <select value={q['site'] ?? ''} onChange={(e) => setQuery({ site: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="">All sites</option>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <select value={q['run'] ?? ''} onChange={(e) => setQuery({ run: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="">All runs</option>
            {runs.value
              .slice()
              .reverse()
              .map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.siteId} · {new Date(r.startedAt).toLocaleString()}
                </option>
              ))}
          </select>

          <select value={scope} onChange={(e) => setQuery({ scope: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="">All scopes{scopes.length ? ` (${scopes.length} loaded)` : ''}</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <input
            class="job-filter"
            value={q['job'] ?? ''}
            placeholder="Job id"
            onInput={(e) => setQuery({ job: (e.target as HTMLInputElement).value.trim() || undefined })}
          />

          <div class="grow">
            <SearchInput value={q['q'] ?? ''} onInput={(v) => setQuery({ q: v || undefined })} placeholder="Search message, scope and data…" />
          </div>

          {(q['level'] || q['site'] || q['run'] || q['job'] || q['q'] || scope) && (
            <button class="sm ghost" onClick={() => setQuery({ level: undefined, site: undefined, run: undefined, job: undefined, q: undefined, scope: undefined })}>
              Clear filters
            </button>
          )}
        </div>
        <div class="hint">
          Scope is filtered in the page, from what is loaded; level, site, run, job and text are filtered by the store.
        </div>
      </Card>

      {error && <div class="banner err">Could not read the event store: {error}</div>}
      {note && <div class="banner">{note}</div>}

      {storage.value.events === 0 && legacyLines > 0 && (
        <div class="banner">
          <div>
            <strong>No structured events yet, but {legacyLines} legacy debug lines are stored.</strong>{' '}
            <span class="muted">Convert them so old runs show up here.</span>
          </div>
          <button class="sm right" onClick={() => void importLegacy()}>
            Import legacy debug log
          </button>
        </div>
      )}

      <Card cls="logs">
        {visible.length === 0 && !loading ? (
          <Empty title="No events match">
            <span>Widen the filters, or start a run — every step writes here.</span>
          </Empty>
        ) : (
          <div class="loglist">
            {visible.map((e, i) => {
              const key = e.seq ?? -i;
              const isOpen = open.has(key);
              return (
                <div key={key}>
                  <div class={`logline ${e.level}${isOpen ? ' open' : ''}`} onClick={() => toggle(open, setOpen, key)}>
                    <span class="muted" title={new Date(e.ts).toISOString()}>
                      {time(e.ts)}
                    </span>
                    <Pill tone={LEVEL_TONE[e.level]}>{e.level}</Pill>
                    <span class="ellipsis" title={e.scope}>
                      {e.scope}
                    </span>
                    <span class="ellipsis">
                      {e.msg}
                      {e.data && <span class="muted"> {isOpen ? '▾' : '▸'}</span>}
                    </span>
                  </div>
                  {isOpen && (
                    <div class="logdata">
                      <div class="row wrap small muted">
                        <span>{new Date(e.ts).toLocaleString()}</span>
                        <span>origin: {e.origin}</span>
                        {e.siteId && <a href={href('/logs', { ...q, site: e.siteId })}>site: {e.siteId}</a>}
                        {e.runId && <a href={href('/runs/' + e.runId)}>run: {e.runId}</a>}
                        {e.jobId && <a href={href('/logs', { ...q, job: e.jobId })}>job: {e.jobId}</a>}
                        <CopyButton text={() => JSON.stringify(e, null, 2)} label="Copy event" />
                      </div>
                      {e.data && <pre>{JSON.stringify(e.data, null, 2)}</pre>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div class="row" style={{ marginTop: 10 }}>
          <button class="ghost" disabled={loading || exhausted || rows.length === 0} onClick={() => void older()}>
            {exhausted ? 'No older events' : loading ? 'Loading…' : 'Load older'}
          </button>
          <span class="small muted">{rows.length} loaded{follow ? ' · following' : ''}</span>
        </div>
      </Card>
    </>
  );
}

function toggle(open: Set<number>, set: (s: Set<number>) => void, key: number): void {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  set(next);
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function line(e: LogEvent): string {
  const ctx = [e.siteId, e.runId, e.jobId].filter(Boolean).join(' ');
  return `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.scope} ${e.msg}${ctx ? ` (${ctx})` : ''}${e.data ? ` ${JSON.stringify(e.data)}` : ''}`;
}
