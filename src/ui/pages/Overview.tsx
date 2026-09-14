import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { LogEvent } from '@/engine/records';
import { queryEvents } from '@/platform/data/events';
import { bySite } from '@/platform/data/stats';
import { packById } from '@/sites/packs';
import { armedAlarms, backgroundAlive, gmailConnected, type Requirement } from '../facts';
import { applications, activeRuns, packs, profile, profileMeta, profileSource, resumes, storage } from '../store';
import { SiteCard, hasResume } from '../components/SiteCard';
import { Requirements } from '../components/Requirements';
import { Card, Empty } from '../components/common';
import { href } from '../router';

// The first screen answers one question: is this thing ready, and what did it do today? Every
// answer is a check we ran just now (ping, chrome.alarms.getAll, getToken(false), storage usage) —
// nothing here is inferred from "it worked last time".

const today = (): string => new Date().toISOString().slice(0, 10);
const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function Overview(): JSX.Element {
  const [facts, setFacts] = useState<Requirement[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const [problems, setProblems] = useState<LogEvent[]>([]);

  const p = profile.value;
  const res = resumes.value;
  const store = storage.value;
  const running = activeRuns.value.length;

  const check = (): void => {
    void Promise.all([backgroundAlive(), armedAlarms(), gmailConnected()]).then(([alive, alarms, gmail]) => {
      const out: Requirement[] = [];
      out.push({
        id: 'bg',
        label: 'Background',
        ok: alive,
        detail: alive ? 'answered a ping just now' : 'no answer — reload the extension',
        ...(alive ? {} : { fix: { label: 'Open extensions', action: 'openUrl' as const, arg: 'chrome://extensions' } }),
      });
      out.push({
        id: 'alarms',
        label: 'Alarms',
        // No alarm is only a problem when something is supposed to be running: alarms are what
        // drive a run across a service-worker restart.
        ok: running > 0 ? alarms.length > 0 : true,
        detail: alarms.length ? alarms.map((a) => a.name).join(', ') : running > 0 ? 'none armed — a running run will not continue' : 'none armed (nothing is running)',
      });
      out.push({
        id: 'gmail',
        label: 'Gmail',
        ok: gmail,
        detail:
          gmail === null
            ? 'OAuth not built into this build — the OTP falls back to scraping an open Gmail tab'
            : gmail
              ? 'a read-only token is cached'
              : 'not connected — the emailed code would have to be scraped from a Gmail tab',
        ...(gmail === false ? { fix: { label: 'Connect', action: 'connectGmail' as const } } : {}),
      });
      out.push({
        id: 'profile',
        label: 'Profile',
        ok: p !== null,
        detail: p
          ? profileSource.value === 'folder'
            ? `${p.identity.first_name} ${p.identity.last_name} · read from the linked profile.yaml`
            : `${p.identity.first_name} ${p.identity.last_name}${profileMeta.value ? ` · rev ${profileMeta.value.rev} (${profileMeta.value.source})` : ''}`
          : 'not set up yet — or link the folder holding profile.yaml in Settings',
        ...(p ? {} : { fix: { label: 'Set up', action: 'goto' as const, arg: '/profile/identity' } }),
      });
      const resumeOk = hasResume(p, res);
      out.push({
        id: 'resume',
        label: 'Résumé',
        ok: resumeOk,
        detail: resumeOk
          ? profileSource.value === 'folder' && !res.some((r) => r.id === p?.resume)
            ? `${p?.resume ?? ''} · from the linked folder`
            : `${res.length} uploaded · using ${p?.resume ?? ''}`
          : 'none uploaded, and profile.resume is not a file name',
        ...(resumeOk ? {} : { fix: { label: 'Upload', action: 'goto' as const, arg: '/profile/resumes' } }),
      });
      out.push({
        id: 'storage',
        label: 'Local data',
        ok: true,
        detail: `${store.events} events · ${store.captures.count} captures · ${mb(store.captures.bytes)}`,
        fix: { label: 'Manage', action: 'goto' as const, arg: '/settings' },
      });
      setFacts(out);
      setCheckedAt(Date.now());
    });
  };
  useEffect(check, [p, res, store, running]);

  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      void queryEvents({ level: 'warn', limit: 6 })
        .then((es) => alive && setProblems(es))
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const day = today();
  const funnel = bySite(applications.value, day);
  const rows = Object.entries(funnel).sort((a, b) => b[1].applied - a[1].applied);
  const totals = rows.reduce(
    (acc, [, v]) => ({ applied: acc.applied + v.applied, parked: acc.parked + v.parked, failed: acc.failed + v.failed }),
    { applied: 0, parked: 0, failed: 0 },
  );

  return (
    <>
      <div class="page-head">
        <h1>Overview</h1>
        <span class="muted small">
          {running > 0 ? (
            <>
              {running} run{running > 1 ? 's' : ''} in flight — <a href={href('/live')}>watch live</a>
            </>
          ) : (
            'nothing running'
          )}
        </span>
        <div class="right row">
          {checkedAt > 0 && <span class="tiny muted">checked {new Date(checkedAt).toLocaleTimeString()}</span>}
          <button class="sm ghost" onClick={check}>
            Re-check
          </button>
        </div>
      </div>

      <Card title="Readiness" cls="strip">
        <Requirements reqs={facts} onRecheck={check} />
      </Card>

      <h2 style={{ margin: '16px 0 8px' }}>Sites</h2>
      <div class="grid two">
        {packs.map((pack) => (
          <SiteCard key={pack.id} pack={pack} />
        ))}
      </div>

      <div class="grid two" style={{ marginTop: 16 }}>
        <Card title={`Today (${day})`} right={<span class="tiny muted">{totals.applied + totals.parked + totals.failed} attempts</span>}>
          {rows.length === 0 ? (
            <Empty title="Nothing applied today">
              <p class="small">Press Start on a site above — every attempt lands here the moment it is recorded.</p>
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Applied</th>
                  <th>Parked</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([site, v]) => (
                  <tr key={site}>
                    <td>{packById(site)?.label ?? site}</td>
                    <td style={{ color: v.applied ? 'var(--ok)' : undefined }}>{v.applied}</td>
                    <td style={{ color: v.parked ? 'var(--warn)' : undefined }}>{v.parked}</td>
                    <td style={{ color: v.failed ? 'var(--err)' : undefined }}>{v.failed}</td>
                  </tr>
                ))}
                <tr>
                  <td class="muted">all sites</td>
                  <td class="muted">{totals.applied}</td>
                  <td class="muted">{totals.parked}</td>
                  <td class="muted">{totals.failed}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Needs explaining"
          right={
            <a class="small" href={href('/logs', { level: 'warn' })}>
              All logs →
            </a>
          }
        >
          {problems.length === 0 ? (
            <Empty title="No warnings or errors logged">
              <p class="small">Nothing has gone wrong since the log was last cleared.</p>
            </Empty>
          ) : (
            <div class="col" style={{ gap: 2 }}>
              {problems.map((e) => (
                <div key={e.seq ?? `${e.ts}-${e.msg}`} class={`logline ${e.level}`}>
                  <span>{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                  <span>{e.level}</span>
                  <span class="ellipsis">{e.scope}</span>
                  <span>{e.msg}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
