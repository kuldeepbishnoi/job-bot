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

/** Navigate the worker tab to a job and wait for load. */
export async function openJob(url: string): Promise<number> {
  const id = await ensureWorker();
  await chrome.tabs.update(id, { url });
  await waitForComplete(id);
  return id;
}

function waitForComplete(id: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
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
