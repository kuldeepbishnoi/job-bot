# CLAUDE.md — agent onboarding

Read this first. It's the contract for working in this repo. Keep it accurate when you change things.

## What this is
A Chrome MV3 extension (WXT + TypeScript) that auto-applies to jobs from the user's **real
browser**. **Datadog** is the first "site pack". The extension approach is deliberate: the real
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
  src/sources/    where jobs come from — typesense.ts
  src/ats/        how a form is filled — greenhouse.ts (+ dom.ts)
  src/sites/      a company = source + ATS — datadog.ts, index.ts (registry)
  src/platform/   side effects, isolated — worker-window · gmail-otp · fs-config ·
                  messaging · serialized-file · store (chrome.storage repo)
MAIN (dirtiest; wires everything)
  src/entrypoints/  background.ts (assembles ports → runner) · greenhouse.content.ts ·
                    gmail.content.ts · popup/
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
   raw label → `Intent` (`matcher.ts`) → value (`resolver.ts`). Same rules answer Datadog, Netflix…
6. Answer values are **typed by question shape**: `boolean` (yes/no), `string` (single choice/free
   text), `string[]` (multi), or a canonical **token** (`answer-tokens.ts`: `DECLINE`,
   `NOT_A_VETERAN`, `NO_DISABILITY`) that maps to each company's wording. No magic strings in config.
7. Locations are **derived**, never typed: `resolveLocations` picks dropdown options ∩ (job's own
   location ∪ `want.locations`). One list drives both job selection and the cities answer.
8. Apply runs **sequentially** in one worker window → only one OTP email pending at a time (the
   email names no job, so parallelism would mismatch codes). This is also politeness/rate-limiting
   (System Design Interview ch. 4 & 9): don't hammer the ATS.
9. `auto_submit:false` is the safe default — fill + enter code, then park for the user's click.

## Chrome Web Store best practices honored
(https://developer.chrome.com/docs/webstore/best-practices)
- **Least privilege**: permissions are only `storage` + `tabs`; no `scripting`/`alarms` unless code
  uses them. host_permissions are the specific hosts we touch, not `*://*`.
- **Single purpose**: apply to jobs. Nothing else.
- **No remote code**: everything is bundled by WXT; no eval, no CDN scripts.
- **Privacy**: the résumé and profile never leave the machine; applications/stats live in
  `chrome.storage.local`. Say so in any store listing; add a privacy policy before publishing.
- When adding a permission or host, justify it in the PR description.

## How to extend
- **New Greenhouse company**: add `src/sources/<co>.ts` (discovery) + `src/sites/<co>.ts`
  (`{ id, label, ats:'greenhouse', discover }`) + one line in `src/sites/index.ts`. The popup button
  and pipeline light up automatically.
- **New ATS (Lever/Workday)**: add `src/ats/<ats>.ts` with the same surface as `greenhouse.ts`
  (`extract`, `optionsFor`, `fill`, `submitButton`, `needsOtp`, `fillOtp`, `confirmed`); reference it
  from a content script matched to that host.
- **New question type**: add a rule in `engine/matcher.ts` + a default in `profile.example.yaml` + a
  case in `tests/matcher.test.ts`. New standard decline-style answer → add a token in
  `engine/answer-tokens.ts`.

## Commands
```
npm install          # once
npm run dev          # load unpacked dev extension in Chrome (HMR)
npm run build        # production build -> .output/chrome-mv3
npm test             # unit tests against fixtures (must stay green)
npm run compile      # tsc --noEmit (must stay clean)
```

## Workflow rules (from the repo owner)
- **Never push to `master`/`main` directly.** Work on a branch and open a PR; the owner + Claude
  review first. Address PR comments, then update the PR.
- Keep `npm run compile` clean and `npm test` green in every commit.
- Prefer small, single-reason changes (SRP at the commit level).

## Status & next steps
See `docs/STATUS.md`. Built + unit-tested: pure core, discovery, Greenhouse extract/fill/OTP,
ports-based orchestration, popup. **Not yet**: live end-to-end run in a real browser, Gmail API
(v1 scrapes an open Gmail tab), Playwright e2e, a second site/ATS pack.

## Gotchas
- React inputs ignore `el.value = x`; use `setReactValue` (native setter + input/change events).
- The worker window must stay **visible (unfocused)** — if minimized, `visibilityState:hidden`
  throttles timers and can hurt reCAPTCHA. Don't minimize it.
- Gmail scrape (v1) needs a Gmail tab open. `platform/gmail-otp.ts#getOtp` is the seam to swap for
  the Gmail API later — change that one file only.
