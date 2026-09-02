import { setReactValue } from './dom';

// Amazon passport (passport.amazon.jobs) login adapter — pure DOM, tested in happy-dom.
// Element ids come straight from the passport bundle (main.js, 2026-09-02):
//   pre-login:  #preLoginEmailField (name=email)      → #preLoginContinueButton
//   login:      form[name=loginForm] #loginFormUsernameInputField #loginFormPasswordInputField → submit
//   MFA code:   form[name=VerifyCodeForm] #verificationFormCodeInputField → submit (POST /api/verifyMfaOtp)
//   captcha:    #captcha-widget (AWS WAF) — cannot be automated → hand back to the user
//   errors:     [role=alert] / .alert-danger banners
export type LoginScreen = 'email' | 'password' | 'code' | 'captcha' | 'error' | 'unknown';

const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null;

export function screen(doc: Document): LoginScreen {
  if (shown(doc.querySelector('#captcha-widget'))) return 'captcha';
  if (shown(doc.querySelector('#verificationFormCodeInputField'))) return 'code';
  if (shown(doc.querySelector('#loginFormPasswordInputField'))) return 'password';
  if (shown(doc.querySelector('#preLoginEmailField'))) return 'email';
  if (errorText(doc)) return 'error';
  return 'unknown';
}

export function errorText(doc: Document): string {
  return [...doc.querySelectorAll<HTMLElement>('[role="alert"], .alert-danger, .banner-error, [id$="Error"]')]
    .filter(shown)
    .map((e) => (e.textContent ?? '').trim())
    .filter(Boolean)
    .join('; ');
}

function submit(form: Element | null): void {
  const btn = form?.querySelector<HTMLElement>('button[type="submit"], .btn-main') ?? null;
  if (!btn) throw new Error('no submit button');
  btn.click();
}

export function enterEmail(doc: Document, email: string): void {
  const input = doc.querySelector<HTMLInputElement>('#preLoginEmailField');
  if (!input) throw new Error('no email field');
  setReactValue(input, email);
  (doc.querySelector<HTMLElement>('#preLoginContinueButton') ?? null)?.click();
}

export function enterPassword(doc: Document, email: string, password: string): void {
  const user = doc.querySelector<HTMLInputElement>('#loginFormUsernameInputField');
  const pass = doc.querySelector<HTMLInputElement>('#loginFormPasswordInputField');
  if (!pass) throw new Error('no password field');
  if (user && user.value.trim().toLowerCase() !== email.toLowerCase()) setReactValue(user, email);
  setReactValue(pass, password);
  submit(pass.closest('form'));
}

export function enterCode(doc: Document, code: string): void {
  const input = doc.querySelector<HTMLInputElement>('#verificationFormCodeInputField');
  if (!input) throw new Error('no code field');
  setReactValue(input, code);
  submit(input.closest('form'));
}

/** Passport pages live on passport.amazon.jobs; anywhere else means the login finished. */
export function isPassportUrl(url: string): boolean {
  return /^https:\/\/passport\.amazon\.jobs\//i.test(url);
}

/** The 6-digit verification code in a passport email body/snippet. */
export function findLoginCode(text: string): string | null {
  const m = text.match(/(?:code|OTP)[^0-9]{0,40}(\d{6})\b/i) ?? text.match(/\b(\d{6})\b(?=[^0-9]{0,40}(?:code|verif))/i);
  return m?.[1] ?? null;
}
