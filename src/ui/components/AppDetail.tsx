import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Capture, CaptureMeta, LogEvent } from '@/engine/records';
import { listCaptures, getCapture } from '@/platform/data/captures';
import { queryEvents } from '@/platform/data/events';
import { dedupeDiskApplications, diskAvailable, readCaptureFile, readDiskApplications } from '@/platform/data/disk-records';
import { BlobImage, CopyButton, Modal, Pill, StatusPill, Tabs, Ago } from './common';
import { FieldsTable } from './FieldsTable';
import { appFlags, mergeDiskApp, parseFields, siteIdOf, type DiskApp, type RichApp, type RichField } from '../app-view';

// One application, in full. The rule the whole drawer follows: show what was actually recorded and
// say so when something is missing — an empty Captures tab reads "none were taken", never a blank.
//
// chrome.storage keeps a LEAN copy (store.record() strips the description, the résumé name, the
// per-job log and the capture — a run would blow the 10 MB quota otherwise). When a profile folder
// is linked, `applications/applications.jsonl` has the complete line, so the drawer joins the two
// on jobId + `at` and shows the union, labelled with where each half came from.

type Tab = 'answers' | 'captures' | 'log' | 'job';

/* ---- the on-disk record --------------------------------------------------------------------- */

// applications.jsonl is append-only and read whole; one read serves every drawer opened in the
// next half minute rather than re-parsing a few thousand lines per click.
const DISK_TTL_MS = 30_000;
let diskCache: { at: number; apps: DiskApp[] } | null = null;

async function diskApplications(): Promise<DiskApp[]> {
  if (diskCache && Date.now() - diskCache.at < DISK_TTL_MS) return diskCache.apps;
  const { linked } = await diskAvailable();
  const apps = linked ? (dedupeDiskApplications(await readDiskApplications()) as DiskApp[]) : [];
  diskCache = { at: Date.now(), apps };
  return apps;
}

interface DiskState {
  readonly app: RichApp;
  readonly files: readonly string[];
  readonly matched: 'exact' | 'job' | 'none';
  readonly linked: boolean;
  readonly error: string | null;
}

/** Join the record in front of us with its on-disk twin; falls back to the record itself. */
function useDiskRecord(app: RichApp): DiskState {
  const [state, setState] = useState<DiskState>({ app, files: [], matched: 'none', linked: false, error: null });

  useEffect(() => {
    let live = true;
    setState({ app, files: [], matched: 'none', linked: false, error: null });
    void (async () => {
      try {
        const { linked } = await diskAvailable();
        if (!live) return;
        if (!linked) return setState({ app, files: [], matched: 'none', linked: false, error: null });
        const merged = mergeDiskApp(app, await diskApplications());
        if (!live) return;
        setState({ app: merged.app, files: merged.app.files ?? [], matched: merged.matched, linked: true, error: null });
      } catch (e) {
        if (live) setState({ app, files: [], matched: 'none', linked: false, error: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [app]);

  return state;
}

function Field({ label, children }: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <div class="kv">
      <span class="muted tiny">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/* ---- captures ----------------------------------------------------------------------------- */

/** The capture files the run wrote next to the record (`files[]`): a screenshot and the page HTML
 *  that produced the answers. They only exist on disk — never in chrome.storage. */
function DiskCaptures({ files }: { files: readonly string[] }): JSX.Element | null {
  const [loaded, setLoaded] = useState<{ path: string; name: string; blob: Blob }[]>([]);
  const [text, setText] = useState<{ name: string; body: string } | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded([]);
    void (async () => {
      for (const path of files.slice(0, 12)) {
        const got = await readCaptureFile(path).catch(() => null);
        if (!live || !got) continue;
        setLoaded((prev) => [...prev, { path, name: got.name, blob: got.blob }]);
      }
    })();
    return () => {
      live = false;
    };
  }, [files]);

  if (files.length === 0) return null;
  return (
    <div>
      <div class="muted tiny">
        {files.length} file{files.length === 1 ? '' : 's'} written next to the record on disk
      </div>
      <div class="thumbs">
        {loaded.map((f) => (
          <figure key={f.path} class="thumbfig">
            {/\.(jpe?g|png|webp)$/i.test(f.name) ? (
              <BlobImage blob={f.blob} alt={f.name} />
            ) : (
              <button
                class="thumb"
                style={{ padding: 14 }}
                onClick={() => void f.blob.text().then((body) => setText({ name: f.name, body }))}
              >
                view {f.name.split('.').pop()}
              </button>
            )}
            <figcaption class="tiny muted" title={f.path}>
              {f.name} · {Math.round(f.blob.size / 1024)} KB
            </figcaption>
          </figure>
        ))}
        {loaded.length < Math.min(files.length, 12) && <span class="muted tiny">reading…</span>}
      </div>
      {text && (
        <Modal wide onClose={() => setText(null)}>
          <div class="row" style={{ marginBottom: 8 }}>
            <strong>{text.name}</strong>
            <button class="sm ghost right" onClick={() => setText(null)}>
              Close
            </button>
          </div>
          <pre class="pre">{text.body.slice(0, 40000)}</pre>
        </Modal>
      )}
    </div>
  );
}

function CaptureTab({ app, files }: { app: RichApp; files: readonly string[] }): JSX.Element {
  const [metas, setMetas] = useState<CaptureMeta[] | null>(null);
  const [blobs, setBlobs] = useState<Record<string, Blob>>({});
  const [zoom, setZoom] = useState<Capture | null>(null);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null); // the dataURL kept on the record
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMetas(null);
    setBlobs({});
    void (async () => {
      try {
        const list = await listCaptures({ jobId: app.jobId, limit: 24 });
        if (!live) return;
        setMetas(list);
        // Thumbnails need the bytes; captures are ~100-300 KB, so fetching the page is fine.
        for (const m of list) {
          const c = await getCapture(m.captureId);
          if (!live || !c) continue;
          setBlobs((prev) => ({ ...prev, [m.captureId]: c.blob }));
        }
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [app.jobId]);

  const inline = app.capture;
  const shot = inline?.screenshot ?? app.screenshot;

  return (
    <div class="col">
      {err && <p class="err-text small">Captures could not be read: {err}</p>}

      {shot && (
        <div>
          <div class="muted tiny">{inline?.label ?? 'screenshot'} (on the record)</div>
          <img src={shot} alt="capture" class="thumb" style={{ maxWidth: 320, cursor: 'zoom-in' }} onClick={() => setZoomUrl(shot)} />
        </div>
      )}
      {inline?.html && (
        <details>
          <summary class="small">Captured HTML ({Math.round(inline.html.length / 1024)} KB)</summary>
          <pre class="pre">{inline.html.slice(0, 20000)}</pre>
        </details>
      )}

      <DiskCaptures files={files} />

      {metas === null && <p class="muted small">Loading captures…</p>}
      {metas !== null && metas.length === 0 && !shot && !inline?.html && files.length === 0 && (
        <p class="muted small">No captures were taken for this attempt.</p>
      )}

      <div class="thumbs">
        {(metas ?? []).map((m) => {
          const blob = blobs[m.captureId];
          return (
            <figure key={m.captureId} class="thumbfig">
              {blob && m.mime.startsWith('image/') ? (
                <BlobImage
                  blob={blob}
                  alt={m.label}
                  onClick={() => void getCapture(m.captureId).then((c) => c && setZoom(c))}
                />
              ) : (
                <div class="thumb muted tiny" style={{ padding: 14 }}>
                  {blob ? m.mime : 'loading…'}
                </div>
              )}
              <figcaption class="tiny muted">
                {m.label} · {Math.round(m.bytes / 1024)} KB · <Ago at={m.ts} />
              </figcaption>
            </figure>
          );
        })}
      </div>

      {zoom && (
        <Modal wide onClose={() => setZoom(null)}>
          <div class="row" style={{ marginBottom: 8 }}>
            <strong>{zoom.label}</strong>
            <span class="muted tiny">{new Date(zoom.ts).toLocaleString()}</span>
            <button class="sm ghost right" onClick={() => setZoom(null)}>
              Close
            </button>
          </div>
          <BlobImage blob={zoom.blob} alt={zoom.label} cls="" />
        </Modal>
      )}
      {zoomUrl && (
        <Modal wide onClose={() => setZoomUrl(null)}>
          <img src={zoomUrl} alt="capture" style={{ maxWidth: '100%' }} />
        </Modal>
      )}
    </div>
  );
}

/* ---- log ---------------------------------------------------------------------------------- */

function LogTab({ app }: { app: RichApp }): JSX.Element {
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    void queryEvents({ jobId: app.jobId, limit: 500 })
      .then((e) => live && setEvents(e))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [app.jobId]);

  const lines = app.log ?? [];
  return (
    <div class="col">
      {lines.length > 0 && (
        <div>
          <div class="muted tiny">Recorded with the application ({lines.length} lines)</div>
          <div class="loglines">
            {lines.map((l, i) => (
              <div key={i} class="logline plain">
                {l}
              </div>
            ))}
          </div>
        </div>
      )}
      {err && <p class="err-text small">Events could not be read: {err}</p>}
      {events === null && !err && <p class="muted small">Loading events…</p>}
      {events !== null && events.length === 0 && lines.length === 0 && (
        <p class="muted small">No log events carry this job id.</p>
      )}
      {events !== null && events.length > 0 && (
        <div>
          <div class="muted tiny">{events.length} events for job {app.jobId}</div>
          <div class="loglines">
            {events.map((e, i) => (
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
        </div>
      )}
    </div>
  );
}

/* ---- the drawer ---------------------------------------------------------------------------- */

export function AppDetail({ app: stored, onClose }: { app: RichApp; onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('answers');
  const disk = useDiskRecord(stored);
  const app = disk.app;
  const flags = appFlags(app);
  const fields = (app.fields ?? []) as readonly RichField[];
  const when = app.at ?? app.date;
  const t = Date.parse(when);

  return (
    <section class="card drawer">
      <div class="row" style={{ marginBottom: 6 }}>
        <StatusPill status={app.status} />
        <h2 class="grow ellipsis" title={app.title}>
          {app.title}
        </h2>
        <button class="sm ghost" onClick={onClose}>
          ✕
        </button>
      </div>

      <div class="kvs">
        <Field label="Company">{app.company}</Field>
        <Field label="Site">{siteIdOf(app)}</Field>
        <Field label="Location">{app.location ?? <span class="muted">—</span>}</Field>
        <Field label="Job id">
          <span class="mono">{app.jobId}</span>
        </Field>
        <Field label="Account">{app.account || <span class="muted">—</span>}</Field>
        <Field label="Résumé">{app.resume ?? <span class="muted">—</span>}</Field>
        <Field label="When">
          {Number.isNaN(t) ? when : <>{new Date(t).toLocaleString()} · <Ago at={t} /></>}
        </Field>
        <Field label="Run">{app.runId ? <span class="mono tiny">{app.runId}</span> : <span class="muted">—</span>}</Field>
      </div>

      {app.note && (
        <p class={`note ${app.status === 'failed' ? 'err-text' : ''}`} style={{ margin: '8px 0' }}>
          {app.note}
        </p>
      )}

      <p class="tiny muted">
        {disk.error
          ? `The extension's own record only — the profile folder could not be read: ${disk.error}`
          : disk.matched === 'exact'
            ? 'Complete record: the extension’s copy joined with its line in applications/applications.jsonl.'
            : disk.matched === 'job'
              ? 'The extension’s copy, enriched from the nearest attempt at this job on disk (timestamps differ) — treat the extra detail as that attempt’s.'
              : disk.linked
                ? 'The extension’s own record — this attempt has no line in applications/applications.jsonl.'
                : 'The extension’s own record. Link a profile folder (Review) to see the full field list, the job description and the capture files.'}
      </p>

      <div class="row wrap" style={{ margin: '8px 0' }}>
        <a href={app.url} target="_blank" rel="noreferrer" class="small">
          Open job ↗
        </a>
        <CopyButton text={() => JSON.stringify(app, null, 2)} label="Copy JSON" />
        {flags.guessed > 0 && <Pill tone="warn">{flags.guessed} guessed</Pill>}
        {flags.unanswered > 0 && <Pill tone="err">{flags.unanswered} blank</Pill>}
        {flags.errors > 0 && <Pill tone="err">{flags.errors} field errors</Pill>}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'answers', label: `Answers (${fields.length})` },
          { id: 'captures', label: 'Captures' },
          { id: 'log', label: 'Log' },
          { id: 'job', label: 'Job' },
        ]}
      />

      {tab === 'answers' && <FieldsTable fields={fields} disk={disk.linked} />}
      {tab === 'captures' && <CaptureTab app={app} files={disk.files} />}
      {tab === 'log' && <LogTab app={app} />}
      {tab === 'job' && (
        <div class="col">
          <div class="kvs">
            <Field label="Title">{app.title}</Field>
            <Field label="URL">
              <a href={app.url} target="_blank" rel="noreferrer" class="ellipsis">
                {app.url}
              </a>
            </Field>
            <Field label="Answers recorded">{parseFields(app).length}</Field>
            <Field label="Résumé sent">{app.resume ?? <span class="muted">not recorded</span>}</Field>
          </div>
          {app.description ? (
            <details open>
              <summary class="small muted">Job description as it was when we applied ({app.description.length} chars)</summary>
              <p class="small" style={{ whiteSpace: 'pre-wrap' }}>
                {app.description}
              </p>
            </details>
          ) : (
            <p class="muted small">No job description was recorded{disk.linked ? '' : ' — it is kept on disk, not in the extension'}.</p>
          )}
          <pre class="pre">{JSON.stringify({ ...app, screenshot: app.screenshot ? '(omitted)' : undefined }, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}
