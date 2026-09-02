// Full-page viewer for the persistent debug log (platform/debug-log.ts). Newest first, live.
const KEY = 'debug_log';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let all: string[] = [];
let view: 'log' | 'apps' = 'log';
interface AppRec { company: string; jobId: string; title: string; url: string; date: string; status: string; note?: string; fields?: { id: string; label: string; value: string }[] }
let apps: AppRec[] = [];

async function load(): Promise<void> {
  const got = await chrome.storage.local.get([KEY, 'applications']);
  all = (got[KEY] as string[] | undefined) ?? [];
  apps = (got['applications'] as AppRec[] | undefined) ?? [];
  render();
}

function renderApps(): void {
  const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const host = $('lines');
  host.innerHTML = '';
  const rows = [...apps].reverse().filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q));
  if (rows.length === 0) {
    host.innerHTML = '<div class="empty">No applications' + (q ? ' match.' : ' yet.') + '</div>';
    return;
  }
  for (const a of rows) {
    const card = document.createElement('div');
    card.className = 'app';
    const h = document.createElement('h3');
    const link = document.createElement('a');
    link.href = a.url; link.target = '_blank'; link.textContent = a.title; link.style.color = 'inherit';
    h.append(link, document.createTextNode(` · ${a.jobId}`));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const st = document.createElement('span'); st.className = `st-${a.status}`; st.textContent = a.status.toUpperCase();
    meta.append(st, document.createTextNode(` · ${a.company} · ${a.date}${a.note ? ' · ' + a.note : ''}`));
    card.append(h, meta);
    if (a.fields?.length) {
      const t = document.createElement('table');
      for (const f of a.fields) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = f.label;
        const td2 = document.createElement('td'); td2.textContent = f.value;
        if (/\(guessed/.test(f.value)) td2.className = 'guess';
        else if (/\(pre-filled\)/.test(f.value)) td2.className = 'pre';
        tr.append(td1, td2); t.appendChild(tr);
      }
      card.appendChild(t);
    } else {
      const none = document.createElement('div'); none.className = 'meta'; none.textContent = '(no field data recorded)'; card.appendChild(none);
    }
    host.appendChild(card);
  }
}

function render(): void {
  $('tab-log').className = view === 'log' ? 'on' : 'ghost';
  $('tab-apps').className = view === 'apps' ? 'on' : 'ghost';
  if (view === 'apps') return renderApps();
  const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
  const host = $('lines');
  const rows = [...all].reverse().filter((l) => !q || l.toLowerCase().includes(q));
  host.innerHTML = '';
  if (rows.length === 0) {
    host.innerHTML = '<div class="empty">No log lines' + (q ? ' match.' : ' yet.') + '</div>';
    return;
  }
  for (const line of rows) {
    const div = document.createElement('div');
    const cls = /FAILED|error|timed out|stalled/i.test(line) ? 'err' : /^\S+ outcome/.test(line) ? 'out' : /^\S+ popup/.test(line) ? 'popup' : '';
    div.className = `line ${cls}`;
    const sp = line.indexOf(' ');
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = line.slice(0, sp).replace('T', ' ').replace(/\.\d+Z$/, '') + ' ';
    div.append(t, document.createTextNode(line.slice(sp + 1)));
    host.appendChild(div);
  }
}

$('filter').addEventListener('input', render);
$('tab-log').addEventListener('click', () => { view = 'log'; render(); });
$('tab-apps').addEventListener('click', () => { view = 'apps'; render(); });
$('copy').addEventListener('click', () => void navigator.clipboard.writeText(all.join('\n')));
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(KEY);
  await load();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes[KEY] || changes['applications']) void load();
});
if (location.hash === '#apps') view = 'apps';
void load();
