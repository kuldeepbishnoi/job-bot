# Status

Snapshot for the next agent/session. Update it as things land.

## Done (built + unit-tested, 28 tests green, typecheck clean, extension builds)
- **Discovery** — `sources/typesense.ts`: paginated `q:*` over the Datadog Typesense index →
  `Job[]` with parsed locations. Tested against `fixtures/typesense-response.json`.
- **Targeting** — `engine/select-jobs.ts`: filter by title include/exclude, location, seniority.
- **Question → intent** — `engine/matcher.ts`: keyword rules; tested against the real Datadog labels.
- **Answers** — `engine/resolver.ts` + `engine/answer-tokens.ts`: identity, booleans (yes/no),
  single/multi choice, canonical tokens (DECLINE / NOT_A_VETERAN / NO_DISABILITY), derived locations.
- **Greenhouse ATS** — `ats/greenhouse.ts`: `extract` (react-select/file/multiselect detection),
  `optionsFor`, `fill`, OTP detect/fill, confirmation. `extract` tested against
  `fixtures/greenhouse-form.html`.
- **Orchestration** — `app/runner.ts` (pure, ports-injected) + `app/ports.ts` (chrome wiring).
  Sequential apply, dedup vs already-applied, OTP dance, park/failed handling. Tested with fakes.
- **Persistence/stats** — `platform/store.ts` (chrome.storage repo) + `engine/stats.ts` (pure).
- **Surfaces** — `entrypoints/`: background (Main), greenhouse iframe content script, gmail content
  script, popup (company buttons + Today/Yesterday/Total + parked count + folder picker).
- **Config** — `config/schema.ts` (zod) + `profile/profile.example.yaml`. Read live from a picked
  folder via File System Access (`platform/fs-config.ts`).

## Amazon site pack (branch feat/amazon-site-pack, 2026-09-02)
- **Discovery** — `sources/amazon-jobs.ts`: the search-page URL from `profile.amazon.search_url`
  → `/en/search.json` pages (`country[]` → `normalized_country_code[]`, the param the API honours).
  Tested against `fixtures/amazon-search.json` (real page, 175 hits for the owner's filter).
- **Apply** — `ats/amazon.ts` + `entrypoints/amazon.content.ts`: form-by-form loop over Amazon's own
  React apply app (active form → fill empty questions → Continue → … → review → Submit). Question
  types, ids and markup were derived from `/api/apply/forms` + the app bundle (see CLAUDE.md
  "Amazon ground truth"); `fixtures/amazon-forms.json` is the real schema, `fixtures/amazon-apply.html`
  is generated from it. Duplicate screen → recorded as applied with a note; submit success is the
  page navigating away (`app/ports.ts#outcomeAfterPortClosed`).
- **Answers** — new intents: `years_of_experience` (number → `engine/years.ts` bucket picker),
  `skills_experience`, `degree_bachelors/masters`, Canada self-ID (`indigenous`, `visible_minority`,
  `racial_identity`, `ex_military`, `reserve_forces`, `military_spouse` → `DECLINE` = "I choose not
  to self-identify"), work-eligibility intents (commented in the example: Amazon pre-fills them).
  All in `profile.example.yaml`.
- **Daily runs** — `platform/schedule.ts` + popup "Run <site> daily at 9:00" toggle: caches
  profile + résumé (a snapshot — re-tick after editing profile.yaml), 24h alarm, background starts
  the stepper (skips if a run is active).
- **Unverified live**: the adapter has not yet driven a real apply (browser automation was
  unavailable during development). First run: watch the console (`[jobbot:amazon]`) for the form
  keys / field logs; the likeliest breakage is a selector (Continue button text, select2 change
  wiring, the modal). Everything else (API shape, ids, option keys) is from real captures.

## Code-review blockers fixed (PR #1 review round 1)
- OTP message type aligned (`getCode`) — was `otp:get`, code was never returned.
- Profile now loads in the popup and is passed to the SW (FS-access can't run in a service worker).
- Run is an alarm-driven **stepper** (`app/stepper.ts`) — survives MV3 SW termination.
- `waitForComplete` has a timeout + already-complete guard (no more queue hangs).
- Frame-readiness **ping** before `apply` (Greenhouse form is a late iframe).
- react-select: control via `closest('.select__control')` (correct field), multi-menu not toggled shut.

## Not done / next
1. **Live end-to-end verification** in a real browser on one Datadog job (the big one — no
   substitute for it). Still-unverified live assumptions: the 8-box OTP widget selectors
   (`otpBoxes` maxLength===1), the confirmation-page detector (`confirmed()` wording), and that a
   Gmail email must be **opened** for the scrape. Adjust in `ats/greenhouse.ts` / `platform/gmail-otp.ts`.
2. Remaining review items to weigh: boolean "No" substring match (`resolver.ts`), no re-scan for
   follow-up fields revealed by a select, duplicate-apply risk if `confirmed()` misfires.
2. **Gmail API (read-only)** to replace tab-scrape — swap only `platform/gmail-otp.ts#getOtp`.
3. **Playwright e2e**: load the built extension, open `fixtures/greenhouse-form.html`, assert fill,
   stop before submit.
4. ~~Second site pack~~ — Amazon (own ATS) + Instahyre (in-page) landed; next a Greenhouse-native
   company to prove the Greenhouse abstraction, then Lever.
5. ~~Scheduling~~ — daily alarm landed (`platform/schedule.ts`); per-site hour is still fixed at 9:00.
6. **Popup "needs review" panel**: list parked jobs with links (data already in `platform/store`).

## Known risks / watch-list
- Worker-window throttling if minimized (must stay visible-unfocused).
- OTP email has no job title → sequential processing is load-bearing, don't parallelize.
- react-select option text matching is fuzzy (`includes`) — verify on live multi-city dropdowns.
- Typesense public key/endpoint could change; it's captured in `sources/typesense.ts`.
