import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

// WXT auto-generates the MV3 manifest from src/entrypoints/*.
// srcDir: 'src' makes WXT's built-in "@" alias point at src/, matching tsconfig + vitest.
//
// Gmail OAuth is opt-in via env so no client_id/key is committed and the default build stays clean.
// Supply them either inline (`GMAIL_OAUTH_CLIENT_ID=<id> EXTENSION_KEY=<key> npm run build`) or via
// a git-ignored `.env` (loaded below — WXT doesn't inject it into the config context). Without them,
// `oauth2` is absent → chrome.identity fails gracefully → getOtp falls back to the open-Gmail-tab
// scrape. See docs/gmail-oauth.md for the one-time Google Cloud setup.
try {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    const key = m?.[1];
    if (key && !(key in process.env)) process.env[key] = m?.[2] ?? '';
  }
} catch {
  /* no .env — use inline env vars, or fall back to tab-scrape */
}

const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const KEY = process.env.EXTENSION_KEY;
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'JobBot',
    description: 'Auto-apply to jobs. Datadog today; more companies later.',
    // Least privilege: only what the code actually uses.
    // storage = applications/stats + run state; tabs = drive the worker tab + find Gmail;
    // alarms = step the queue across service-worker restarts; identity = Gmail API OAuth for the OTP.
    permissions: ['storage', 'tabs', 'alarms', 'identity'],
    // host_permissions gate content-script injection, discovery, and the Gmail API fetch.
    host_permissions: [
      'https://careers.datadoghq.com/*',
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://gk6e3zbyuntvc5dap.a1.typesense.net/*',
      'https://www.instahyre.com/*',
      'https://www.amazon.jobs/*',
      'https://mail.google.com/*',
      'https://gmail.googleapis.com/*',
    ],
    // Present only when configured — keeps secrets out of the repo and the default build clean.
    ...(CLIENT_ID ? { oauth2: { client_id: CLIENT_ID, scopes: GMAIL_SCOPES } } : {}),
    ...(KEY ? { key: KEY } : {}),
  },
});
