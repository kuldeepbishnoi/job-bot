import { signal } from '@preact/signals';

// Hash routing — an extension page has no server, so `#/apps/123` is the whole router.
// A route is the hash split into segments + a query string: `#/apps/123?status=parked`.

export interface Route {
  readonly path: string; // "/apps/123"
  readonly segments: readonly string[]; // ["apps", "123"]
  readonly query: Readonly<Record<string, string>>;
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', qs = ''] = raw.split('?');
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  return { path, segments: path.split('/').filter(Boolean), query };
}

export const route = signal<Route>(parse(location.hash));

addEventListener('hashchange', () => {
  route.value = parse(location.hash);
});

/** Navigate. Pass a full path ("/apps") with optional query object. */
export function go(path: string, query?: Record<string, string | undefined>): void {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '') as [string, string][];
  const qs = entries.length ? `?${new URLSearchParams(entries)}` : '';
  location.hash = `#${path}${qs}`;
}

/** href for an <a> — keeps middle-click / copy-link working, unlike an onClick handler. */
export function href(path: string, query?: Record<string, string | undefined>): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '') as [string, string][];
  const qs = entries.length ? `?${new URLSearchParams(entries)}` : '';
  return `#${path}${qs}`;
}

/** Replace the query of the current route without adding a history entry per keystroke. */
export function setQuery(patch: Record<string, string | undefined>): void {
  const next = { ...route.value.query, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
  const qs = Object.keys(next).length ? `?${new URLSearchParams(next as Record<string, string>)}` : '';
  history.replaceState(null, '', `#${route.value.path}${qs}`);
  route.value = parse(`#${route.value.path}${qs}`);
}
