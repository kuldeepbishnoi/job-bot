import { SITES } from '@/sites';
import { stats } from '@/platform/store';
import { pickProfileDir } from '@/platform/fs-config';
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
  setStatus('Starting…');
  const res = await send<{ ok: boolean; error?: string }>({ t: 'run', siteId });
  if (!res?.ok) setStatus(`⚠ ${res?.error ?? 'failed to start'}`);
  btn.disabled = false;
}

async function refreshStats(): Promise<void> {
  const s = await stats();
  $('today').textContent = String(s.today);
  $('yesterday').textContent = String(s.yesterday);
  $('total').textContent = String(s.total);
  const review = $<HTMLButtonElement>('review');
  if (s.needsReview > 0) {
    review.hidden = false;
    review.textContent = `⚠ ${s.needsReview} need review`;
  } else {
    review.hidden = true;
  }
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

$('pick').addEventListener('click', async () => {
  try {
    await pickProfileDir();
    setStatus('Profile folder linked ✓');
  } catch (e) {
    setStatus(`⚠ ${(e as Error).message}`);
  }
});

renderSites();
refreshStats();
