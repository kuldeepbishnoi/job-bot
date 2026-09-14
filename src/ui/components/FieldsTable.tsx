import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Pill, type Tone } from './common';
import { href } from '../router';
import { fixHref, parseField, type FieldSource, type ParsedField, type RichField } from '../app-view';

// Every question the form asked, with where the answer came from. The point of this table is that
// a weak answer is *visible*: guessed / unanswered / coerced rows are tinted, and each one carries a
// link to the profile page that would make the next run answer it properly.

const SOURCE_TONE: Record<FieldSource, Tone> = {
  profile: 'info',
  override: 'info',
  derived: 'info',
  prefilled: 'idle',
  coerced: 'warn',
  guessed: 'warn',
  unanswered: 'err',
};

const WEAK: ReadonlySet<FieldSource> = new Set<FieldSource>(['guessed', 'unanswered', 'coerced']);

function needsAttention(f: ParsedField): boolean {
  return !!f.error || (!!f.source && WEAK.has(f.source));
}

/** Options are the whole story when an answer looks wrong ("was 'Yes' even offered?") — but there
 *  can be 200 of them, so they stay one chip until asked for. */
function Options({ options }: { options: readonly string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return <span class="muted tiny">—</span>;
  if (!open) {
    return (
      <button class="link tiny" onClick={() => setOpen(true)}>
        {options.length} option{options.length === 1 ? '' : 's'}
      </button>
    );
  }
  return (
    <div class="chips">
      {options.map((o, i) => (
        <span key={`${o}-${i}`} class="chip">
          {o}
        </span>
      ))}
      <button class="link tiny" onClick={() => setOpen(false)}>
        hide
      </button>
    </div>
  );
}

export function FieldsTable({ fields, showFix = true }: { fields: readonly RichField[]; showFix?: boolean }): JSX.Element {
  const rows = fields.map(parseField);
  if (rows.length === 0) {
    return <p class="muted small">No field data was recorded for this attempt.</p>;
  }
  const weak = rows.filter(needsAttention).length;
  return (
    <>
      {weak > 0 && (
        <p class="small muted" style={{ marginBottom: 8 }}>
          {weak} of {rows.length} answers need a look — highlighted below.
        </p>
      )}
      <div class="scroll-x">
        <table class="fields">
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th>Question</th>
              <th style={{ width: 74 }}>Kind</th>
              <th style={{ width: 50 }}>Req</th>
              <th style={{ width: 130 }}>Intent</th>
              <th>Answer</th>
              <th style={{ width: 92 }}>Source</th>
              <th style={{ width: 110 }}>Options</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={`${f.id}-${i}`} class={needsAttention(f) ? 'hl' : ''}>
                <td class="muted tiny">{i + 1}</td>
                <td>
                  <div>{f.label || <span class="muted">(no label)</span>}</div>
                  <div class="muted tiny mono ellipsis" title={f.id}>
                    {f.id}
                  </div>
                  {f.error && <div class="tiny err-text">⚠ {f.error}</div>}
                </td>
                <td class="muted tiny">{f.kind ?? '—'}</td>
                <td class="tiny">{f.required === undefined ? '—' : f.required ? 'yes' : 'no'}</td>
                <td class="muted tiny mono ellipsis" title={f.intent ?? ''}>
                  {f.intent ?? '—'}
                </td>
                <td>
                  {f.value ? <span class="mono">{f.value}</span> : <span class="muted">(blank)</span>}
                  {showFix && needsAttention(f) && (
                    <>
                      {' '}
                      <a class="tiny" href={href(fixHref(f).path, fixHref(f).query)}>
                        Fix in Profile →
                      </a>
                    </>
                  )}
                </td>
                <td>
                  {f.source ? (
                    <Pill tone={SOURCE_TONE[f.source]} title={f.sourceNote ?? f.source}>
                      {f.source}
                    </Pill>
                  ) : (
                    <span class="muted tiny">—</span>
                  )}
                </td>
                <td>
                  <Options options={f.options ?? []} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
