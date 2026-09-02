import { SITES } from '@/sites';
import { stats, getProgress, needsAttention } from '@/platform/store';
import { pickProfileDir, loadProfileAndResume, hasProfileDir } from '@/platform/fs-config';
import { getToken, gmailApiAvailable } from '@/platform/gmail-api';
import { send, type Msg } from '@/platform/messaging';
import { enableDaily, disableDaily, dailySchedule } from '@/platform/schedule';
import { dlog } from '@/platform/debug-log';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderSites(): void {
  const host = $('sites');
  host.innerHTML = '';
  for (const site of SITES) {
    const btn = document.createElement('button');
    btn.className = 'apply';
    btn.textContent = `Apply for ${site.label}`;
    btn.onclick = () => startRun(site.id, btn);
    host.appendChild(btn);
    host.appendChild(dailyToggle(site.id, site.label));
  }
  // Instahyre isn't a worker-window Site: it applies in-page in the user's logged-in tab, so it
  // gets its own button + start path rather than going through the Greenhouse discover/OTP pipeline.
  const ih = document.createElement('button');
  ih.className = 'apply';
  ih.textContent = 'Apply for Instahyre';
  ih.onclick = () => startInstahyre(ih);
  host.appendChild(ih);
}

// "Run daily" — caches the profile + résumé (loaded here, where the FS-access gesture lives) and
// arms a 24h alarm the background acts on. Unchecking clears both. The cached snapshot is what
// runs: after editing profile.yaml, untick + retick to pick the change up.
function dailyToggle(siteId: string, label: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'daily';
  const box = document.createElement('input');
  box.type = 'checkbox';
  wrap.append(box, document.createTextNode(` Run ${label} daily at 9:00 (re-tick after editing profile.yaml)`));
  void dailySchedule(siteId).then((s) => (box.checked = !!s));
  box.onchange = async () => {
    try {
      if (box.checked) {
        setStatus('Reading profile…');
        const { profile, resume } = await loadProfileAndResume();
        await enableDaily(siteId, profile, resume);
        setStatus(`${label}: daily run armed ✓`);
      } else {
        await disableDaily(siteId);
        setStatus(`${label}: daily run off`);
      }
    } catch (e) {
      box.checked = !!(await dailySchedule(siteId).catch(() => null)); // show what's actually armed
      setStatus(`⚠ ${(e as Error).message}`);
    }
  };
  return wrap;
}

async function startInstahyre(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    setStatus('Starting Instahyre…');
    const res = await send<{ ok: boolean; error?: string }>({ t: 'runInstahyre' });
    if (!res?.ok) warn(res?.error ?? 'failed to start');
  } catch (e) {
    warn((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

/** Chrome can leave a declared host ungranted (e.g. after a reload that added one). Discovery then
 *  fails with an opaque fetch error, so ask here — this click is the user gesture that allows it. */
async function ensureHosts(): Promise<void> {
  const origins = chrome.runtime.getManifest().host_permissions ?? [];
  if (await chrome.permissions.contains({ origins })) return;
  if (!(await chrome.permissions.request({ origins }))) throw new Error('site access not granted (chrome://extensions → JobBot → Site access)');
}

async function startRun(siteId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    // Load the profile HERE (popup has the File System Access permission + user gesture);
    // the background service worker cannot request that permission.
    setStatus('Reading profile…');
    const { profile, resume } = await loadProfileAndResume();
    await ensureHosts();
    setStatus('Starting…');
    const res = await send<{ ok: boolean; error?: string }>({ t: 'run', siteId, profile, resume });
    if (!res?.ok) warn(res?.error ?? 'failed to start');
  } catch (e) {
    warn((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

// A warning must survive the 2s progress poll below, or the user never sees why nothing happened.
let warnUntil = 0;
function warn(text: string): void {
  dlog('popup', text); // lands in the Logs page, not Chrome's scary "Errors" badge
  warnUntil = Date.now() + 60_000;
  setStatus(`⚠ ${text}`);
}

async function refreshStats(): Promise<void> {
  const s = await stats();
  $('today').textContent = String(s.today);
  $('yesterday').textContent = String(s.yesterday);
  $('total').textContent = String(s.total);

  // Insights line: recent activity + how often an attempt actually lands an application.
  const insights = $<HTMLParagraphElement>('insights');
  if (s.attempts > 0) {
    const rate = Math.round((s.total / s.attempts) * 100);
    insights.hidden = false;
    insights.textContent = `${s.thisWeek} applied this week · ${rate}% success (${s.total}/${s.attempts})`;
  } else {
    insights.hidden = true;
  }

  const review = $<HTMLButtonElement>('review');
  const notes: string[] = [];
  if (s.needsReview > 0) notes.push(`⚠ ${s.needsReview} need review`);
  if (s.failed > 0) notes.push(`✗ ${s.failed} failed`);
  if (notes.length) {
    review.hidden = false;
    review.textContent = notes.join(' · ');
  } else {
    review.hidden = true;
    $('review-list').hidden = true;
  }
}

// Clicking the review summary toggles a list of the parked/failed jobs and WHY, so the
// reason (e.g. "No answer for required: …") is visible instead of just a count.
async function renderReviewList(): Promise<void> {
  const list = $<HTMLUListElement>('review-list');
  const items = await needsAttention();
  list.innerHTML = '';
  for (const a of items) {
    const li = document.createElement('li');
    const mark = a.status === 'failed' ? '✗' : '⚠';
    li.textContent = `${mark} ${a.title} — ${a.note ?? a.status}`;
    li.title = a.note ?? a.status;
    list.appendChild(li);
  }
}

$('review').addEventListener('click', async () => {
  const list = $('review-list');
  list.hidden = !list.hidden;
  if (!list.hidden) await renderReviewList();
});

// The worker tab activating closes this popup, so live 'progress' messages are usually missed.
// Read the persisted run status on open (and while open) so there's always visibility.
const STALE_RUN_MS = 2 * 60 * 60 * 1000; // a "running" record older than this is a run that died

async function refreshProgress(): Promise<void> {
  if (Date.now() < warnUntil) return; // keep the warning readable
  const p = await getProgress();
  if (!p) return;
  const running = p.phase === 'running' && Date.now() - p.at < STALE_RUN_MS;
  $('stop').hidden = !running;
  if (running) setStatus(`Applying ${Math.min(p.done + 1, p.total)}/${p.total} · ${p.current}`);
  else if (p.phase === 'running') setStatus(`Last run stopped unexpectedly at ${p.done}/${p.total} · ${p.current}`);
  else setStatus(`Run finished · ${p.total} processed`);
}

$('stop').addEventListener('click', async () => {
  const res = await send<{ ok: boolean; error?: string }>({ t: 'stop' }).catch((e: Error) => ({ ok: false, error: e.message }));
  setStatus(res.ok ? 'Run stopped.' : `⚠ ${res.error}`);
  $('stop').hidden = true;
});

function setStatus(text: string): void {
  $('status').textContent = text;
}

// Live progress from the background run.
chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.t === 'progress') setStatus(`${msg.done}/${msg.total} · ${msg.current}`);
  if (msg.t === 'runDone') {
    setStatus('Done.');
    refreshStats();
  }
});

$('logs').addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('/logs.html') }));
$('apps').addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('/logs.html#apps') }));

const pick = $('pick');
pick.addEventListener('click', async () => {
  try {
    await pickProfileDir();
    reflectLinked(true);
  } catch (e) {
    setStatus(`⚠ ${(e as Error).message}`);
  }
});

// Show whether a folder is already linked so it doesn't look "unselected" on reopen.
function reflectLinked(linked: boolean): void {
  pick.textContent = linked ? 'Change profile folder…' : 'Choose profile folder…';
  if (linked) setStatus('Profile folder linked ✓');
}

// Connect Gmail so the OTP is read via the Gmail API (no need to keep mail.google.com open).
// The interactive consent must run on this user gesture; the background then reuses the token.
const gmail = $('gmail');
gmail.addEventListener('click', async () => {
  if (!gmailApiAvailable()) {
    setStatus('⚠ Gmail OAuth not configured (see docs/gmail-oauth.md)');
    return;
  }
  const token = await getToken(true);
  reflectGmail(!!token);
  setStatus(token ? 'Gmail connected ✓' : '⚠ Gmail not connected');
});

function reflectGmail(connected: boolean): void {
  gmail.hidden = !gmailApiAvailable();
  gmail.textContent = connected ? 'Gmail connected ✓' : 'Connect Gmail…';
}

async function init(): Promise<void> {
  renderSites();
  await refreshStats();
  reflectLinked(await hasProfileDir());
  reflectGmail(!!(await getToken(false))); // silent check: already connected?
  await refreshProgress(); // after reflectLinked so an active run's status line wins
  // Poll while the popup happens to stay open, so counts + status stay live.
  setInterval(() => {
    void refreshStats();
    void refreshProgress();
  }, 2000);
}

void init();
