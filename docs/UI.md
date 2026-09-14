# The console (UI architecture)

Two surfaces, one data layer, one component set.

- **Popup** (`src/entrypoints/popup/`, 320px) — a *remote control*. Start/Stop/Resume per site, live
  counters, dead-run alarm, links into the console. It owns no state: Chrome destroys it the moment
  the worker tab takes focus, so anything you need to *read* lives in the console.
- **Console** (`src/entrypoints/dashboard/`, full page) — Overview · Live · Runs · Applications ·
  Review · Logs · Sites · Profile · Settings. Replaces the old `logs.html`.

Both render Preact components from `src/ui/` against the same signals, so they can never disagree.

## Why Preact (and why only here)
The old popup polled `chrome.storage` every 2s and rebuilt its DOM with `innerHTML = ''`. That is
survivable for six numbers and fatal for a filterable 5 000-row table, a live log tail and a
schema-driven form. Preact + `@preact/signals` is ~7 KB min+gzip, bundled by WXT like `zod` and
`yaml` — no remote code, MV3-clean. **The framework stops at the UI**: `engine/` and `config/` stay
pure, the service worker and content scripts stay plain TypeScript.

## Layout
```
src/ui/
  theme.css        design tokens + primitives — the ONLY stylesheet both surfaces load
  router.ts        hash router (`#/apps/9101?status=parked`) as a signal
  store.ts         one signal per source of truth; fed by chrome.storage.onChanged + the IDB change channel
  facts.ts         readiness CHECKS (hosts, Gmail, logged-in tab, alarms, SW) — never assumptions
  actions.ts       start/stop/resume a pack; hides the three legacy start messages from every view
  flush.ts         writes the append-only files on disk (only an extension page holds the folder grant)
  components/      shared presentational bits (common.tsx) + feature components
  pages/           one file per route
  App.tsx          console shell (rail + route)
  Popup.tsx        popup surface
```

## Data
| Where | What | Why there |
|---|---|---|
| `chrome.storage.local` | `applications`, `runs`, `run_state`, `linkedin_run`, `profile_v1`, `daily_schedule:*`, `account` | small, hot, readable by content scripts; `onChanged` gives live updates free |
| IndexedDB `jobbot-data` | `events` (50k ring), `captures` (300 MB LRU), `resumes` | screenshots are 100–300 KB each and `chrome.storage.local` caps at 10 MB |
| `<profile>/applications/` | `applications.jsonl`, `registry.jsonl`, per-job `.md`/`.png`, `review.jsonl`, `log-<date>.txt` | the owner's append-only on-disk record; written by `ui/flush.ts` |

IndexedDB `jobbot-data` is a **separate database** from the `jobbot` one `platform/fs-config.ts`
uses for the directory handle — don't merge them, the handle store has different lifetime rules.

Entities live in `src/engine/records.ts` (pure): `Run`, `LogEvent`, `Capture`, `ResumeMeta`, plus
`runHealth()` and `inferLevel()`. Applications and fields stay in `engine/types.ts`.

## The observability seam
`src/app/observe.ts` is the only writer of run state. Orchestrators (`app/stepper.ts`,
`app/linkedin-run.ts`, `app/instahyre-run.ts`) call `runStarted / runStep / runOutcome / runPaused /
runEnded / event / capture`. Every call is best-effort: a failed write must never abandon a job that
was about to be submitted.

## Honesty rules (the point of the rewrite)
1. **No spinner without a fact.** A status line carries its evidence: `17/42 · step otp for 12s · ♥ 3s`.
2. **Health is derived, never declared.** `runHealth(run, now, pack.stallMs, pack.deadMs)` compares
   the heartbeat age to the *same thresholds the watchdogs use*, so the UI and the watchdog agree by
   construction. Waiting on the user is its own state — it is not stalling.
3. **Every finished run states why** (`endReason`): "exhausted (42/42)", "LinkedIn daily limit",
   "stopped by you", "watchdog gave up after 40 min". A bare "Done" is a bug.
4. **Readiness is checked**: `chrome.permissions.contains`, `chrome.alarms.getAll`, `tabs.query`,
   `getToken(false)`. A check that cannot be made reports "unknown", not a tick.
5. **Every empty state names the next action.**

## Adding a site: zero UI code
Add the adapter and the `Site`, then one entry in `src/sites/index.ts`. `src/sites/packs.ts` derives a
`SitePack` descriptor from it (icon, hosts, steps, stall/dead thresholds, what it needs, what it
supports, which `profile.<key>` block configures it). The popup's buttons, the Overview cards, the
Sites settings form, the funnel and every filter iterate `PACKS` — none of them names a company.

In-page packs (Instahyre, LinkedIn) declare `kind: 'in-page'` and a `loggedInTab` prefix; the console
checks for that tab instead of pretending it can open one.
