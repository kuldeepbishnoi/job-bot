import { describe, it, expect } from 'vitest';
import { screen, enterEmail, enterPassword, enterCode, findLoginCode, isPassportUrl, errorText } from '@/ats/passport';

// Ids transcribed from passport.amazon.jobs/main.js (2026-09-02).
const parse = (h: string): Document => new DOMParser().parseFromString(h, 'text/html');
const visible = (doc: Document) => { for (const el of doc.querySelectorAll('*')) Object.defineProperty(el, 'offsetParent', { get: () => doc.body }); };

describe('passport login adapter', () => {
  it('recognises each screen', () => {
    const email = parse('<form><input id="preLoginEmailField" name="email"><button type="submit" id="preLoginContinueButton">Continue</button></form>');
    visible(email);
    expect(screen(email)).toBe('email');
    const pw = parse('<form name="loginForm"><input id="loginFormUsernameInputField"><input id="loginFormPasswordInputField" type="password"><button type="submit" class="btn-main">Sign in</button></form>');
    visible(pw);
    expect(screen(pw)).toBe('password');
    const code = parse('<form name="VerifyCodeForm"><input id="verificationFormCodeInputField" name="verificationCode"><button type="submit" class="btn-main">Verify</button></form>');
    visible(code);
    expect(screen(code)).toBe('code');
    const cap = parse('<div id="captcha-widget"></div>');
    visible(cap);
    expect(screen(cap)).toBe('captcha');
    expect(screen(parse('<div>loading</div>'))).toBe('unknown');
  });

  it('types the email, password and code into the right fields and submits', () => {
    const pw = parse('<form name="loginForm"><input id="loginFormUsernameInputField" value=""><input id="loginFormPasswordInputField" type="password"><button type="submit" class="btn-main">Sign in</button></form>');
    visible(pw);
    let submitted = 0;
    pw.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); submitted++; });
    enterPassword(pw, 'me@x.com', 'pw');
    expect(pw.querySelector<HTMLInputElement>('#loginFormUsernameInputField')!.value).toBe('me@x.com');
    expect(pw.querySelector<HTMLInputElement>('#loginFormPasswordInputField')!.value).toBe('pw');
    expect(submitted).toBe(1);

    const email = parse('<form><input id="preLoginEmailField"><button type="submit" id="preLoginContinueButton">Continue</button></form>');
    visible(email);
    email.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    enterEmail(email, 'me@x.com');
    expect(email.querySelector<HTMLInputElement>('#preLoginEmailField')!.value).toBe('me@x.com');

    const code = parse('<form name="VerifyCodeForm"><input id="verificationFormCodeInputField"><button type="submit" class="btn-main">Verify</button></form>');
    visible(code);
    code.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    enterCode(code, '123456');
    expect(code.querySelector<HTMLInputElement>('#verificationFormCodeInputField')!.value).toBe('123456');
  });

  it('extracts a 6-digit verification code and reads error banners', () => {
    expect(findLoginCode('Your verification code is 482915. It expires in 10 minutes.')).toBe('482915');
    expect(findLoginCode('Use 301777 as your Amazon.jobs verification code')).toBe('301777');
    expect(findLoginCode('Order 123456789 shipped')).toBeNull();
    const err = parse('<div role="alert">Incorrect password</div>');
    visible(err);
    expect(errorText(err)).toBe('Incorrect password');
    expect(isPassportUrl('https://passport.amazon.jobs/login')).toBe(true);
    expect(isPassportUrl('https://www.amazon.jobs/en-US/applicant/dashboard')).toBe(false);
  });
});
