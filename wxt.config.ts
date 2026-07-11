import { defineConfig } from 'wxt';

// WXT auto-generates the MV3 manifest from src/entrypoints/*.
// srcDir: 'src' makes WXT's built-in "@" alias point at src/, matching tsconfig + vitest.
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'JobBot',
    description: 'Auto-apply to jobs. Datadog today; more companies later.',
    // Least privilege: only what the code actually uses.
    // storage = save applications/stats; tabs = drive the worker tab + find the Gmail tab.
    permissions: ['storage', 'tabs'],
    // host_permissions gate content-script injection + the discovery fetch. Kept as narrow as possible.
    host_permissions: [
      'https://careers.datadoghq.com/*',
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://gk6e3zbyuntvc5dap.a1.typesense.net/*',
      'https://mail.google.com/*',
    ],
  },
});
