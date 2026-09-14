import type { JSX } from 'preact';
import type { IntentMeta } from '@/engine/intent-catalog';
import { AnswerToken } from '@/engine/answer-tokens';
import { answerToText, bareAnswerKey, coerceAnswer, supportsMax } from '../profile-draft';
import { ChipInput, Checkbox, NumberInput, Select, TextInput, TriState } from './SchemaForm';

// One answer, rendered by the SHAPE of the question rather than by its wording. This is the
// intent model made visible: you answer "needs sponsorship" once, and every company's phrasing of
// it gets that answer. The intent key is printed under each label so what you set here is
// traceable to what engine/matcher.ts matched.

const TOKEN_LABEL: Record<string, string> = {
  [AnswerToken.DECLINE]: 'DECLINE — prefer not to say / decline to self-identify',
  [AnswerToken.NOT_A_VETERAN]: 'NOT_A_VETERAN — I am not a protected veteran',
  [AnswerToken.NO_DISABILITY]: 'NO_DISABILITY — no, I do not have a disability',
};

export interface AnswerControlProps {
  readonly intentKey: string; // `answers.foo` or `foo` — both accepted
  readonly meta: IntentMeta;
  readonly value: unknown;
  readonly onChange: (v: unknown) => void;
}

/** DOM id for one control, so `#/profile/answers?intent=…` can scroll to and focus it. */
export function answerAnchorId(intentKey: string): string {
  return `answer-${bareAnswerKey(intentKey)}`;
}

export function AnswerControl({ intentKey, meta, value, onChange }: AnswerControlProps): JSX.Element {
  const bare = bareAnswerKey(intentKey);
  const anchor = answerAnchorId(intentKey);
  const set = (raw: unknown): void => onChange(coerceAnswer(meta.shape, raw));

  return (
    <div class="answer" id={anchor}>
      <div class="answer-head">
        <label class="flabel" for={`${anchor}-input`}>
          {meta.label}
        </label>
        <code class="tiny muted" title="The intent engine/matcher.ts maps a question to">
          answers.{bare}
        </code>
      </div>
      <div class="answer-body">{control(meta, value, set, anchor, bare, onChange)}</div>
      {meta.help && <div class="hint">{meta.help}</div>}
    </div>
  );
}

function control(
  meta: IntentMeta,
  value: unknown,
  set: (raw: unknown) => void,
  anchor: string,
  bare: string,
  onChange: (v: unknown) => void,
): JSX.Element {
  const inputId = `${anchor}-input`;

  switch (meta.shape) {
    case 'boolean':
      return <TriState id={inputId} value={typeof value === 'boolean' ? value : undefined} onChange={(v) => onChange(v)} />;

    case 'number': {
      // "MAX" is a resolver feature, and only for years_of_experience — see engine/resolver.ts.
      const isMax = value === 'MAX';
      return (
        <div class="row wrap">
          <NumberInput
            id={inputId}
            min={0}
            value={isMax ? '' : (value as number | string | undefined)}
            placeholder={isMax ? 'always the top bucket' : 'e.g. 6'}
            onChange={(v) => set(v === undefined ? '' : String(v))}
          />
          {supportsMax(bare) && (
            <Checkbox checked={isMax} onChange={(on) => onChange(on ? 'MAX' : undefined)}>
              <span title="Pick the highest range the form offers, whatever it is">always top bucket (MAX)</span>
            </Checkbox>
          )}
        </div>
      );
    }

    case 'string[]':
      return (
        <ChipInput
          id={inputId}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={(v) => onChange(v.length ? v : undefined)}
          placeholder="Add an option…"
        />
      );

    case 'token': {
      const tokens = meta.tokens?.length ? meta.tokens : Object.values(AnswerToken);
      const current = typeof value === 'string' ? value : '';
      const options = [
        { value: '', label: 'Not set — the question gets parked / skipped / guessed' },
        ...tokens.map((t) => ({ value: t, label: TOKEN_LABEL[t] ?? t })),
        // An imported YAML may hold a literal option text; keep it selectable rather than silently
        // replacing it with a token the user never chose.
        ...(current && !tokens.includes(current) ? [{ value: current, label: `${current} (exact text from your profile)` }] : []),
      ];
      return <Select id={inputId} value={current} options={options} onChange={(v) => onChange(v || undefined)} />;
    }

    case 'derived':
      return (
        <div class="small muted">
          Derived — resolved per job from the job's own locations ∪ <code>want.locations</code>. Nothing to set here.
        </div>
      );

    default:
      return (
        <TextInput
          id={inputId}
          value={answerToText(value)}
          placeholder="Free text or the exact option wording"
          onChange={(v) => set(v)}
        />
      );
  }
}
