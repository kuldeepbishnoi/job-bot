import type { JSX } from 'preact';
import { applications } from '../store';
import { go, route, setQuery } from '../router';
import { Card, Empty, SearchInput, download } from '../components/common';
import { AppTable } from '../components/AppTable';
import { AppDetail } from '../components/AppDetail';
import { WarningsBanner } from '../components/WarningsBanner';
import { facets, filterApps, keyOf, newestFirst, type AppFilter, type RichApp } from '../app-view';

// Every application ever recorded, filterable. Filters live in the URL (`setQuery`), so a view like
// "Datadog · parked · has guessed" is a link you can paste into a note and come back to.

const STATUSES = ['applied', 'parked', 'failed'] as const;
const FLAGS = [
  { id: 'guessed', label: 'has guessed' },
  { id: 'unanswered', label: 'has unanswered' },
  { id: 'errors', label: 'has field errors' },
  { id: 'captures', label: 'has captures' },
] as const;

function filterFromQuery(q: Readonly<Record<string, string>>): AppFilter {
  const flag = q['flag'];
  return {
    ...(q['site'] ? { site: q['site'] } : {}),
    ...(q['status'] ? { status: q['status'] } : {}),
    ...(q['account'] ? { account: q['account'] } : {}),
    ...(q['from'] ? { from: q['from'] } : {}),
    ...(q['to'] ? { to: q['to'] } : {}),
    ...(q['q'] ? { q: q['q'] } : {}),
    ...(flag === 'guessed' || flag === 'unanswered' || flag === 'errors' || flag === 'captures' ? { flag } : {}),
  };
}

export function Applications(): JSX.Element {
  const query = route.value.query;
  const all = newestFirst(applications.value as RichApp[]);
  const filter = filterFromQuery(query);
  const rows = filterApps(all, filter);
  const { sites, accounts } = facets(all);

  const selectedKey = route.value.segments[1] ? decodeURIComponent(route.value.segments[1]) : undefined;
  const selected = selectedKey ? rows.find((a) => keyOf(a) === selectedKey) ?? all.find((a) => keyOf(a) === selectedKey) : undefined;

  const open = (a: RichApp): void => go(`/apps/${encodeURIComponent(keyOf(a))}`, query);
  const close = (): void => go('/apps', query);
  const active = Object.keys(filter).length > 0;

  const list = (
    <>
    <WarningsBanner />
    <Card
      title={`Applications (${rows.length}${rows.length === all.length ? '' : ` of ${all.length}`})`}
      right={
        <>
          {active && (
            <button
              class="sm ghost"
              onClick={() => setQuery({ site: '', status: '', account: '', from: '', to: '', q: '', flag: '' })}
            >
              Clear filters
            </button>
          )}
          <button
            class="sm ghost"
            disabled={rows.length === 0}
            onClick={() => download('applications.json', JSON.stringify(rows, null, 2))}
          >
            Export
          </button>
        </>
      }
    >
      <div class="filters">
        <SearchInput value={query['q'] ?? ''} placeholder="Search title, company, note, answers…" onInput={(v) => setQuery({ q: v })} />
        <select value={query['site'] ?? ''} onChange={(e) => setQuery({ site: (e.target as HTMLSelectElement).value })}>
          <option value="">Every site</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={query['status'] ?? ''} onChange={(e) => setQuery({ status: (e.target as HTMLSelectElement).value })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={query['account'] ?? ''} onChange={(e) => setQuery({ account: (e.target as HTMLSelectElement).value })}>
          <option value="">Any account</option>
          {accounts.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input type="date" title="from" value={query['from'] ?? ''} onChange={(e) => setQuery({ from: (e.target as HTMLInputElement).value })} />
        <input type="date" title="to" value={query['to'] ?? ''} onChange={(e) => setQuery({ to: (e.target as HTMLInputElement).value })} />
        <div class="row wrap" style={{ gridColumn: '1 / -1' }}>
          {FLAGS.map((f) => (
            <button
              key={f.id}
              class={`sm ${query['flag'] === f.id ? '' : 'ghost'}`}
              onClick={() => setQuery({ flag: query['flag'] === f.id ? '' : f.id })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty title={all.length === 0 ? 'No applications recorded yet' : 'Nothing matches these filters'}>
          {all.length > 0 && <p class="small">Clear a filter, or widen the date range.</p>}
        </Empty>
      ) : (
        <AppTable apps={rows} selectedKey={selectedKey} onSelect={open} />
      )}
    </Card>
    </>
  );

  if (!selected) return <div class="col">{list}</div>;
  return (
    <div class="with-drawer">
      {list}
      <AppDetail app={selected} onClose={close} />
    </div>
  );
}
