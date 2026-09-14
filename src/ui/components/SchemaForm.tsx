import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { addChips, removeChip, splitChips, type Errors, type FieldSpec } from '../profile-draft';

// Form primitives for the profile editor. They are deliberately dumb: every one takes a value +
// an onChange + an optional error string, so the page owns the draft and the schema owns the truth.

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | undefined;
  required?: boolean;
  htmlFor?: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class={`fieldrow${error ? ' has-error' : ''}`}>
      <label class="flabel" for={htmlFor}>
        {label}
        {required && <span class="req" title="required"> *</span>}
      </label>
      {children}
      {hint && <div class="hint">{hint}</div>}
      {error && <div class="ferr">{error}</div>}
    </div>
  );
}

export function TextField({
  spec,
  value,
  error,
  onChange,
  id,
}: {
  spec: FieldSpec;
  value: string;
  error?: string | undefined;
  onChange: (v: string) => void;
  id?: string;
}): JSX.Element {
  const inputId = id ?? `f-${spec.key}`;
  return (
    <Field label={spec.label} hint={spec.help} error={error} required={spec.required} htmlFor={inputId}>
      <input
        id={inputId}
        type={spec.type}
        value={value}
        placeholder={spec.type === 'url' ? 'https://…' : ''}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </Field>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  id?: string;
}): JSX.Element {
  return (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  );
}

/** Number box that can be empty. Empty means "unset", not 0 — `max_per_run` omitted = no cap. */
export function NumberInput({
  value,
  onChange,
  placeholder,
  min = 1,
  id,
}: {
  value: number | string | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  min?: number;
  id?: string;
}): JSX.Element {
  return (
    <input
      id={id}
      type="number"
      min={min}
      value={value === undefined ? '' : String(value)}
      placeholder={placeholder}
      onInput={(e) => {
        const raw = (e.target as HTMLInputElement).value.trim();
        onChange(raw === '' ? undefined : Number(raw));
      }}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ComponentChildren;
  id?: string;
}): JSX.Element {
  return (
    <label class="check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Yes / No / not set. The third state is not decoration: leaving a question unanswered is what
 *  hands it to `on_unknown` (park, skip or guess) instead of asserting something untrue. */
export function TriState({
  value,
  onChange,
  id,
}: {
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
  id?: string;
}): JSX.Element {
  const opts: { v: boolean | undefined; label: string; title: string }[] = [
    { v: true, label: 'Yes', title: 'Answer Yes everywhere this question appears' },
    { v: false, label: 'No', title: 'Answer No everywhere this question appears' },
    { v: undefined, label: 'Not set', title: 'Leave unanswered — on_unknown decides (park / skip / guess)' },
  ];
  return (
    <div class="seg" id={id}>
      {opts.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          title={o.title}
          class={value === o.v ? 'on' : ''}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Radios<T extends string>({
  value,
  options,
  onChange,
  name,
}: {
  value: T;
  options: readonly { id: T; label: string; help?: string }[];
  onChange: (v: T) => void;
  name: string;
}): JSX.Element {
  return (
    <div class="radios">
      {options.map((o) => (
        <label key={o.id} class={`radio${value === o.id ? ' on' : ''}`}>
          <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span>
            <b>{o.label}</b>
            {o.help && <em>{o.help}</em>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Tag editor. Enter or comma commits; pasting "a, b, c" commits all three; Backspace on an empty
 *  box removes the last chip. Used for every list in the profile (titles, locations, languages…). */
export function ChipInput({
  value,
  onChange,
  placeholder,
  id,
  errors,
  errorPrefix,
}: {
  value: readonly string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
  errors?: Errors;
  errorPrefix?: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const commit = (raw: string): void => {
    if (!splitChips(raw).length) return;
    onChange(addChips(value, raw));
    setText('');
  };
  return (
    <div class="chips editor">
      {value.map((v, i) => {
        const err = errors && errorPrefix ? errors[`${errorPrefix}.${i}`] : undefined;
        return (
          <span key={`${v}-${i}`} class={`chip${err ? ' bad' : ''}`} title={err}>
            {v}
            <button type="button" class="x" aria-label={`Remove ${v}`} onClick={() => onChange(removeChip(value, i))}>
              ×
            </button>
          </span>
        );
      })}
      <input
        id={id}
        class="chip-entry"
        value={text}
        placeholder={placeholder ?? 'Type and press Enter'}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (v.endsWith(',')) commit(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(text);
          } else if (e.key === 'Backspace' && text === '' && value.length) {
            onChange(removeChip(value, value.length - 1));
          }
        }}
        onBlur={() => commit(text)}
      />
    </div>
  );
}

export function Select({
  value,
  options,
  onChange,
  id,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  id?: string;
}): JSX.Element {
  return (
    <select id={id} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The bar that says "you have unsaved changes" and does something about it. Sticky, because the
 *  answers tab is long and a Save button you have to hunt for is a Save button you forget. */
export function SaveBar({
  dirty,
  canSave,
  issues,
  saving,
  savedAt,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  canSave: boolean;
  issues: number;
  saving: boolean;
  savedAt?: string | undefined;
  onSave: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <div class={`savebar${dirty ? ' dirty' : ''}`}>
      <span class="small muted">
        {dirty ? <b class="dirty-dot">● Unsaved changes</b> : savedAt ? `Saved ${savedAt}` : 'No changes'}
        {issues > 0 && <span class="ferr"> · {issues} field{issues === 1 ? '' : 's'} need fixing</span>}
      </span>
      <div class="right row">
        <button class="ghost" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </button>
        <button disabled={!dirty || !canSave || saving} onClick={onSave} title={canSave ? '' : 'Fix the highlighted fields first'}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
