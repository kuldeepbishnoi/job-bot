// Disk output with NO user step: when the profile folder is not linked (its File System Access
// grant needs a click in Chrome, and was lost on 2026-10-04), the extension asks JobBot's
// native-messaging host (scripts/native-host/jobbot-disk.mjs, registered by `npm run
// install:chrome`) to write the SAME files into profile/applications.
//
// chrome.downloads was tried first: on a Chrome with "Ask where to save each file" on, every
// capture opened a Save dialog (2026-10-04) — the opposite of "auto handled". Native messaging has
// no UI at all. With no host installed every call simply returns false.

const HOST = 'com.jobbot.disk';

async function send(msg: Record<string, unknown>): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendNativeMessage) return false;
  try {
    const r = (await chrome.runtime.sendNativeMessage(HOST, msg)) as { ok?: boolean } | undefined;
    return r?.ok === true;
  } catch {
    return false; // host not installed / not allowed — callers fall back to storage only
  }
}

/** Append text to profile/applications/<path>. */
export const nativeAppend = (path: string, text: string): Promise<boolean> => send({ op: 'append', path, text });

/** Create/overwrite profile/applications/<path>; `body` is text or a data: URL (screenshots). */
export function nativeWrite(path: string, body: string): Promise<boolean> {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(body);
  return send(m ? { op: 'write', path, base64: m[1] } : { op: 'write', path, text: body });
}
