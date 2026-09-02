import { SITES } from '@/sites';
import { stats, getProgress, needsAttention } from '@/platform/store';
import { pickProfileDir, loadProfileAndResume, hasProfileDir } from '@/platform/fs-config';
import { getToken, gmailApiAvailable } from '@/platform/gmail-api';
import { send, type Msg } from '@/platform/messaging';

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
  }
}

async function startRun(siteId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    // Load the profile HERE (popup has the File System Access permission + user gesture);
    // the background service worker cannot request that permission.
    setStatus('Reading profile…');
    const { profile, resume } = await loadProfileAndResume();
    setStatus('Starting…');
    const res = await send<{ ok: boolean; error?: string }>({ t: 'run', siteId, profile, resume });
    if (!res?.ok) setStatus(`⚠ ${res?.error ?? 'failed to start'}`);
  } catch (e) {
    setStatus(`⚠ ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
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
async function refreshProgress(): Promise<void> {
  const p = await getProgress();
  if (!p) return;
  if (p.phase === 'running') setStatus(`Applying ${p.done + 1}/${p.total} · ${p.current}`);
  else setStatus(`Run finished · ${p.total} processed`);
}

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
