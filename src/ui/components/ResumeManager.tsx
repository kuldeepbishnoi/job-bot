import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { ResumeMeta } from '@/engine/records';
import { addResume, getResume, removeResume } from '@/platform/data/resumes';
import { resumes } from '../store';
import { href } from '../router';
import { download, Empty } from './common';
import { resumeKind } from '../profile-draft';

// Résumés live in IndexedDB inside the extension; `profile.resume` holds the id of the one a run
// uploads. The legacy "resume: resume/foo.pdf" path (read from the picked folder) still works —
// it is shown as what it is rather than pretended to be a stored file.

const ACCEPT = '.pdf,.doc,.docx';
const MAX_BYTES = 8 * 1024 * 1024; // a résumé that big is a mistake, and chrome.storage would choke

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResumeManager({ current, onPick }: { current: string; onPick: (id: string) => void }): JSX.Element {
  const list = resumes.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const kind = resumeKind(current, list.map((r) => r.id));

  const accept = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      let last = '';
      for (const file of Array.from(files)) {
        if (!/\.(pdf|docx?)$/i.test(file.name)) throw new Error(`${file.name}: only PDF / DOC / DOCX are accepted`);
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is ${bytes(file.size)} — keep a résumé under ${bytes(MAX_BYTES)}`);
        const meta = await addResume(file, { name: file.name, type: file.type });
        last = meta.id;
      }
      // First upload (or one replacing a dangling reference) becomes the default — otherwise a run
      // would still fail with "no résumé" right after a successful upload.
      if (last && (kind === 'unset' || kind === 'missing')) onPick(last);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async (r: ResumeMeta): Promise<void> => {
    const file = await getResume(r.id);
    if (file) download(r.name, file.blob, file.type);
  };

  const drop = async (r: ResumeMeta): Promise<void> => {
    if (!confirm(`Delete "${r.label}" (${r.name})? The file is only stored here.`)) return;
    await removeResume(r.id);
    if (current === r.id) onPick(''); // never leave profile.resume pointing at nothing silently
  };

  return (
    <div class="col">
      <div
        class={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void accept(e.dataTransfer?.files ?? null);
        }}
      >
        <b>Drop a résumé here</b>
        <span class="small muted">PDF, DOC or DOCX · stored in this extension only, never uploaded anywhere but the job form</span>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={busy}
          onChange={(e) => void accept((e.target as HTMLInputElement).files)}
        />
      </div>

      {error && <div class="ferr">{error}</div>}

      {kind === 'legacy-path' && (
        <div class="banner">
          <div>
            <strong>
              <code>{current}</code> is read from the linked folder.
            </strong>{' '}
            <span class="muted">
              That still works: the run loads the file from the profile folder you picked. Upload it here instead to make runs
              work without the folder grant. <a href={href('/settings')}>Manage the folder in Settings →</a>
            </span>
          </div>
        </div>
      )}
      {kind === 'missing' && (
        <div class="banner err">
          <div>
            <strong>
              <code>{current}</code> does not match any stored résumé.
            </strong>{' '}
            Upload the file and set it as default, or point this at the folder path it used to be.
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <Empty title="No résumé stored yet">
          <span>Upload one above. Until then a run falls back to the linked profile folder, if you have one.</span>
        </Empty>
      ) : (
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Default</th>
                <th>Label</th>
                <th>File</th>
                <th>Size</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} class={current === r.id ? 'selected' : ''}>
                  <td>
                    {current === r.id ? (
                      <span class="pill ok">in use</span>
                    ) : (
                      <button class="sm ghost" onClick={() => onPick(r.id)}>
                        Use this
                      </button>
                    )}
                  </td>
                  <td>
                    <b>{r.label}</b>
                    <div class="tiny muted mono">{r.id}</div>
                  </td>
                  <td class="mono tiny">{r.name}</td>
                  <td class="nowrap">{bytes(r.size)}</td>
                  <td class="nowrap muted">{new Date(r.addedAt).toLocaleDateString()}</td>
                  <td>
                    <div class="row right">
                      <button class="sm ghost" onClick={() => void save(r)}>
                        Download
                      </button>
                      <button class="sm ghost danger" onClick={() => void drop(r)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
