import type { JSX } from 'preact';
import { route, href } from './router';
import { activeRuns, reviewCount, loadError } from './store';
import { Banner } from './components/common';
import { Overview } from './pages/Overview';
import { Live } from './pages/Live';
import { Runs } from './pages/Runs';
import { Applications } from './pages/Applications';
import { Review } from './pages/Review';
import { Logs } from './pages/Logs';
import { Sites } from './pages/Sites';
import { ProfilePage } from './pages/ProfilePage';
import { Settings } from './pages/Settings';

// The console shell: a rail and one route. Every page reads signals from ui/store, so navigation
// never refetches and a run's progress keeps updating whichever page is open.

const NAV = [
  { path: '/', icon: '▤', label: 'Overview' },
  { path: '/live', icon: '◉', label: 'Live' },
  { path: '/runs', icon: '▶', label: 'Runs' },
  { path: '/apps', icon: '☰', label: 'Applications' },
  { path: '/review', icon: '⚑', label: 'Review', badge: 'review' },
  { path: '/logs', icon: '≡', label: 'Logs' },
  { path: '/sites', icon: '▦', label: 'Sites' },
  { path: '/profile', icon: '☺', label: 'Profile' },
  { path: '/settings', icon: '⚙', label: 'Settings' },
] as const;

function isActive(path: string, current: string): boolean {
  if (path === '/') return current === '/';
  return current === path || current.startsWith(`${path}/`);
}

function View(): JSX.Element {
  const seg = route.value.segments[0] ?? '';
  switch (seg) {
    case '':
      return <Overview />;
    case 'live':
      return <Live />;
    case 'runs':
      return <Runs />;
    case 'apps':
      return <Applications />;
    case 'review':
      return <Review />;
    case 'logs':
      return <Logs />;
    case 'sites':
      return <Sites />;
    case 'profile':
      return <ProfilePage />;
    case 'settings':
      return <Settings />;
    default:
      return <Overview />;
  }
}

export function App(): JSX.Element {
  const current = route.value.path;
  const live = activeRuns.value.length;
  return (
    <div class="shell">
      <nav class="rail">
        <div class="brand">
          <span class="dot" style={{ color: 'var(--accent)' }} />
          <strong>JobBot</strong>
        </div>
        {NAV.map((n) => (
          <a key={n.path} href={href(n.path)} class={isActive(n.path, current) ? 'on' : ''}>
            <span aria-hidden="true">{n.icon}</span>
            {n.label}
            {n.path === '/live' && live > 0 && <span class="badge">{live}</span>}
            {'badge' in n && reviewCount.value > 0 && <span class="badge">{reviewCount.value}</span>}
          </a>
        ))}
      </nav>
      <main class="main">
        {loadError.value && (
          <Banner tone="err">
            <div>
              <strong>Some data could not be read.</strong> {loadError.value}
            </div>
          </Banner>
        )}
        <View />
      </main>
    </div>
  );
}
