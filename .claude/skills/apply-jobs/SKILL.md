---
name: apply-jobs
description: Apply to every relevant job on the careers pages listed in profile/profile.yaml using the JobBot extension — builds a missing site pack first (site-pack skill), runs the pack, reads outcomes from disk with few tokens, and fixes parks. Use when the user says "apply to jobs", "run the bot", or adds a careers URL.
---

# apply-jobs — one file in, applications out

Everything the user maintains lives in **one folder**: `profile/` (git-ignored, personal).
- `profile/profile.yaml` — identity, résumé path, `want` filters, answers/policy, and a `careers:`
  list of URLs (search pages with filters applied, or plain careers pages).
- `profile/resume/<file>.pdf` — the résumé `profile.yaml` points at.

## Steps (keep tokens low: never cat logs or fixtures; use the scripts)
1. **Read the careers list** from `profile/profile.yaml` (`careers:`; also `amazon.search_url`).
   Map each URL's host to a site pack in `src/sites/` (amazon.jobs → amazon, careers.datadoghq.com →
   datadog) or an in-page pack (instahyre.com). **Unknown host → run the `site-pack` skill first**,
   then come back here.
2. **Preflight (one command each, read only the last lines):**
   - `npm run compile && npm test` in the worktree.
   - Validate the profile + selection count:
     `npx tsx -e 'import{readFileSync}from"node:fs";import{parse}from"yaml";import{parseProfile}from"./src/config/schema";console.log(Object.keys(parseProfile(parse(readFileSync("<repo>/profile/profile.yaml","utf8"))).answers).length,"answers ok")'`
     and the fixture selection test in `tests/amazon-jobs.test.ts` (a 0-job queue means `want`
     filters are wrong: titles, `seniority: []`, cities).
   - `npm run install:chrome` → the user reloads JobBot in `chrome://extensions` (loaded from
     `~/.jobbot/extension`).
3. **Run.** For each site with a pack: if the Chrome MCP responds, open
   `chrome-extension://<id>/popup.html` in a tab and click "Apply for <Site>"; otherwise tell the
   user the exact click (one line). First run of a new site: `max_per_run: 1`, `auto_submit: false`.
4. **Monitor from disk, not from the browser:** `node debug/outcomes.mjs` (today's jobs, status,
   note; `--log 20` for the tail, `--job <id>` for one job). Report counts + every non-applied note.
5. **Fix parks by category, not by job:** an unmatched label → add an intent rule + profile
   answer + test; a selector/timing symptom → fix the adapter per the `site-pack` skill's rules;
   a policy gap → agree with the user (`on_unknown: guess`, `MAX`, `DECLINE`).
6. **Scale:** `auto_submit: true`, `max_per_run: 10–15`, verify `result=success` outcomes and the
   Applications page; then drop the cap and tick "Run <Site> daily" in the popup.

## Done when
- `node debug/outcomes.mjs` shows the batch as `applied` with `result=success` notes and no
  unexplained parks; the user has seen the Applications field table for at least one job.
