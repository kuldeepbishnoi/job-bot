# JobBot

A Chrome extension that auto-applies to jobs from inside your real browser. **Datadog** ships
built-in; adding another company later is one small file. You watch Netflix, it applies.

Why an extension (not an API bot): the real browser mints the reCAPTCHA token, carries your
session/fingerprint, and uploads the resume natively — so you don't fight the anti-bot stack.

## How it works

```
pick "Apply for Datadog" (popup)
  → discover every job (Typesense)  → keep the ones you want (title/location/seniority)
  → a background worker window applies them one at a time, while your main window keeps focus
      extract form fields → resolve answers → fill → submit
      → Greenhouse emails an 8-char code → read it from your open Gmail → enter it
      → auto_submit? submit : park for your approval
  → dashboard counts: Today · Yesterday · Total
```

## Architecture

```
entrypoints/           extension surfaces (WXT builds the manifest)
  background.ts          orchestrator — owns the run
  greenhouse.content.ts  runs in the GH iframe: extract → fill → submit → OTP
  gmail.content.ts       runs in your Gmail tab: read the code on request
  popup/                 company buttons + day-wise stats
src/
  engine/    pure core — types, matcher (question→intent), resolver, select-jobs, runner, store
  sources/   where jobs come from — typesense.ts (Datadog)
  ats/       how a form is filled — greenhouse.ts (+ dom.ts helpers)
  sites/     a company = source + ATS — datadog.ts
  platform/  side effects, isolated — worker-window, gmail-otp, fs-config, messaging
profile/     YOUR data — profile.yaml + resume/  (git-ignored)
fixtures/    real captured data for offline tests (Typesense response, GH form HTML)
```

Design rules: `engine/` and `sources/`/`ats/` pure logic is unit-tested with no browser;
every `chrome.*` / network effect lives in `platform/`; config is zod-validated at the edge.

## Setup

1. `npm install`
2. `cp profile/profile.example.yaml profile/profile.yaml`, edit it, drop your PDF in `profile/resume/`.
3. `npm run dev` → loads an unpacked dev extension in Chrome.
4. In the popup: **Choose profile folder…** → pick the `profile/` folder (once).
5. Keep a **Gmail tab open** (v1 reads the code from it), then click **Apply for Datadog**.

`auto_submit: false` (default) fills + enters the code, then parks each job for you to click Submit.
Set `true` for hands-free.

## Test

```
npm test          # unit tests against the real fixtures
npm run compile   # typecheck
```

## Roadmap

- Gmail API read-only (drop the "keep Gmail open" requirement).
- More site packs: Netflix, Alibaba (each = a `sources/*` + a `sites/*` entry).
- More ATS adapters: Lever, Workday.
- Playwright e2e that fills the saved form and stops before submit.

## Note

Personal automation tool. Applies as **you**, from **your** browser, with **your** approval by
default. Respect each site's terms.
