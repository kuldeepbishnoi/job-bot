// What the dashboard knows about each site pack: enough to render a card, a Start button, the
// requirement chips and a live timeline — WITHOUT importing any site by name. Worker packs are
// derived from SITES (a new Greenhouse company needs zero UI code); in-page packs (no worker
// window, no discovery — they click inside the user's logged-in tab) are declared here.
import { SITES, type Site } from './index';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'url' | 'url[]' | 'boolean' | 'number' | 'string[]';
  help?: string;
  required?: boolean;
  placeholder?: string;
}

export interface SitePack {
  id: string;
  label: string;
  icon: string;
  kind: 'worker' | 'in-page';
  hosts: string[];
  /** Live timeline labels, in order. */
  steps: readonly string[];
  /** The SAME numbers the watchdogs use (app/stepper.ts, app/linkedin-run.ts) — health is derived
   *  from heartbeat age against these, never from a spinner. */
  stallMs: number;
  deadMs: number;
  needs: { resume: boolean; gmail: boolean; loggedInTab?: string; accounts: boolean };
  supports: { schedule: boolean; stop: boolean; resume: boolean; dryRun: boolean };
  /** A `profile.<key>` block the Sites page renders as a form. */
  config?: { key: 'amazon' | 'linkedin'; fields: FieldSpec[]; doc?: string };
  limits?: { perDay?: number; note?: string };
}

const MIN = 60_000;
const WORKER_STALL_MS = 6 * MIN; // stepper.ts STALL_MS
const WORKER_DEAD_MS = 2 * 60 * MIN; // stepper.ts STALE_RUN_MS
const IN_PAGE_STALL_MS = 5 * MIN; // linkedin-run.ts STALL_MS
const IN_PAGE_DEAD_MS = 40 * MIN; // linkedin-run.ts DEAD_MS

const ICONS: Record<string, string> = { datadog: '🐶', amazon: '📦' };
const HOSTS: Record<string, string[]> = {
  datadog: ['careers.datadoghq.com', 'job-boards.greenhouse.io'],
  amazon: ['www.amazon.jobs'],
};
const STEPS: Record<Site['ats'], readonly string[]> = {
  greenhouse: ['open', 'fill', 'submit', 'otp', 'confirm'],
  amazon: ['open', 'fill', 'continue', 'review', 'submit'],
};

const amazonConfig: NonNullable<SitePack['config']> = {
  key: 'amazon',
  doc: 'Apply your filters on amazon.jobs/en/search and paste the page URL — the queue is exactly what that page lists.',
  fields: [
    { key: 'search_url', label: 'Search URL', type: 'url', required: true, placeholder: 'https://www.amazon.jobs/en/search?category[]=software-development&country[]=CAN', help: 'The API only honours the country filter as normalized_country_code[]; the bot converts it.' },
    { key: 'ai_consent', label: 'Allow Amazon to use AI to recommend jobs', type: 'boolean', help: "Amazon's one-time prompt; false = decline." },
  ],
};

export function workerPack(site: Site): SitePack {
  return {
    id: site.id,
    label: site.label,
    icon: ICONS[site.id] ?? '🏢',
    kind: 'worker',
    hosts: HOSTS[site.id] ?? [],
    steps: STEPS[site.ats],
    stallMs: WORKER_STALL_MS,
    deadMs: WORKER_DEAD_MS,
    needs: { resume: true, gmail: site.ats === 'greenhouse', accounts: site.id === 'amazon' },
    supports: { schedule: true, stop: true, resume: true, dryRun: true },
    ...(site.id === 'amazon' ? { config: amazonConfig, limits: { perDay: 10, note: "Amazon's own limit page rotates accounts" } } : {}),
  };
}

const instahyre: SitePack = {
  id: 'instahyre',
  label: 'Instahyre',
  icon: '🧭',
  kind: 'in-page',
  hosts: ['www.instahyre.com'],
  steps: ['open', 'apply'],
  stallMs: IN_PAGE_STALL_MS,
  deadMs: IN_PAGE_DEAD_MS,
  needs: { resume: false, gmail: false, loggedInTab: 'https://www.instahyre.com/candidate/opportunities', accounts: false },
  supports: { schedule: false, stop: true, resume: false, dryRun: false },
};

const linkedin: SitePack = {
  id: 'linkedin',
  label: 'LinkedIn',
  icon: '💼',
  kind: 'in-page',
  hosts: ['www.linkedin.com'],
  steps: ['search', 'open', 'fill', 'submit'],
  stallMs: IN_PAGE_STALL_MS,
  deadMs: IN_PAGE_DEAD_MS,
  needs: { resume: true, gmail: false, loggedInTab: 'https://www.linkedin.com/jobs/', accounts: false },
  supports: { schedule: true, stop: true, resume: false, dryRun: true },
  config: {
    key: 'linkedin',
    doc: 'Search pages WITH your filters applied. The bot forces the Easy Apply filter and walks every page of each URL in order.',
    fields: [
      { key: 'search_urls', label: 'Search URLs', type: 'url[]', required: true, placeholder: 'https://www.linkedin.com/jobs/search/?keywords=…&location=…' },
      { key: 'filter_titles', label: 'Filter cards by want.titles', type: 'boolean', help: 'Off = every Easy Apply card the search returns.' },
      { key: 'max_per_run', label: 'Max applies per run', type: 'number', help: "LinkedIn's own daily Easy Apply limit ends a run earlier." },
    ],
  },
  limits: { note: "LinkedIn's daily Easy Apply limit ends the run; the bot detects it" },
};

export const PACKS: readonly SitePack[] = [...SITES.map(workerPack), instahyre, linkedin];

export function packById(id: string): SitePack | undefined {
  return PACKS.find((p) => p.id === id);
}
