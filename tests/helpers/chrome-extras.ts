// Alarms / tabs / runtime on top of the storage fake, for the orchestration tests (stepper,
// linkedin-run, instahyre-run). Deliberately dumb: every call resolves, a tab answers the
// readiness pong, so the code under test walks its real path without a browser.
import { installChromeFake, type ChromeFake } from './chrome-fake';

export interface ChromeRuntimeFake extends ChromeFake {
  /** What the code under test asked the browser to do (the fake APIs live on globalThis.chrome). */
  calls: {
    alarmsCreated: Record<string, unknown>;
    alarmsCleared: string[];
    tabsCreated: string[];
    tabsUpdated: { tabId: number; url?: string }[];
    tabMessages: { tabId: number; msg: { t: string } }[];
  };
  /** What a tab answers; default is the readiness pong. */
  tabReply: (msg: { t: string }) => unknown;
}

export function installChromeRuntimeFake(opts: { tabId?: number; existingTabs?: { id: number }[] } = {}): ChromeRuntimeFake {
  const base = installChromeFake() as ChromeRuntimeFake;
  const tabId = opts.tabId ?? 7;
  const calls: ChromeRuntimeFake['calls'] = { alarmsCreated: {}, alarmsCleared: [], tabsCreated: [], tabsUpdated: [], tabMessages: [] };
  const state = { calls, tabReply: ((): unknown => ({ pong: true })) as ChromeRuntimeFake['tabReply'] };

  const c = globalThis.chrome as unknown as Record<string, unknown>;
  c['alarms'] = {
    create: async (name: string, info: unknown) => void (calls.alarmsCreated[name] = info),
    clear: async (name: string) => void calls.alarmsCleared.push(name),
    get: async () => undefined,
    onAlarm: { addListener: () => {} },
  };
  c['tabs'] = {
    create: async ({ url }: { url?: string }) => {
      calls.tabsCreated.push(url ?? '');
      return { id: tabId, windowId: 1, url };
    },
    update: async (id: number, info: { url?: string }) => {
      calls.tabsUpdated.push({ tabId: id, ...(info.url ? { url: info.url } : {}) });
      return { id, windowId: 1 };
    },
    query: async () => opts.existingTabs ?? [],
    get: async (id: number) => ({ id, windowId: 1, url: 'https://www.linkedin.com/jobs/search/' }),
    sendMessage: async (id: number, msg: { t: string }) => {
      calls.tabMessages.push({ tabId: id, msg });
      return state.tabReply(msg);
    },
    captureVisibleTab: async () => null,
    onUpdated: { addListener: () => {} },
  };
  c['runtime'] = { sendMessage: async () => ({}), id: 'test', onMessage: { addListener: () => {} } };

  // `calls` / `tabReply` are accessors so they survive the API objects above being assigned onto
  // the same chrome object.
  Object.defineProperty(base, 'calls', { value: calls, configurable: true });
  Object.defineProperty(base, 'tabReply', {
    configurable: true,
    get: () => state.tabReply,
    set: (fn: ChromeRuntimeFake['tabReply']) => void (state.tabReply = fn),
  });
  return base;
}
