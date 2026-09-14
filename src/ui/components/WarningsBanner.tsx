import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { warningViews, type RunWarning } from '../app-view';
import { openTab } from '../actions';

// Things the RUN found that only the user can fix. They are raised by the LinkedIn content script
// (`linkedin-warning`) and kept on the run record, so this banner is a live read of what the page
// actually saw — never a guess, and never advice we could have acted on ourselves.

const KEY = 'linkedin_run';

interface LinkedinRunShape {
  readonly warnings?: readonly RunWarning[];
}

/** Live `linkedin_run.warnings`. The run record is deleted when a run ends, so the last warnings
 *  are kept in component state: a blocker usually IS why the run ended, and it must not blink out
 *  at the moment it becomes relevant. `live` says which of the two you are looking at. */
export function useRunWarnings(): { warnings: readonly RunWarning[]; live: boolean } {
  const [state, setState] = useState<{ warnings: readonly RunWarning[]; live: boolean }>({ warnings: [], live: false });

  useEffect(() => {
    let alive = true;
    const take = (run: LinkedinRunShape | undefined): void => {
      const warnings = run?.warnings ?? [];
      if (!alive) return;
      setState((prev) => (warnings.length > 0 ? { warnings, live: true } : prev.warnings.length > 0 ? { ...prev, live: false } : prev));
    };
    void chrome.storage.local
      .get(KEY)
      .then((got) => take(got[KEY] as LinkedinRunShape | undefined))
      .catch(() => undefined);
    const onChange = (ch: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && ch[KEY]) take(ch[KEY].newValue as LinkedinRunShape | undefined);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  return state;
}

/** Warnings for one pack (only LinkedIn raises them today) — nothing rendered when there are none. */
export function WarningsBanner({ siteId }: { siteId?: string }): JSX.Element | null {
  const { warnings, live } = useRunWarnings();
  const [hidden, setHidden] = useState<string[]>([]);

  if (siteId !== undefined && siteId !== 'linkedin') return null;
  const views = warningViews(warnings).filter((v) => !hidden.includes(v.code));
  if (views.length === 0) return null;

  return (
    <div class="col" style={{ gap: 6 }}>
      {views.map((v) => (
        <div key={v.code} class={`banner ${v.tone}`}>
          <div class="col" style={{ gap: 4, width: '100%' }}>
            <div class="row">
              <b>
                {v.blocking ? '⛔ ' : '⏳ '}
                {v.title}
              </b>
              {!live && <span class="tiny muted">from the last run</span>}
              <button class="sm ghost right" title="Hide until the page is reloaded" onClick={() => setHidden([...hidden, v.code])}>
                ✕
              </button>
            </div>
            <div class="small">{v.body}</div>
            <div class="tiny muted">The page reported: {v.detail}</div>
            {v.action && (
              <div class="row">
                <button class="sm" onClick={() => void openTab(v.action!.url)}>
                  {v.action.label}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
