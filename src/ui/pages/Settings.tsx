import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { profileFromYaml, profileToYaml, saveProfile } from '@/platform/data/profile-store';
import { hasProfileDir, pickProfileDir } from '@/platform/fs-config';
import { gmailApiAvailable, getToken } from '@/platform/gmail-api';
import { clearEvents } from '@/platform/data/events';
import { deleteCapture, listCaptures } from '@/platform/data/captures';
import { listRuns } from '@/platform/data/runs';
import { listResumes, removeResume } from '@/platform/data/resumes';
import { applications, profile, profileMeta, storage } from '../store';
import { href } from '../router';
import { Banner, Card, download } from '../components/common';
import { bytes } from '../components/ResumeManager';

// Everything that is a switch rather than a decision: YAML in/out, the legacy folder link, the
// Gmail grant, and what this extension is holding on disk. Each action reports what it actually
// did (how many lines imported, how many captures deleted) — no silent success.

const KEEP_CAPTURES = 50; // "prune" = keep the newest N; enough to explain the last run or two

type Note = { tone: 'ok' | 'err'; text: string } | null;

export function Settings(): JSX.Element {
  return (
    <>
      <div class="page-head">
        <h1>Settings</h1>
        <span class="small muted">Import / export, the linked folder, Gmail, and local storage</span>
      </div>
      <div class="grid two">
        <YamlCard />
        <FolderCard />
        <GmailCard />
        <StorageCard />
      </div>
      <DangerCard />
    </>
  );
}

function NoteLine({ note }: { note: Note }): JSX.Element | null {
  if (!note) return null;
  return <div class={note.tone === 'err' ? 'ferr' : 'ok-text'}>{note.text}</div>;
}

// ---- YAML -------------------------------------------------------------------------------------

function YamlCard(): JSX.Element {
  const [note, setNote] = useState<Note>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const p = profile.value;

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setNote(null);
    try {
      const text = await file.text();
      const parsed = profileFromYaml(text); // parseProfile throws with every failing path listed
      const meta = await saveProfile(parsed, 'yaml-import');
      setNote({ tone: 'ok', text: `Imported ${file.name} — saved as rev ${meta.rev}.` });
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card title="profile.yaml">
      <p class="small muted">
        The dashboard's profile and <code>profile.yaml</code> are the same data. Import replaces what is stored here; export
        writes exactly what a run would read, so it round-trips.
      </p>
      <div class="col" style={{ gap: 10, marginTop: 10 }}>
        <label class="flabel">Import</label>
        <input ref={fileRef} type="file" accept=".yaml,.yml,.txt" onChange={(e) => void importFile((e.target as HTMLInputElement).files?.[0])} />
        <div class="row wrap">
          <button
            disabled={!p}
            onClick={() => p && download('profile.yaml', profileToYaml(p), 'text/yaml')}
            title={p ? '' : 'Nothing stored to export yet'}
          >
            Export profile.yaml
          </button>
          <button class="ghost" disabled={!p} onClick={() => setPreview(p ? profileToYaml(p) : null)}>
            Preview
          </button>
          {profileMeta.value && (
            <span class="small muted">
              rev {profileMeta.value.rev} · {profileMeta.value.source}
            </span>
          )}
        </div>
        <NoteLine note={note} />
        {preview !== null && (
          <textarea readOnly rows={14} value={preview} onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
        )}
        {!p && (
          <div class="hint">
            Nothing stored yet — import a YAML here, or fill in <a href={href('/profile/identity')}>Profile</a>.
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- legacy folder -----------------------------------------------------------------------------

function FolderCard(): JSX.Element {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    void hasProfileDir().then(setLinked).catch(() => setLinked(null));
  }, []);

  // showDirectoryPicker needs the user gesture — so this awaits nothing before calling it.
  const pick = async (): Promise<void> => {
    setNote(null);
    try {
      await pickProfileDir();
      setLinked(true);
      setNote({ tone: 'ok', text: 'Folder linked. Runs can now read the résumé and accounts.csv, and write records back.' });
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message || 'Folder picker cancelled.' });
    }
  };

  return (
    <Card title="Linked profile folder">
      <p class="small muted">
        The original way JobBot read your profile: a folder holding <code>profile.yaml</code>, <code>resume/</code>,{' '}
        <code>accounts.csv</code> and the append-only <code>applications/</code> records. It stays supported as a{' '}
        <b>mirror and fallback</b>: a run uses the stored profile first, and falls back here for anything missing (typically
        the résumé file and account passwords). It is also where records are written to disk.
      </p>
      <div class="row wrap" style={{ marginTop: 10 }}>
        <button onClick={() => void pick()}>{linked ? 'Relink / change folder' : 'Link a folder'}</button>
        <span class="small muted">
          {linked === null ? 'Could not tell whether a folder is linked.' : linked ? 'A folder is linked.' : 'No folder linked.'}
        </span>
      </div>
      <NoteLine note={note} />
      <div class="hint">Chrome forgets the grant if you clear site data; relinking re-grants it in one click.</div>
    </Card>
  );
}

// ---- Gmail --------------------------------------------------------------------------------------

function GmailCard(): JSX.Element {
  const available = gmailApiAvailable();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (!available) return;
    void getToken(false).then((t) => setConnected(!!t));
  }, [available]);

  const connect = async (): Promise<void> => {
    setNote(null);
    const token = await getToken(true); // interactive — must stay inside the click handler
    setConnected(!!token);
    setNote(
      token
        ? { tone: 'ok', text: 'Connected. The emailed 8-character code is now read straight from Gmail.' }
        : { tone: 'err', text: 'Chrome returned no token — consent was dismissed, or the OAuth client is not set up for this build.' },
    );
  };

  return (
    <Card title="Gmail (for the emailed code)">
      <p class="small muted">
        Greenhouse emails an 8-character code on every apply. With Gmail connected, JobBot reads it over the read-only Gmail
        API. Without it, it falls back to scraping an open <code>mail.google.com</code> tab.
      </p>
      {!available ? (
        <Banner>
          <div>
            <strong>This build has no Gmail OAuth client.</strong>{' '}
            <span class="muted">
              <code>chrome.identity.getAuthToken</code> is unavailable, so there is nothing to connect — the tab scrape is the
              only OTP path. Set <code>GMAIL_OAUTH_CLIENT_ID</code> + <code>EXTENSION_KEY</code> and rebuild; see{' '}
              <code>docs/gmail-oauth.md</code>.
            </span>
          </div>
        </Banner>
      ) : (
        <div class="row wrap" style={{ marginTop: 10 }}>
          <button onClick={() => void connect()}>{connected ? 'Reconnect' : 'Connect Gmail'}</button>
          <span class="small muted">
            {connected === null ? 'checking…' : connected ? 'Connected (read-only).' : 'Not connected — using the tab scrape.'}
          </span>
        </div>
      )}
      <NoteLine note={note} />
    </Card>
  );
}

// ---- storage ------------------------------------------------------------------------------------

function StorageCard(): JSX.Element {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const s = storage.value;

  const prune = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const all = await listCaptures({ limit: 100_000 }); // newest first
      const old = all.slice(KEEP_CAPTURES);
      for (const c of old) await deleteCapture(c.captureId);
      setNote({ tone: 'ok', text: old.length ? `Deleted ${old.length} capture(s), kept the newest ${KEEP_CAPTURES}.` : 'Nothing to prune.' });
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    if (!confirm('Delete every stored log event? Applications and captures are untouched.')) return;
    setBusy(true);
    try {
      await clearEvents();
      setNote({ tone: 'ok', text: 'Log events cleared.' });
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const bundle = {
        exportedAt: new Date().toISOString(),
        profile: profile.value,
        profileMeta: profileMeta.value,
        applications: applications.value,
        runs: await listRuns(),
      };
      download(`jobbot-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
      setNote({ tone: 'ok', text: `Exported ${bundle.applications.length} application(s) and ${bundle.runs.length} run(s).` });
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Local data">
      <div class="kv">
        <span>Applications</span>
        <b>{applications.value.length}</b>
        <span>Log events</span>
        <b>{s.events.toLocaleString()}</b>
        <span>Captures</span>
        <b>
          {s.captures.count} · {bytes(s.captures.bytes)}
        </b>
      </div>
      <p class="small muted" style={{ marginTop: 10 }}>
        Applications live in <code>chrome.storage.local</code>; events, captures and résumés in this profile's IndexedDB.
        Nothing is sent anywhere.
      </p>
      <div class="row wrap" style={{ marginTop: 10 }}>
        <button class="ghost" disabled={busy} onClick={() => void prune()}>
          Prune captures
        </button>
        <button class="ghost" disabled={busy || s.events === 0} onClick={() => void clear()}>
          Clear log events
        </button>
        <button disabled={busy} onClick={() => void exportAll()}>
          Export everything
        </button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}

// ---- danger zone ----------------------------------------------------------------------------------

const WIPE_WORD = 'WIPE';

function DangerCard(): JSX.Element {
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const wipe = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const caps = await listCaptures({ limit: 100_000 });
      for (const c of caps) await deleteCapture(c.captureId);
      for (const r of await listResumes()) await removeResume(r.id);
      await clearEvents();
      await chrome.storage.local.clear();
      setTyped('');
      setNote({ tone: 'ok', text: 'Everything stored by the extension was deleted. Reload the dashboard to start clean.' });
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Danger zone" cls="mt danger-card">
      <p class="small muted">
        Deletes <b>everything this extension stores</b>: the profile, applications, runs, log events, captures and uploaded
        résumés. It does <b>not</b> touch your linked folder on disk, the applications already written there, or the Gmail
        grant (revoke that at <code>myaccount.google.com</code>).
      </p>
      <div class="row wrap" style={{ marginTop: 10 }}>
        <input
          value={typed}
          placeholder={`Type ${WIPE_WORD} to enable`}
          style={{ maxWidth: 220 }}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
        />
        <button class="danger" disabled={typed !== WIPE_WORD || busy} onClick={() => void wipe()}>
          Delete all extension data
        </button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}
