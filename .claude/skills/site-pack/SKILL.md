---
name: site-pack
description: Add a new company/ATS "site pack" to JobBot from a careers-page or job URL — recon first, real snapshots as fixtures, observability built in, one-job dry run before any batch. Use when the user gives a careers/job/apply URL and wants the extension to apply there.
---

# site-pack — from a careers URL to a working, observable auto-apply pack

Input: a careers page, search page, job page or apply-page URL (plus, ideally, one screenshot of
the apply form). Output: `src/sources/<site>.ts` + `src/ats/<site>.ts` + `src/entrypoints/<site>.content.ts`
+ `src/sites/<site>.ts` (+ registry line), real fixtures, tests, and a verified one-job run.

The Amazon pack (2026-09-02) took ~12 build/run/read cycles because the order below was NOT
followed. Follow it in order; do not skip step 1 or 3.

## 1. Recon before code (30 min, no adapter code yet)
1. **Discovery API.** Open the listing page; look for an XHR/JSON behind it (`search.json`, Typesense,
   Algolia, GraphQL). `curl` it with the page's query string. Check that FILTER PARAMS ACTUALLY APPLY
   (Amazon ignored `country[]` and only honoured `normalized_country_code[]` — 2.6k hits vs 175).
   Save one real page as `fixtures/<site>-search.json`.
2. **Apply-page snapshots — real DOM, every step.** Ask the user to open the apply page, paste
   `debug/snapshot.js` into DevTools, and send the clipboard JSON — once per step (first section,
   after Continue, dependent questions revealed, review/submit page, already-applied page). Save as
   `fixtures/<site>-snapshot-<step>.json`. If the Chrome MCP works, do it yourself. **Never build
   an adapter from a JS bundle or a screenshot alone** — that is what cost the Amazon pack a day.
3. **Question schema.** If the app fetches questions as JSON (`/api/.../forms`), capture it — ids,
   types, options, `required`, dependencies. That is the offline oracle for the resolver.
4. Write the "ground truth" block in CLAUDE.md now: form structure, control types (native select?
   select2? react-select? radios by `name`?), how success/duplicate look (URL or DOM), timing facts
   (what mounts late), and which state the app itself exposes (a progress rail, `active` classes…).

## 2. Decide the policy with the user, up front
- `on_unknown`: `park` (safe) vs `guess` (never stuck; decline → own-country → No → first option).
- Experience ladders: numeric bucket vs `MAX`. Self-ID: `DECLINE`. Which answers are pre-filled by
  the ATS and must NOT be overwritten.
- `auto_submit`, `max_per_run` for the first batch (10–15), whether a queue cap/daily run is wanted.
- **Dry-run the selection**: `selectJobs(fixtureJobs, profile.want)` must return jobs — title
  words, `seniority`, `locations` filters silently emptied the Amazon queue.

## 3. Observability FIRST (before the adapter)
- The content script logs through `platform/debug-log.ts` (`dlog`): forms loaded, structural dump
  of the active section (`describeQuestions`), every field's options + chosen answer (+ guessed),
  Continue result with page state, outcome. The Logs page (`logs.html`) shows it; the background
  logs apply/outcome/port-closed. Without this every failure costs one more user cycle.
- Every park/error note must be self-describing (`describeState`), never "Filled through…" when
  nothing was filled.
- Record every field's final value (set / guessed / pre-filled) before Submit so the Applications
  page can show it (`pending_fields:<jobId>` → attached in the closed-port path).

## 4. Adapter rules that were each learned the hard way
- **Wait for the app's own "loaded" signal** (Amazon: the progress rail), not for a wrapper class —
  the empty shell already carried the `reviewing` flag.
- **Active section = the app's own state** (the rail's active item ↔ card heading), not "the card
  with the `active` class" nor "the visible card with controls" — during hydration every card is
  briefly visible and the flagged card can have all questions hidden.
- **Settle before reading**: wait for the first control, then for the control count to hold still;
  controls (select2 dropdowns) mount ~0.5s after wrappers.
- **Fill in passes** and re-scan: answering one question reveals dependents.
- **Look up a question by its visible wrapper inside the active section** — pages hold duplicate
  `data-questionid` wrappers (hidden copies without inputs come first in DOM order).
- **Verify each fill by reading the control back**; for radios click the input, then the label;
  never set `.checked` by hand (React's value tracker then skips onChange).
- **Native select under select2**: set `.value` + dispatch `change` (jQuery listener); the visible
  select2 box updates itself.
- **Transitions take seconds**: after Continue wait for EITHER the next section OR review mode;
  never park on a page that is about to become the finish line. Check review mode first in the loop.
- **Submit navigates away** → the content script dies → treat closed port + `Site.submittedUrl(url)`
  as success (`app/ports.ts`), and stash the field list before clicking.
- Pace with a timer (~6s) + a 30s alarm backup; a watchdog alarm re-drives a stalled run; cap one
  apply at 4 min.
- Extension loading: `npm run install:chrome` → load `~/.jobbot/extension`, never `.output/`
  (builds wipe it → Chrome drops the extension). Build with `.env` so the manifest `key` fixes the id.

## 5. Ship & verify
1. Unit tests against the real snapshots/fixtures (happy-dom) — `npm test` + `npm run compile` green.
2. One-job dry run: `max_per_run: 1`, `auto_submit: false`. Read the Logs page (or the LevelDB on
   disk: `~/Library/Application Support/Google/Chrome/<Profile>/Local Extension Settings/<ext-id>/`)
   — the outcome line must be "reached Review & submit" with the expected filled count.
3. Then `auto_submit: true`, `max_per_run: 10–15`; verify `summary?result=success`-style outcomes
   and the Applications page field table. Then remove the cap / arm the daily run.
4. Two review passes (correctness, architecture) before the PR; PR stacked on the open branch.

## Checklist to declare done
- [ ] discovery fixture real, filters verified to apply
- [ ] DOM snapshot fixtures for every step, including duplicate/success/limit pages
- [ ] ground-truth block in CLAUDE.md
- [ ] policy agreed (`on_unknown`, `MAX`, `DECLINE`, pre-filled respected, cap, auto_submit)
- [ ] debug log + self-describing notes + field record before submit
- [ ] one-job dry run read from the log, then a capped hands-free batch verified
