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

- **Résumé tailoring** — `src/resume/` (pure: tex parser, keyword vocabulary derived from the user's
  own skills lines, variant scoring, skills-line rewrite) + `scripts/tailor-resume.ts` CLI
  (`npm run tailor`, optional pdflatex compile + page count, `--json`). Tested against
  `fixtures/resume/*.tex` and the real Typesense JD text; verified on the owner's five real variants
  (correct variant picked, one-page PDFs). Not yet wired into the extension: the Typesense doc already
  carries `description`, so per-job tailoring inside the apply run is the natural next step.

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
4. **Second site pack** (e.g. a Greenhouse-native company) to prove the abstraction; then a second
   ATS (Lever).
5. **Scheduling** (`chrome.alarms`) for hands-off runs — add the permission back when implemented.
6. **Popup "needs review" panel**: list parked jobs with links (data already in `platform/store`).

## Known risks / watch-list
- Worker-window throttling if minimized (must stay visible-unfocused).
- OTP email has no job title → sequential processing is load-bearing, don't parallelize.
- react-select option text matching is fuzzy (`includes`) — verify on live multi-city dropdowns.
- Typesense public key/endpoint could change; it's captured in `sources/typesense.ts`.
