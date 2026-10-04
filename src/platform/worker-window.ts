// One worker tab PER LANE, so sites apply in parallel (2026-10-04, owner: "there should be
// parallelism"). A lane is usually a site; sites that share an emailed-code inbox share a lane
// (app/ports.ts#laneFor) so their codes can never cross.
//
// Each lane gets its own window, its tab the active one in it: a backgrounded tab reports
// visibilityState "hidden", which throttles timers and breaks react-select/reCAPTCHA — and only one
// tab per window can be active. The windows cascade so none is fully covered (a fully occluded
// window is reported hidden too). Lane → tab is kept in storage, so a service worker restart reuses
// the lane's window instead of opening another.

const KEY = 'worker_tabs';
const tabs = new Map<string, number>();

async function remembered(lane: string): Promise<number | undefined> {
  if (tabs.has(lane)) return tabs.get(lane);
  const got = (await chrome.storage.local.get(KEY))[KEY] as Record<string, number> | undefined;
  return got?.[lane];
}

async function remember(lane: string, id: number | undefined): Promise<void> {
  if (id === undefined) tabs.delete(lane);
  else tabs.set(lane, id);
  const got = ((await chrome.storage.local.get(KEY))[KEY] as Record<string, number> | undefined) ?? {};
  const next = { ...got };
  if (id === undefined) delete next[lane];
  else next[lane] = id;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function ensureWorker(lane = 'default'): Promise<number> {
  const known = await remembered(lane);
  if (known !== undefined) {
    try {
      await chrome.tabs.get(known);
      return known;
    } catch {
      await remember(lane, undefined); // was closed
    }
  }
  const open = ((await chrome.storage.local.get(KEY))[KEY] as Record<string, number> | undefined) ?? {};
  const slot = Object.keys(open).length; // cascade: each new lane 48px further in
  const win = await chrome.windows
    .create({ url: 'about:blank', focused: false, type: 'normal', width: 1100, height: 900, left: 40 + slot * 48, top: 40 + slot * 48 })
    .catch(() => null);
  const id = win?.tabs?.[0]?.id ?? (await chrome.tabs.create({ url: 'about:blank', active: true })).id;
  if (id === undefined) throw new Error('worker tab has no id');
  await remember(lane, id);
  return id;
}

/** Navigate the lane's worker tab to a job and wait for load (bounded — never hangs the queue). */
export async function openJob(url: string, lane = 'default'): Promise<number> {
  const id = await ensureWorker(lane);
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

/** Close one lane's worker (its window goes with its only tab). */
export async function closeWorker(lane = 'default'): Promise<void> {
  const id = await remembered(lane);
  if (id === undefined) return;
  try {
    await chrome.tabs.remove(id);
  } catch {
    /* already gone */
  }
  await remember(lane, undefined);
}
