// Full-page viewer for the persistent debug log (platform/debug-log.ts). Newest first, live.
const KEY = 'debug_log';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let all: string[] = [];

async function load(): Promise<void> {
  const got = await chrome.storage.local.get(KEY);
  all = (got[KEY] as string[] | undefined) ?? [];
  render();
}

function render(): void {
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
$('copy').addEventListener('click', () => void navigator.clipboard.writeText(all.join('\n')));
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(KEY);
  await load();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes[KEY]) void load();
});
void load();
