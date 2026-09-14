import { Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Pill, type Tone } from './common';
import { href } from '../router';
import { FixAnswer } from './FixAnswer';
import { fixHref, parseField, type FieldSource, type ParsedField, type RichField } from '../app-view';

// Every question the form asked, with where the answer came from. The point of this table is that
// a weak answer is *visible*: guessed / unanswered / coerced rows are tinted, and each one can be
// fixed WITHOUT leaving the drawer — the control writes the same profile key the next run reads.

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

export function FieldsTable({
  fields,
  showFix = true,
  disk = false,
}: {
  fields: readonly RichField[];
  showFix?: boolean;
  /** A profile folder is linked, so an inline fix can mirror into profile.yaml too. */
  disk?: boolean;
}): JSX.Element {
  const rows = fields.map(parseField);
  const [openFix, setOpenFix] = useState<string | null>(null);
  if (rows.length === 0) {
    return <p class="muted small">No field data was recorded for this attempt.</p>;
  }
  const weak = rows.filter(needsAttention).length;
  return (
    <>
      {weak > 0 && (
        <p class="small muted" style={{ marginBottom: 8 }}>
          {weak} of {rows.length} answers need a look — highlighted below. “Fix here” writes your profile without leaving this drawer.
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
            {rows.map((f, i) => {
              const rowKey = `${f.id}-${i}`;
              const fixable = showFix && needsAttention(f);
              return (
                <Fragment key={rowKey}>
                  <tr class={needsAttention(f) ? 'hl' : ''}>
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
                      {fixable && (
                        <div class="row wrap" style={{ gap: 6, marginTop: 2 }}>
                          <button class="link tiny" onClick={() => setOpenFix(openFix === rowKey ? null : rowKey)}>
                            {openFix === rowKey ? 'close' : 'Fix here'}
                          </button>
                          <a class="tiny" href={href(fixHref(f).path, fixHref(f).query)}>
                            open in Profile →
                          </a>
                        </div>
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
                  {openFix === rowKey && (
                    <tr class="hl">
                      <td />
                      <td colSpan={7}>
                        <FixAnswer
                          label={f.label}
                          {...(f.intent ? { intent: f.intent } : {})}
                          {...(f.kind ? { kind: f.kind } : {})}
                          options={f.options ?? []}
                          {...(f.value ? { current: f.value } : {})}
                          disk={disk}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
