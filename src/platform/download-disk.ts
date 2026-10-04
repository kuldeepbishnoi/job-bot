// Disk output with NO user step: when the profile folder is not linked (its File System Access
// grant needs a click in Chrome, and was lost on 2026-10-04 — every capture and the complete log
// went nowhere), write the same records through chrome.downloads into ~/Downloads/jobbot/.
//
// Owner, 2026-10-04: "it should be auto handled not by user". chrome.downloads needs no gesture.
// The download bar is switched off for our saves (downloads.ui) and each finished item is erased
// from Chrome's download HISTORY (erase never deletes the file), so nothing piles up on screen.
// Downloads cannot append, so the log is written as one file per flush (logs/<day>/<time>.txt);
// debug/outcomes.mjs concatenates them.

const ROOT = 'jobbot';
let uiOff = false;

async function quietUi(): Promise<void> {
  if (uiOff) return;
  uiOff = true;
  try {
    await (chrome.downloads as unknown as { setUiOptions?: (o: { enabled: boolean }) => Promise<void> }).setUiOptions?.({ enabled: false });
  } catch {
    /* older Chrome / no downloads.ui — files still save, the bar just shows them */
  }
}

/** UTF-8 safe base64 for a data: URL (the service worker has no URL.createObjectURL). */
function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const safe = (p: string): string => p.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\/+/g, '/').replace(/^\/|\.\.+/g, '');

/** Save one file under ~/Downloads/jobbot/<path>. `body` is text, or an existing data: URL
 *  (screenshots). Best-effort: never throws — disk output must never fail a run. */
export async function saveToDownloads(path: string, body: string, mime = 'text/plain'): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.downloads?.download) return false;
  try {
    await quietUi();
    const url = body.startsWith('data:') ? body : `data:${mime};charset=utf-8;base64,${b64(body)}`;
    const id = await chrome.downloads.download({ url, filename: `${ROOT}/${safe(path)}`, conflictAction: 'overwrite', saveAs: false });
    // Forget it from the downloads LIST once written (the file stays on disk).
    const done = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(done);
      void chrome.downloads.erase({ id }).catch(() => {});
    };
    chrome.downloads.onChanged.addListener(done);
    return true;
  } catch (e) {
    console.warn('[jobbot] could not save to Downloads', path, (e as Error).message);
    return false;
  }
}

/** A run of log lines → logs/<day>/<HH-MM-SS-mmm>.txt (one file per flush; downloads cannot append). */
export async function saveLogChunk(lines: readonly string[]): Promise<boolean> {
  if (!lines.length) return true;
  const day = /^\d{4}-\d\d-\d\d/.test(lines[0] ?? '') ? lines[0]!.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().slice(11, 23).replace(/[:.]/g, '-');
  return saveToDownloads(`logs/${day}/${stamp}.txt`, lines.join('\n') + '\n');
}
