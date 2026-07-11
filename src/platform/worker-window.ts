// A dedicated, unfocused-but-visible window that processes jobs one tab at a time.
// Your main window (Netflix) keeps focus; this one sits behind it and still renders
// (visibilityState stays "visible" as long as it isn't minimized), so react-select
// and reCAPTCHA behave normally.

let windowId: number | undefined;
let tabId: number | undefined;

export async function ensureWorker(): Promise<number> {
  if (windowId !== undefined) {
    try {
      await chrome.windows.get(windowId);
      return tabId!;
    } catch {
      windowId = undefined; // was closed
    }
  }
  const win = await chrome.windows.create({ focused: false, width: 1100, height: 900, url: 'about:blank' });
  windowId = win.id;
  tabId = win.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error('worker window has no tab');
  return tabId;
}

/** Navigate the worker tab to a job and wait for load (bounded — never hangs the queue). */
export async function openJob(url: string): Promise<number> {
  const id = await ensureWorker();
  await chrome.tabs.update(id, { url });
  await waitForComplete(id);
  return id;
}

function waitForComplete(id: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === id && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Guard the race where the tab reached 'complete' before the listener attached.
    chrome.tabs.get(id).then((tab) => tab.status === 'complete' && finish()).catch(() => {});
    // Never block the queue forever; the content-script readiness ping handles the rest.
    const timer = setTimeout(finish, timeoutMs);
  });
}

export async function closeWorker(): Promise<void> {
  if (windowId !== undefined) {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      /* already gone */
    }
    windowId = undefined;
    tabId = undefined;
  }
}
