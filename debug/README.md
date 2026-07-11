# debug/ — mitmproxy capture harness

Everything a live Greenhouse (or other ATS) form sends flows through mitmproxy so
Claude can just read `debug/captures/` instead of asking you to copy-paste HTML.

## One-time

```
brew install mitmproxy    # only if you haven't already
```

Trust the CA on macOS is skipped by launching Chrome with `--ignore-certificate-errors
--test-type` inside a scratch profile — no keychain surgery required.

## Two run modes

Pick based on what you're debugging.

### Scratch profile (default) — pure capture

Best when you just need to see the raw HTML/JSON a site serves. Doesn't touch your
real Chrome, can run alongside it.

```
npm run mitm -- <url>
# e.g.
npm run mitm -- https://careers.datadoghq.com/detail/7983548/
```

- Chrome opens with `--user-data-dir=/tmp/chrome-jobbot-mitm` (fresh every time).
- Extension is pre-loaded from `.output/chrome-mv3` (no need to `chrome://extensions`).
- Every request/response from `job-boards.greenhouse.io`, `boards.greenhouse.io`,
  `careers.datadoghq.com`, `*.a1.typesense.net`, and Gmail lands in
  `debug/captures/`, one file per response, plus `index.log` summary.
- mitmweb UI is at http://127.0.0.1:8081 if you want a live view.

### Your real Chrome profile — end-to-end apply

For actually running the extension against a form with your Gmail login, cookies, etc.

```
# 1. Quit Chrome fully (⌘Q). Verify: pgrep -f 'Google Chrome' returns nothing.
# 2. Run:
USE_MY_PROFILE=1 npm run mitm -- <url>
```

Chrome opens against `~/Library/Application Support/Google/Chrome` — your real
session, but every request funnels through mitm so we still capture the traffic.
The script refuses to launch if it detects Chrome is already running (Chrome would
silently open a new tab in the existing instance and ignore all our flags).

## Stop / reset

```
npm run mitm:stop     # kills the scratch Chrome + mitmweb
npm run mitm:reset    # clears debug/captures/
```

## What gets captured

- `<HHMMSS>-job-boards.greenhouse.io-embed_job_app.html` — the form itself.
- `<HHMMSS>-*-typesense.net-*.json` — the discovery search responses (Datadog).
- `<HHMMSS>-boards.greenhouse.io-embed_job_board_js.html` — the loader script.
- `debug/logs/mitm.log` — mitmweb stderr (empty on success).
- `debug/logs/chrome.log` — Chrome stderr.

Assets (images, fonts) are dropped by the addon so the folder stays scannable.

## The addon (`debug/mitm-capture.py`)

- `HOST_ALLOW` regex — add more hostnames when you add a new company / ATS.
- Writes both a `.html`/`.json`/`.txt` file per response and a one-line append
  to `index.log`.
- No modification of traffic — read-only capture.

## Typical debug loop

```
npm run mitm:reset
npm run mitm -- <job-url>       # let Chrome load the page, then close it
npm run mitm:stop
ls debug/captures/              # find the form file
# Read + edit code, re-run tests against the new fixture.
```

## Adding a new company

1. Capture: `npm run mitm -- <the job listing URL>`.
2. Look for `*greenhouse.io/embed/job_app*.html` (or your ATS's equivalent).
3. Save it as `fixtures/greenhouse-form-<company>.html`.
4. If field IDs differ from Datadog's fixture, either the extractor already
   handles it (label-based matcher will catch custom questions) or you need
   a company override — see `src/sites/` and `src/ats/`.
5. Add a regression test that mirrors `tests/greenhouse-extract-live.test.ts`.
