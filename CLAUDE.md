# CLAUDE.md — agent onboarding

Read this first. It's the contract for working in this repo. Keep it accurate when you change things.

## What this is
A Chrome MV3 extension (WXT + TypeScript) that auto-applies to jobs from the user's **real
browser**. **Datadog** is the first "site pack"; **Amazon** (amazon.jobs) and **Instahyre** followed. The extension approach is deliberate: the real
browser mints the reCAPTCHA token, carries the session/fingerprint, and uploads the resume
natively — so we never fight the anti-bot stack. **Do not** rewrite this as a raw-HTTP API bot.

## Ground truth (discovered from HAR + the live form — don't re-derive)
- The Datadog form is a **cross-origin iframe** `job-boards.greenhouse.io/embed/job_app` injected
  into `#grnhse_app` on `careers.datadoghq.com`. Content scripts inject with `all_frames:true`.
- Apply is **two-phase**: submit → Greenhouse emails an **8-char code** (from
  `no-reply@us.greenhouse-mail.io`) → type it into 8 boxes → submit again. Not a captcha; it fires
  every apply because the user isn't logged into Greenhouse.
- reCAPTCHA is **v3 invisible** — passes silently in a real browser. We never touch it.
- Dropdowns are **react-select** (not native `<select>`): options render only after opening the
  control. Fill = click `.select__control` → click `.select__option` by text. Multi-select question
  ids end with `[]`.
- Resume: set `<input id="resume" type="file">` via DataTransfer; Greenhouse's own JS runs the
  presigned-S3 upload.
- Standard field ids are stable (`first_name`, `email`, `phone`, `country`, `resume`). Custom
  questions are `question_<id>` and `<id>` **changes per job** → always extract dynamically.
- Discovery = **Typesense** (`gk6e3zbyuntvc5dap.a1.typesense.net/multi_search`, public search key in
  `src/sources/typesense.ts`). One paginated `q:*` query = all ~423 jobs; each doc has
  `location_string` used to answer the "which cities" question (no JD scrape).

`fixtures/typesense-response.json` and `fixtures/greenhouse-form.html` are real captures; the tests
run against them. They're the offline oracle — don't hand-edit; refresh from a new HAR if needed.
(`fixtures/amazon-apply.html` is the one derived fixture — regenerate it, see below.)

### Amazon ground truth (from the live JSON API + the apply app's bundle, 2026-09-02)
- Discovery: the search page `/en/search?…` is backed by **`/en/search.json`** with the same query
  string, except the API only honours **`normalized_country_code[]`** (the page's `country[]` is
  silently ignored → worldwide results). `result_limit=100` + `offset` pages; `hits` = total. Each
  job has `id_icims` (the id in every URL) and `locations[]` (JSON strings with `city`).
  `fixtures/amazon-search.json` is a real page.
- Apply: **`/applicant/jobs/<id>/apply`** is Amazon's own React app (react-rails; NOT Greenhouse),
  logged-in session required — so it runs in the user's real tab like Datadog. Already applied →
  redirects to `/summary?result=duplicate` (`ApplicationDuplicateScreen`). Submit success →
  the app **navigates away** (kills the content script → the closed port + new URL = success,
  `app/ports.ts#outcomeAfterPortClosed`).
- Questions come from `GET /api/apply/forms?job_id=<id>` (`fixtures/amazon-forms.json` = the real
  schema for one job): forms in order, one **active** at a time (`.card.question-form.active`);
  Continue = `POST /api/apply/forms/save` + next form; `.question-forms.reviewing` +
  `.submit-application-button button.submit` at the end. Types: DROPDOWN = native `<select>` +
  select2 (set value + dispatch `change`), RADIO_BUTTON = `input[name=<qid>][value=<key>]`,
  BOOLEAN = one checkbox, MULTISELECT_DROPDOWN = `<select multiple>`, CHECK_LIST = checkboxes.
  Every question sits in `[data-questionId=<id>]`; job-specific ids end in `-AQ` and change per
  job; standard ids are stable (`REQUIRE_SPONSORSHIP_CAN`, `DIVERSITY_GENDER_CAN`…).
- Answers from the previous application are **reused** (pre-filled), so normally only the
  job-specific dropdowns are empty. The self-ID forms offer "I choose not to self-identify"
  (= `DECLINE`). A one-time `#aiPreferenceModal` (Yes/No + confirm) can gate submit.
- `fixtures/amazon-apply.html` is **generated** (`npm run fixture:amazon`): real question schema
  wrapped in markup transcribed from the bundle. Not a live page capture (needs the session).
- Submit-by-navigation is declared per site (`Site.submittedUrl`, `src/sites/site.ts`) so the
  apply port stays site-agnostic.

## Architecture — Clean Architecture, applied
Dependency direction points **inward**: outer layers depend on inner, never the reverse
(the Dependency Rule, Clean Architecture ch. 22). Inner = pure policy; outer = details.

```
INNER (pure: no chrome, no DOM, no network — unit-tested)
  src/engine/     types · matcher (question→intent) · answer-tokens · resolver ·
                  select-jobs · stats
  src/config/     schema.ts (zod) — validates profile.yaml at the boundary
APPLICATION (orchestration; depends on ports, not details)
  src/app/        runner.ts (the use case) + ports.ts (RunPorts interface + chrome wiring)
ADAPTERS (details, behind interfaces)
  src/sources/    where jobs come from — typesense.ts · amazon-jobs.ts
  src/ats/        how a form is filled — greenhouse.ts · amazon.ts · instahyre.ts (+ dom.ts)
  src/sites/      a company = source + ATS — site.ts (interface), datadog.ts, amazon.ts, index.ts
  src/platform/   side effects, isolated — worker-window · gmail-otp · fs-config ·
                  messaging · serialized-file · store (chrome.storage repo) · schedule (daily alarm)
MAIN (dirtiest; wires everything)
  src/entrypoints/  background.ts (assembles ports → runner; daily alarm) · greenhouse.content.ts ·
                    amazon.content.ts · instahyre.content.ts · gmail.content.ts · popup/
profile/     the USER's data: profile.yaml + resume/ (git-ignored)
fixtures/    real captured data for offline tests
```

### Invariants (do not break — these are the Dependency Rule in practice)
1. `engine/` and `config/` are **pure**: no `chrome.*`, no `fetch`, no DOM, no `Date.now()` leaking
   into logic. That's why they unit-test without a browser. If you need an effect there, you're in
   the wrong layer.
2. `app/runner.ts` is a **use case**: it depends only on the `RunPorts` interface + pure engine.
   All effects (open tab, fill, read Gmail, persist, sleep, clock) are injected. This keeps it
   testable with fakes (`tests/runner.test.ts`) — Humble Object pattern (ch. 23/28).
3. Concrete effects are assembled in **one place**: `app/ports.ts#chromePorts()` (the "Main" seam,
   ch. 26). `background.ts` calls it. Nothing else builds ports.
4. Boundary-crossing values are **plain data** (`Profile`, `Job`, `SerializedFile`, message unions
   in `platform/messaging.ts`) — never DOM nodes or class instances across the wire.
5. Answers are **intent-based**, never keyed by exact question text (except `profile.overrides`):
   raw label → `Intent` (`matcher.ts`) → value (`resolver.ts`). Same rules answer Datadog, Amazon…
6. Answer values are **typed by question shape**: `boolean` (yes/no), `string` (single choice/free
   text), `string[]` (multi), `number` (a "how many years" ladder → `engine/years.ts` picks the
   bucket), or a canonical **token** (`answer-tokens.ts`: `DECLINE`,
   `NOT_A_VETERAN`, `NO_DISABILITY`) that maps to each company's wording. No magic strings in config.
7. Locations are **derived**, never typed: `resolveLocations` picks dropdown options ∩ (job's own
   location ∪ `want.locations`). One list drives both job selection and the cities answer.
8. Apply runs **sequentially** in one worker window → only one OTP email pending at a time (the
   email names no job, so parallelism would mismatch codes). This is also politeness/rate-limiting
   (System Design Interview ch. 4 & 9): don't hammer the ATS.
9. `auto_submit:false` is the safe default — fill + enter code, then park for the user's click.

## Chrome Web Store best practices honored
(https://developer.chrome.com/docs/webstore/best-practices)
- **Least privilege**: permissions are `storage`, `tabs`, `alarms`, `identity` — each used (alarms
  steps the queue across SW restarts; identity fetches the read-only Gmail token for the OTP). No
  `scripting`. host_permissions are the specific hosts we touch (incl. `gmail.googleapis.com` for the
  OTP read), not `*://*`.
- **MV3 lifetime**: never run a long loop in the background SW — it gets killed. The run is an
  alarm-driven stepper (`app/stepper.ts`): one job per wake, queue persisted in storage. Daily
  hands-off runs are a second alarm (`platform/schedule.ts`): the popup caches the profile + résumé
  (it alone has the FS-access gesture) and the background starts the same stepper on fire. The
  cache is a snapshot — profile.yaml edits apply only after re-ticking the toggle.
- **Profile loading happens in the popup** (`loadProfileAndResume` needs the File System Access
  permission + user gesture); the profile is passed to the background in the `run` message. The SW
  must never call `showDirectoryPicker`/`requestPermission`.
- **Frame readiness**: the Greenhouse form is a late async iframe; the background pings (`t:'ping'`)
  until the content script answers before sending `apply` (`app/ports.ts#waitForFrame`).
- **Single purpose**: apply to jobs. Nothing else.
- **No remote code**: everything is bundled by WXT; no eval, no CDN scripts.
- **Privacy**: the résumé and profile never leave the machine; applications/stats live in
  `chrome.storage.local`. Say so in any store listing; add a privacy policy before publishing.
- When adding a permission or host, justify it in the PR description.

## How to extend
- **Applying: run the `apply-jobs` skill** (`.claude/skills/apply-jobs/SKILL.md`): reads `profile.yaml`'s `careers:`
  list, runs the matching packs, reports from disk via `node debug/outcomes.mjs` (few tokens).
- **Adding any new site: run the `site-pack` skill first** (`.claude/skills/site-pack/SKILL.md`). It is the
  recon → snapshot → observability → adapter → dry-run order that the Amazon pack learned the hard way.
  `debug/snapshot.js` (paste in DevTools) captures the real DOM of any apply step as JSON.
- **New Greenhouse company**: add `src/sources/<co>.ts` (discovery) + `src/sites/<co>.ts`
  (`{ id, label, ats:'greenhouse', discover }`) + one line in `src/sites/index.ts`. The popup button
  and pipeline light up automatically.
- **Site with its own ATS (Amazon)**: `src/sources/amazon-jobs.ts` + `src/ats/amazon.ts` (pure DOM,
  tested against the generated fixture) + `src/entrypoints/amazon.content.ts` (same ping/apply
  contract as Greenhouse) + `src/sites/amazon.ts` with `ats:'amazon'`. It rides the normal
  discover→worker-tab→stepper pipeline; no OTP. `Site.discover(profile)` gets the profile because the
  search filters are the user's (`profile.amazon.search_url`).
- **New ATS (Lever/Workday)**: add `src/ats/<ats>.ts` with the same surface as `greenhouse.ts`
  (`extract`, `optionsFor`, `fill`, `submitButton`, `needsOtp`, `fillOtp`, `confirmed`); reference it
  from a content script matched to that host.
- **In-page ATS (Instahyre)**: some sites have no form/resume/OTP — applying is one in-page click in
  the user's *already-logged-in* tab. These bypass the discover→worker-window→OTP pipeline entirely.
  Pattern (see Instahyre): pure DOM adapter `src/ats/<co>.ts` (locate the apply/skip/bulk controls,
  unit-tested in happy-dom) + a content script `src/entrypoints/<co>.content.ts` matched to the host
  that runs the click loop in-page + `src/app/<co>-run.ts` (find/focus the logged-in tab, ping-ready,
  kick off, record each apply into the shared store) wired from `background.ts` + its own popup button.
  Do NOT register it in `src/sites/` — that path assumes a worker window + Greenhouse form.
- **New question type**: add a rule in `engine/matcher.ts` + a default in `profile.example.yaml` + a
  case in `tests/matcher.test.ts`. New standard decline-style answer → add a token in
  `engine/answer-tokens.ts`.

## Local data & multi-account (owner's rules: complete, on disk, append-only, no repeats)
- `profile/applications/applications.jsonl` — one line per application: the full record (every field
  set / guessed / pre-filled), outcome, URL, timestamps, account, and that job's log lines.
  `profile/applications/registry.jsonl` — job id → account → date. Written by the popup
  (`fs-config.flushToDisk`, needs the folder grant) and by `node debug/export.mjs` straight from
  Chrome's storage on disk. `node debug/outcomes.mjs` = today's summary in a few lines.
- **Multi-account, one Chrome profile**: `profile.accounts` lists every login; the popup's "Account"
  field says which one is logged in now (stamped on every record). At `per_account_limit` (Amazon:
  10/day) or the ATS's own limit page, the stepper **rotates**: opens `Site.logoutUrl` then
  `Site.loginUrl` in the worker tab, saves `run_state.paused = { nextAccount }`, and the popup
  shows "Resume as next account". The user logs in; Resume sets the account and continues the same
  queue. Every run also excludes the registry's job ids, so accounts never repeat a job. The bot
  never types credentials. Seed a registry: `node debug/export.mjs --account <email>`.

## Commands
```
npm install          # once
npm run dev          # load unpacked dev extension in Chrome (HMR)
npm run build        # production build -> .output/chrome-mv3
npm run install:chrome  # build + sync to ~/.jobbot/extension — load THAT folder in chrome://extensions
npm test             # unit tests against fixtures (must stay green)
npm run compile      # tsc --noEmit (must stay clean)
npm run mitm         # start mitmweb + Chrome (scratch profile) — see debug/README.md
npm run mitm:stop    # kill scratch Chrome + mitmweb
npm run mitm:reset   # clear debug/captures/
```

## Debugging live forms
Don't guess at DOM changes — capture them. `npm run mitm -- <url>` boots mitmweb and a
Chrome instance (with the built extension pre-loaded) routed through it, dumping every
relevant response body to `debug/captures/`. See `debug/README.md` for the full workflow
including `USE_MY_PROFILE=1` for running against your real Chrome session (Gmail login,
cookies) — must quit Chrome first.

## Workflow rules (from the repo owner)
- **Never push to `master`/`main` directly.** Work on a branch and open a PR; the owner + Claude
  review first. Address PR comments, then update the PR.
- Keep `npm run compile` clean and `npm test` green in every commit.
- Prefer small, single-reason changes (SRP at the commit level).

## Status & next steps
See `docs/STATUS.md`. Built + unit-tested: pure core, discovery, Greenhouse extract/fill/OTP,
Amazon discovery + apply adapter, daily scheduling, ports-based orchestration, popup. OTP reads via the **Gmail API** (`platform/gmail-api.ts`) when the
user connects their account (see `docs/gmail-oauth.md`), falling back to the open-Gmail-tab scrape.
**Not yet**: a live Amazon run (adapter built from the bundle + API, not a page capture — verify
selectors on the first real apply), Playwright e2e.

## Gotchas
- **Load the extension from `~/.jobbot/extension` (`npm run install:chrome`), never from `.output/`.**
  `wxt build`/`wxt dev` delete and recreate `.output/chrome-mv3`; if Chrome starts or you hit Reload
  while it's gone, Chrome drops the unpacked extension. Also build with `.env` present: the manifest
  `key` fixes the extension id — without it the id is path-derived, and an id flip on Reload makes
  Chrome replace the card (and forget the profile-folder link + Gmail token, stored per id).
- React inputs ignore `el.value = x`; use `setReactValue` (native setter + input/change events).
- Amazon's Contact-information / Resume / SMS steps are profile-level (different components, not
  `.question-form`). The adapter assumes they're already complete; if one is active the apply
  times out → `failed` with "waitFor: timeout" — finish it once by hand.
- Amazon `want.locations` interplay: the search URL pins the country, but `selectJobs` still applies
  `want.locations` — keep the searched cities in it (or empty).
- The worker window must stay **visible (unfocused)** — if minimized, `visibilityState:hidden`
  throttles timers and can hurt reCAPTCHA. Don't minimize it.
- OTP: `platform/gmail-otp.ts#getOtp` prefers the Gmail API (`gmail-api.ts`) and falls back to
  scraping an open Gmail tab. The API path needs one-time OAuth setup (`docs/gmail-oauth.md`) enabled
  via `GMAIL_OAUTH_CLIENT_ID` + `EXTENSION_KEY` build env; without them it's tab-scrape only.
  Freshness matters: getOtp excludes codes seen before submit and reads newest-first, so a lingering
  old code is never replayed.
