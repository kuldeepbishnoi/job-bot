# CLAUDE.md — agent onboarding

Read this first. It's the contract for working in this repo. Keep it accurate when you change things.

## What this is
A Chrome MV3 extension (WXT + TypeScript) that auto-applies to jobs from the user's **real
browser**. **Datadog** is the first "site pack"; **Amazon** (amazon.jobs), **Instahyre**, **LinkedIn**
(Easy Apply) and the three **multi-company board packs** — **Greenhouse boards** (every Greenhouse
company via the public Job Board API), **Lever** and **Ashby** — followed. The extension approach is deliberate: the real
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

### LinkedIn Easy Apply ground truth (from two shipping auto-apply extensions' adapters, 2026-09-04)
Built by reading the unpacked source of "LinkedIn AutoApplier" and "AutoApplyMax" (their selectors
are what drives the live DOM); `tests/linkedin.test.ts` transcribes that markup. Not yet a live
page capture — the first real run reads the Logs page and fixes selectors from `describeState`.
- **Two layouts.** Legacy `/jobs/search/` (+ `/jobs/collections/*`): cards `li[data-occludable-job-id]`
  (virtualized: below-the-fold cards hold `<!---->` until scrolled), details pane
  `.jobs-search__job-details` with `button.jobs-apply-button` ("Easy Apply"; an external job says
  plain "Apply"), modal `.jobs-easy-apply-modal` in the light DOM. New `/jobs/search-results/`:
  cards `div[componentkey="job-card-component-ref-<id>"][role=button]` with positional `<p>`s
  (title, company, location, …, "Easy Apply"), the control is `<a aria-label="Easy Apply to this job">`
  and the modal lives in an OPEN shadow root at `#interop-outlet` — `ats/linkedin.ts#roots()` searches
  both. Opening a card = the URL's `currentJobId` changes. Use `/jobs/search/` URLs (legacy) when possible.
- **Modal**: one `[data-test-form-element]` block per question. Text/number
  (`.artdeco-text-input--input`, numeric ids end `-numeric`, errors "Enter a whole number between 0
  and 99"), native `<select>` (`[data-test-text-entity-list-form-select]`, first option "Select an
  option"), radio fieldset (`[data-test-form-builder-radio-button-form-component]`, option text in
  `data-test-text-selectable-option__input`), checkbox fieldset, city typeahead (`input[role=combobox]`
  → `[role=listbox] [role=option]`), résumé (`.jobs-document-upload-redesign-card__container--selected`
  or `input[type=file]` — never re-upload when a card is selected). LinkedIn **pre-fills** from the
  last application; only empty questions are answered. Footer: `aria-label` "Continue to next step" /
  "Review your application" / "Submit application" (+ `data-live-test-easy-apply-*-button`);
  `#follow-company-checkbox` is pre-checked (we uncheck it). Errors:
  `.artdeco-inline-feedback--error .artdeco-inline-feedback__message`.
- **After Submit**: "Your application was sent to <co>" dialog (`button[aria-label=Dismiss]`).
  Closing an unfinished modal pops Discard (`discard_application_confirm_btn`).
- **Limits**: "You've reached today's Easy Apply limit" dialog ends the run; "applying at a fast
  pace … briefly paused" = back off. Unfocused tabs get throttled — the run tab is opened active.
- **Live-learned (2026-09-04)**: the legacy card link is a real `<a href="/jobs/view/<id>/">`, and the
  shared `dom.ts#click` dispatches a NON-cancelable event, so no preventDefault can stop it → full
  navigation → content script dead. The first card (`currentJobId` already in the URL) is never
  clicked; a tab found on `/jobs/view/…` is steered back to the persisted search page
  (`reason: 'lost'`, bounded by `MAX_RECOVERIES`). **Superseded 2026-09-14** on how the click is
  made — see the next bullet; a card is reported `linkedin-handled` BEFORE it is opened, so a
  navigation that kills the script cannot make recovery reopen the same card forever.
- **Live-learned (2026-09-14, from the on-disk log + the user's screenshots + AutoApplyMax's
  `clickJobCard`)**: (a) opening a legacy card = a NATIVE `link.click()` (cancelable, so LinkedIn's
  own handler cancels the navigation and switches the pane); our capture-phase preventDefault had
  blocked their handler too → 33/33 "card did not open". `openCard(card, attempt)` escalates:
  native click → pointer sequence on the wrapper → inner `<p>` → focus+Enter (their strategies for
  the new layout). (b) A closed/unfinished modal pops **"Save this application?" (Discard / Save)**;
  a spinner-only modal is not `modal()` → the old `discard()` skipped it and the run sat on that
  dialog for hours. `strayDialog()` + `clearStrayDialogs()` run before every card and after every
  failure. (c) **"Mark job as a top choice"** is an opt-in checkbox (3/month) that adds a REQUIRED
  20+-char message box; `answers.top_choice` defaults to unchecked; `answers.cover_letter` answers
  "Include a message…" and any "Minimum N characters" hint pads from it. (d) Indian screening
  questions: fixed/variable/total CTC (annual INR in the profile, converted to the label's unit —
  LPA / per month), notice ladders ("15 days", "1 month" → days), "located in <city>", immediate
  joiner, shifts, current company/title, GitHub, reason for change (all `answers.*`, see
  `profile.example.yaml`).
- **Records are complete and on disk immediately** (`platform/fs-config.ts#persistApplication`,
  called from `app/linkedin-run.ts#onLinkedinResult` — the background holds the folder grant):
  `applications/applications.jsonl` (every field with `source` profile|override|guessed|coerced|
  prefilled|unanswered, its intent, the options offered, any validation error; the job's own log
  lines; résumé used; location; description), `registry.jsonl`, `review.jsonl` (one line per
  guessed/unanswered/coerced/no-intent question), `captures/<date>_<jobId>_<status>.html` (the
  modal + dialogs as HTML — a real fixture) and `.jpg` (screenshot, needs the optional `<all_urls>`
  grant the popup asks for), `log-<date>.txt` (the complete debug log). Read them with `node debug/outcomes.mjs` (`--review` = the questions that need a profile
  answer, `--job <id>` = one record with its log, `--fields`). The LevelDB reader is a lossy fallback.
- **Storage budget**: `chrome.storage.local` is 10 MB (no `unlimitedStorage`) and the records, the
  debug log and the pending-log list share it. Bounds: the log keeps 1000 lines of ≤1.2 KB (×2 for
  the pending list), a record keeps its log lines only when it is parked/failed (30 lines), and a
  quota error sheds the log from all but the newest 60 records and retries. The on-disk files are
  the complete history — never widen these caps instead of reading `log-<date>.txt`.
- Popup "Stop run" shows whenever `linkedin_run` exists (the same check "press Stop first" uses);
  the watchdog's dead-run clock (`lastProgressAt`) is no longer reset by its own reloads.
- **Other LinkedIn bots must be OFF**: AutoApplyMax (`*.linkedin.com/jobs/*`) and LinkedIn
  AutoApplier (`www.linkedin.com/*`) inject into the same pages and click the same controls.
  `ats/linkedin.ts#conflictingExtensions` detects them by the UI they inject (`aam-*` / `eam-*`
  badges, `data-eam-extension`) and `#loggedOut` detects the guest wall; both are reported as
  `linkedin-warning` and kept on `linkedin_run.warnings` for the UI to show.
- **Dry run from the UI**: `runLinkedin` takes `overrides: { autoSubmit?, maxPerRun? }` so a
  "fill one job and park" run needs no profile.yaml edit.
- Pipeline: `app/linkedin-run.ts` (background) persists the run (`linkedin_run`), pages
  `start=0,25,…` of each `profile.linkedin.search_urls` entry with `f_AL=true` forced, re-kicks the
  content script after any reload (`tabs.onUpdated`), watchdog alarm reloads a silent page;
  `entrypoints/linkedin.content.ts` works one page: card → pane → Easy Apply → steps → Submit.
  Every attempt (applied / parked / failed) is recorded with the typed values; `auto_submit:false`
  fills through Review, parks, and halts the run with the modal open (one-job dry run).

### Greenhouse boards / Lever / Ashby ground truth (2026-09-14, from the live APIs + pages)
- **One pack = many companies.** `profile.greenhouse|lever|ashby.boards` (slug or any board URL;
  `parseBoardRef()` normalises) + `include_defaults` (curated `DEFAULT_*_BOARDS` in
  `src/sources/*.ts`, every entry validated live). Discovery walks the boards 4 at a time; a broken
  board is logged + skipped, the run is refused only when *every* board fails. `Job.company` carries
  the employer; `Application.employer` copies it (`company` stays the site id).
- **Greenhouse**: `boards-api.greenhouse.io/v1/boards/<token>/jobs` (`fixtures/greenhouse-board.json`)
  → we always open the **hosted** page `job-boards.greenhouse.io/<token>/jobs/<id>`, never the
  company's own site. It server-renders the *same* React form the Datadog embed uses (`#application-form`,
  `first_name`… react-select, EEO ids `gender`/`hispanic_ethnicity`/`veteran_status`/`disability_status`)
  — `fixtures/greenhouse-hosted-form.html` is a real capture and `ats/greenhouse.ts` fills it unchanged;
  the content script now matches all of `job-boards.greenhouse.io/*` + `boards.greenhouse.io/*`.
  Free-text `location.name` shapes: `"A; B | C"`, `"A • B"`, `"A or B (Remote)"` (`parseLocationName`).
- **Lever**: `api.lever.co/v0/postings/<site>?mode=json` (`fixtures/lever-postings.json`) → apply page
  `jobs.lever.co/<site>/<id>/apply` (`fixtures/lever-apply.html`, real). Server-rendered **plain HTML**
  (no React): `form#application-form`, `.application-question` blocks, `.application-label` (✱ =
  required), controls addressed by **`name`** (`name`, `email`, `phone`, `location` typeahead +
  hidden `selectedLocation`, `org`, `urls[LinkedIn]`, `resume` file, custom `cards[<uuid>][field0]`
  radio/checkbox/select/textarea, `eeo[*]`, optional `consent[marketing]`). `#btn-submit` runs
  **hCaptcha** (invisible; a visible challenge → park) then posts; success **navigates to
  `/thanks`** → closed port + `Site.submittedUrl` (like Amazon). "Full name" is one box →
  `identity.full_name`; `org` → `answers.current_company`.
- **Ashby**: `api.ashbyhq.com/posting-api/job-board/<org>` (`fixtures/ashby-board.json`) → apply page
  `jobs.ashbyhq.com/<org>/<id>/application` (React). The page loads its **question schema** from the
  same-origin GraphQL `api/non-user-graphql?op=ApiJobPosting` (`fixtures/ashby-form-schema.json`,
  real: `path`, `title`, `type` String/Email/Phone/Location/File/LongText/Boolean/ValueSelect/
  MultiValueSelect, `isRequired`, `selectableValues`) — the content script fetches it as the oracle.
  DOM (from Ashby's bundle, stable published class names): each field in `[data-field-path=<path>]`,
  `.ashby-application-form-input-text input`, `-textarea textarea`, `-yesno [data-option=yes|no]`
  (buttons), `-dropdown-select select` (**native**), `-radio-group-option` / `-checkbox-group-option`
  (input + label), `-input-file input[type=file]`, `-autocomplete` (+ `-popup-result`),
  `-submit-button`, then `-success-container` / `-failure-container` / `-blocked-application-container`
  in place (no navigation). **Not yet a live page capture** — first real run: read the Logs page,
  fix selectors in `ats/ashby.ts`.

## Architecture — Clean Architecture, applied
Dependency direction points **inward**: outer layers depend on inner, never the reverse
(the Dependency Rule, Clean Architecture ch. 22). Inner = pure policy; outer = details.

```
INNER (pure: no chrome, no DOM, no network — unit-tested)
  src/engine/     types · matcher (question→intent) · answer-tokens · resolver ·
                  select-jobs · stats
  src/config/     schema.ts (zod) — validates profile.yaml at the boundary
APPLICATION (orchestration; depends on ports, not details)
  src/app/        runner.ts (the use case) + ports.ts (RunPorts interface + chrome wiring) ·
                  instahyre-run.ts · linkedin-run.ts (in-page packs: tab, paging, recovery, records)
ADAPTERS (details, behind interfaces)
  src/sources/    where jobs come from — typesense.ts · amazon-jobs.ts
  src/ats/        how a form is filled — greenhouse.ts · amazon.ts · instahyre.ts · linkedin.ts (+ dom.ts)
  src/sites/      a company = source + ATS — site.ts (interface), datadog.ts, amazon.ts, index.ts
  src/platform/   side effects, isolated — worker-window · gmail-otp · fs-config ·
                  messaging · serialized-file · store (chrome.storage repo) · schedule (daily alarm)
MAIN (dirtiest; wires everything)
  src/entrypoints/  background.ts (assembles ports → runner; daily alarm) · greenhouse.content.ts ·
                    amazon.content.ts · instahyre.content.ts · linkedin.content.ts · gmail.content.ts · popup/
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
6b. **Some answers are never invented.** `on_unknown: guess` covers the obvious (decline → own
   country → No → a binary's other side). It must never (a) accept a legal commitment —
   `engine/resolver.ts#isConsequential` parks arbitration / waiver / class-action / non-compete /
   NDA questions, including a *required* checkbox, (b) state compensation or an employer the
   profile does not hold, (c) answer a salary box in a currency the profile's figures are not in
   (`labelCurrency` vs `profileCurrency`), (d) pick `options[0]` on a list longer than two, which
   asserts the strongest claim on a ladder ("Native or bilingual", "10+ years"), or (e) round years
   UP. A parked job names the profile key to add, and the question lands in `review.jsonl`.
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
  OTP read), not `*://*`. The one exception is **optional**: `optional_host_permissions: ['<all_urls>']`,
  requested by the popup when a LinkedIn run starts, because `chrome.tabs.captureVisibleTab` refuses
  plain host permissions (0 of 312 records ever got a screenshot before). Declining only loses the
  screenshots; the HTML capture, fields and log are written regardless.
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
- **Any Greenhouse / Lever / Ashby company**: no code — add its slug or URL to
  `profile.greenhouse|lever|ashby.boards` (or the dashboard). Only build a dedicated pack when a
  company needs its own discovery (Datadog's Typesense) or its own ATS.
- **New single-company Greenhouse pack** (own discovery): add `src/sources/<co>.ts` + `src/sites/<co>.ts`
  (`{ id, label, ats:'greenhouse', discover }`) + one line in `src/sites/index.ts`. The popup button
  and pipeline light up automatically.
- **New hosted-ATS pack (the Lever/Ashby shape)**: `src/sources/<ats>.ts` (public JSON board +
  `parseBoardRef` + `DEFAULT_<ATS>_BOARDS`), `src/ats/<ats>.ts` (pure DOM: `extract`, `optionsFor`,
  `fill`, `submitButton`, `confirmed`…), `src/entrypoints/<ats>.content.ts` (ping/apply contract),
  `src/sites/<ats>.ts` with a new `Site.ats` value, `BoardListSchema` key in `config/schema.ts`,
  host + content-script matches in `wxt.config.ts`. Submit-by-navigation → `Site.submittedUrl`.
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
- **In-page ATS with a form (LinkedIn Easy Apply)**: same in-page pattern, but the popup loads the
  profile + résumé (FS gesture) and sends them in `runLinkedin`; the content script answers the modal
  through the shared engine (`withIntent` → `resolve` → `guessAnswer`) and reports every attempt;
  `app/linkedin-run.ts` owns paging + recovery. Profile: `linkedin.search_urls` (+ `identity.city`,
  the `answers.*` LinkedIn screening keys in `profile.example.yaml`). Daily runs work via the same
  `platform/schedule.ts` toggle (`siteId: 'linkedin'`).
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
  queue. Every run also excludes the registry's job ids, so accounts never repeat a job.
  **Auto-login** (opt-in): with `profile/accounts.yaml` (git-ignored; a temporary password shared by
  every login) the rotation logs the next account in itself — `ats/passport.ts` +
  `entrypoints/passport.content.ts` drive passport.amazon.jobs (ids from its bundle:
  `#preLoginEmailField` → `#loginFormPasswordInputField` → `#verificationFormCodeInputField`), the
  emailed 6-digit code is read from the connected Gmail via `gmail-otp.getLoginCode(account)`
  (`to:<account>` — forward each account's mail to the connected Gmail once), and an AWS WAF
  captcha (`#captcha-widget`) or any error falls back to the pause + Resume flow. Credentials live in
  `run_state` (chrome.storage.local) only for the run. Seed a registry: `node debug/export.mjs --account <email>`.

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
