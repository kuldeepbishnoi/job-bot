import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Health, LogLevel, Run } from '@/engine/records';
import type { ApplyStatus } from '@/engine/types';
import { now } from '../store';

// Shared presentational bits. Rule for all of them: show the evidence, not a vibe — a status says
// what it counted and when it last heard from the run, never a bare spinner.

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'idle';

export function Pill({ tone, children, title }: { tone: Tone; children: ComponentChildren; title?: string }): JSX.Element {
  return (
    <span class={`pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

const HEALTH_TONE: Record<Health, Tone> = { alive: 'ok', waiting: 'info', stalled: 'warn', dead: 'err', ended: 'idle' };

/** The one place a run's state becomes words. Always paired with the heartbeat age that proves it. */
export function RunPill({ run, health }: { run: Run; health: Health }): JSX.Element {
  const label =
    health === 'alive' ? (run.phase === 'discovering' ? 'Discovering' : 'Running')
    : health === 'waiting' ? 'Waiting for you'
    : health === 'stalled' ? 'Stalled'
    : health === 'dead' ? 'Dead'
    : run.phase === 'stopped' ? 'Stopped'
    : 'Finished';
  return (
    <Pill tone={HEALTH_TONE[health]} title={run.endReason ?? run.pause?.reason ?? ''}>
      <i class={`dot${health === 'alive' ? ' pulse' : ''}`} />
      {label}
    </Pill>
  );
}

const STATUS_TONE: Record<ApplyStatus, Tone> = { applied: 'ok', parked: 'warn', failed: 'err' };
export const STATUS_MARK: Record<ApplyStatus, string> = { applied: '✓', parked: '⚠', failed: '✗' };

export function StatusPill({ status }: { status: ApplyStatus }): JSX.Element {
  return <Pill tone={STATUS_TONE[status] ?? 'idle'}>{status}</Pill>;
}

/** Relative age that re-renders on the shared 1s clock. `at` is epoch ms. */
export function Ago({ at, prefix = '' }: { at: number; prefix?: string }): JSX.Element {
  const ms = Math.max(0, now.value - at);
  return (
    <span class="muted nowrap" title={new Date(at).toLocaleString()}>
      {prefix}
      {duration(ms)} ago
    </span>
  );
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function Bar({ value, total }: { value: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div class="bar" title={`${value} of ${total}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Banner({ tone = 'warn', children }: { tone?: 'warn' | 'err'; children: ComponentChildren }): JSX.Element {
  return <div class={`banner ${tone}`}>{children}</div>;
}

export function Card({ title, right, children, cls = '' }: { title?: ComponentChildren; right?: ComponentChildren; children: ComponentChildren; cls?: string }): JSX.Element {
  return (
    <section class={`card ${cls}`}>
      {(title || right) && (
        <div class="row" style={{ marginBottom: 10 }}>
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {right && <div class="right row">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { id: T; label: ComponentChildren }[]; value: T; onChange: (t: T) => void }): JSX.Element {
  return (
    <div class="tabs">
      {tabs.map((t) => (
        <button key={t.id} class={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const LEVEL_TONE: Record<LogLevel, Tone> = { debug: 'idle', info: 'info', warn: 'warn', error: 'err' };

/** Copy-to-clipboard button that says it worked. */
export function CopyButton({ text, label = 'Copy' }: { text: string | (() => string); label?: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      class="sm ghost"
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

/** Download a blob/text as a file — the console's export buttons all go through here. */
export function download(name: string, data: string | Blob, mime = 'application/json'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Renders a Blob as an <img>, revoking the object URL on unmount (captures are 100–300 KB each). */
export function BlobImage({ blob, alt, cls = 'thumb', onClick }: { blob: Blob; alt: string; cls?: string; onClick?: () => void }): JSX.Element {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return <img src={url} alt={alt} class={cls} onClick={onClick} style={onClick ? { cursor: 'zoom-in' } : undefined} />;
}

/** Debounced text input — used by every filter bar so typing doesn't re-query per keystroke. */
export function SearchInput({ value, onInput, placeholder, ms = 200 }: { value: string; onInput: (v: string) => void; placeholder?: string; ms?: number }): JSX.Element {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setLocal(value), [value]);
  return (
    <input
      type="search"
      value={local}
      placeholder={placeholder}
      onInput={(e) => {
        const v = (e.target as HTMLInputElement).value;
        setLocal(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onInput(v), ms) as unknown as number;
      }}
    />
  );
}

/** Modal overlay for lightboxes and confirmations. Escape closes. */
export function Modal({ onClose, children, wide }: { onClose: () => void; children: ComponentChildren; wide?: boolean }): JSX.Element {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
    >
      <div class="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: wide ? '92vw' : 560, maxHeight: '92vh', overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
