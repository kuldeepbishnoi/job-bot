import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { AnswerValue } from '@/config/schema';
import { intentMeta, type AnswerShape } from '@/engine/intent-catalog';
import { AnswerToken } from '@/engine/answer-tokens';
import { coerceAnswer, supportsMax, bareAnswerKey } from '../profile-draft';
import { answerTarget, describeSave, fieldShape, looksBooleanOptions, saveAnswer, type SaveAnswerResult } from '../profile-write';
import { Checkbox, ChipInput, NumberInput, Select, TextInput, TriState } from './SchemaForm';

// Fix an answer where you found it. The console's whole promise is that nothing sends you to a
// terminal: this control writes the profile from the review row / the field row that showed the
// problem, states the exact key it will write BEFORE you press Save, and confirms afterwards.
//
// One save clears a whole group, because the profile is keyed by intent (or by the question's exact
// text) — never by job. "This question blocked 14 jobs" is one decision, not fourteen.

export interface FixAnswerProps {
  /** The question exactly as the form asked it. */
  readonly label: string;
  readonly intent?: string;
  readonly kind?: string;
  /** What the control offered, when the record captured it — always the best choices to show. */
  readonly options?: readonly string[];
  /** What we answered last time (or blank) — shown as context, never pre-filled as a "fix". */
  readonly current?: string;
  /** How many jobs this one save unblocks. */
  readonly jobCount?: number;
  /** A profile folder is linked, so profile.yaml can be mirrored too. */
  readonly disk?: boolean;
  readonly onSaved?: (r: SaveAnswerResult) => void;
}

/** The shape a control should take here: the intent's shape, unless the options say otherwise. */
export function controlShape(props: Pick<FixAnswerProps, 'intent' | 'kind' | 'options'>): AnswerShape {
  const options = props.options ?? [];
  const shape = fieldShape({
    ...(props.intent ? { intent: props.intent } : {}),
    ...(props.kind ? { kind: props.kind } : {}),
    options,
  });
  if (shape === 'text' && looksBooleanOptions(options)) return 'boolean';
  return shape;
}

function Control({
  shape,
  options,
  intentKey,
  value,
  onChange,
}: {
  shape: AnswerShape;
  options: readonly string[];
  intentKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  const usableOptions = options.filter((o) => o.trim()).slice(0, 60);

  if (shape === 'boolean') return <TriState value={typeof value === 'boolean' ? value : undefined} onChange={(v) => onChange(v)} />;

  if (shape === 'derived') {
    return <div class="small muted">Locations are derived per job from the listing ∪ want.locations — there is nothing to set here.</div>;
  }

  if (shape === 'string[]') {
    if (usableOptions.length > 0) {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div class="chips">
          {usableOptions.map((o) => (
            <Checkbox
              key={o}
              checked={picked.includes(o)}
              onChange={(on) => onChange(on ? [...picked, o] : picked.filter((p) => p !== o))}
            >
              {o}
            </Checkbox>
          ))}
        </div>
      );
    }
    return <ChipInput value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onChange(v)} placeholder="Add an option…" />;
  }

  if (shape === 'token') {
    const tokens = intentMeta(intentKey).tokens ?? Object.values(AnswerToken);
    const current = typeof value === 'string' ? value : '';
    return (
      <Select
        value={current}
        options={[
          { value: '', label: 'Not set — the question stays parked / guessed' },
          ...tokens.map((t) => ({ value: t, label: `${t} — the canonical answer, mapped to each site's wording` })),
          ...usableOptions.map((o) => ({ value: o, label: `${o} (this form's exact wording)` })),
        ]}
        onChange={(v) => onChange(v || undefined)}
      />
    );
  }

  // A ladder ("5 to less than 8 years") is still answered with a NUMBER: the resolver picks the
  // bucket that contains it, so the offered options are reference, not choices.
  if (shape === 'number') {
    const isMax = value === 'MAX';
    return (
      <div class="col" style={{ gap: 4 }}>
        <div class="row wrap">
          <NumberInput min={0} value={isMax ? '' : (value as number | string | undefined)} placeholder="e.g. 6" onChange={(v) => onChange(v === undefined ? undefined : String(v))} />
          {supportsMax(intentKey) && (
            <Checkbox checked={isMax} onChange={(on) => onChange(on ? 'MAX' : undefined)}>
              <span title="Pick the highest range the form offers, whatever it is">always top bucket (MAX)</span>
            </Checkbox>
          )}
        </div>
        {usableOptions.length > 0 && (
          <div class="tiny muted">The form offered: {usableOptions.join(' · ')} — the number you give picks the bucket it falls in.</div>
        )}
      </div>
    );
  }

  if (usableOptions.length > 0) {
    const current = typeof value === 'string' ? value : '';
    return (
      <div class="col" style={{ gap: 6 }}>
        <Select
          value={usableOptions.includes(current) ? current : ''}
          options={[
            { value: '', label: `Not set — or type it below (${usableOptions.length} option${usableOptions.length === 1 ? '' : 's'} offered)` },
            ...usableOptions.map((o) => ({ value: o, label: o })),
          ]}
          onChange={(v) => onChange(v || undefined)}
        />
        <TextInput value={usableOptions.includes(current) ? '' : current} placeholder="…or free text / a substring of the option" onChange={(v) => onChange(v || undefined)} />
      </div>
    );
  }

  return <TextInput value={typeof value === 'string' ? value : ''} placeholder="The answer, verbatim" onChange={(v) => onChange(v || undefined)} />;
}

export function FixAnswer(props: FixAnswerProps): JSX.Element {
  const target = answerTarget({ label: props.label, ...(props.intent ? { intent: props.intent } : {}) });
  const shape = controlShape(props);
  const [value, setValue] = useState<unknown>(undefined);
  const [alsoDisk, setAlsoDisk] = useState(!!props.disk);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SaveAnswerResult | null>(null);

  const clears = props.jobCount && props.jobCount > 1 ? `Saving it once answers the question for all ${props.jobCount} jobs.` : '';

  const save = async (): Promise<void> => {
    setBusy(true);
    const coerced = coerceAnswer(shape, value) as AnswerValue | undefined;
    const res = await saveAnswer({
      label: props.label,
      ...(props.intent ? { intent: props.intent } : {}),
      value: coerced,
      alsoDisk: alsoDisk && !!props.disk,
    });
    setBusy(false);
    setDone(res);
    props.onSaved?.(res);
  };

  return (
    <div class="answer">
      <div class="answer-head">
        <label class="flabel">Answer it now</label>
        <code class="tiny muted" title={target.why}>
          {target.display}
        </code>
      </div>

      <div class="answer-body">
        <Control
          shape={shape}
          options={props.options ?? []}
          intentKey={target.sink === 'answers' ? bareAnswerKey(target.key) : target.key}
          value={value}
          onChange={(v) => {
            setValue(v);
            setDone(null);
          }}
        />
      </div>

      <div class="hint">
        Writes <b>{target.display}</b> — {target.why}. {clears}
        {props.current ? ` We answered “${props.current}” last time.` : ''}
      </div>

      <div class="row wrap" style={{ marginTop: 6 }}>
        <button class="sm primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : value === undefined ? 'Save (clears the answer)' : 'Save answer'}
        </button>
        {props.disk ? (
          <Checkbox checked={alsoDisk} onChange={setAlsoDisk}>
            <span title="Rewrites just this key; every comment and the key order in profile.yaml stay exactly as they are">
              also update profile.yaml
            </span>
          </Checkbox>
        ) : (
          <span class="tiny muted">no profile folder linked — this writes the extension's profile only</span>
        )}
      </div>

      {done && (
        <p class={`small ${done.ok ? '' : 'err-text'}`} style={{ marginTop: 6 }}>
          {describeSave(done)}
          {done.storedError && <span class="err-text"> {done.storedError}</span>}
          {done.diskError && <span class="err-text"> profile.yaml was not updated: {done.diskError}</span>}
          {done.ok && !done.diskError && ' The next run uses it.'}
        </p>
      )}
    </div>
  );
}
