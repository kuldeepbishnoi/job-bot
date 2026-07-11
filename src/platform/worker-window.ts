// A single reusable tab in the user's current window that processes jobs one at a time.
// We keep it the ACTIVE tab so it stays visible — a backgrounded tab reports
// visibilityState "hidden", which throttles timers and can break react-select/reCAPTCHA.
// One tab, reused across the whole queue, so we never spawn a separate window.

let tabId: number | undefined;

export async function ensureWorker(): Promise<number> {
  if (tabId !== undefined) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      tabId = undefined; // was closed
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('worker tab has no id');
  tabId = tab.id;
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
  if (tabId !== undefined) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already gone */
    }
    tabId = undefined;
  }
}
