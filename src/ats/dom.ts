// Tiny DOM helpers shared by ATS adapters. Kept separate so they're easy to test.

/** Set a React-controlled input's value so React actually registers it.
 *  Some Greenhouse forms only clear their "is required" error on blur — so we simulate a full
 *  focus → input → change → blur cycle. Synthetic FocusEvents don't move real focus, they just
 *  trip listeners. */
export function setReactValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

/** Attach a file to an <input type=file> programmatically (browser then uploads it). */
export function setFile(input: HTMLInputElement, file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Poll until predicate returns truthy or timeout. */
export async function waitFor<T>(fn: () => T | null | undefined, ms = 4000, step = 50): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, step));
  }
}

export function labelText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
