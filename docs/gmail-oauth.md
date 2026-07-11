# Gmail API for the OTP (one-time setup)

The apply flow needs the 8-char Greenhouse security code that arrives by email. By default the
extension scrapes an **open** `mail.google.com` tab — fragile (two codes in the inbox, unread/read
ordering, snippet truncation) and it forces you to keep Gmail open. Connecting the **Gmail API**
removes all of that: the background reads the newest `no-reply@us.greenhouse-mail.io` email directly.

The code degrades gracefully: with no OAuth configured, `chrome.identity` fails and `getOtp` falls
back to the tab scrape. So this setup is optional but recommended.

## What you configure
Two env vars, passed at build time:
- `EXTENSION_KEY` — pins the extension ID so the OAuth client keeps matching across reloads.
- `GMAIL_OAUTH_CLIENT_ID` — the OAuth 2.0 **Chrome App** client ID.

## Steps

1. **Pin the extension ID (`EXTENSION_KEY`).**
   - Build once (`npm run build`) and load `.output/chrome-mv3` unpacked at `chrome://extensions`.
   - Get the stable public key: easiest is to pack the extension once (`chrome://extensions` →
     "Pack extension") and read the `key` from the generated manifest, or copy it from an already
     published item. Set it as `EXTENSION_KEY` (the long base64 string, no `-----` lines).
   - The extension ID is derived from this key and stays constant.

2. **Google Cloud project + Gmail API.**
   - Create/select a project at <https://console.cloud.google.com>.
   - APIs & Services → Library → enable **Gmail API**.

3. **OAuth consent screen.**
   - User type: External. Fill the required app name/email.
   - Add scope `https://www.googleapis.com/auth/gmail.readonly`.
   - Add your Google account under **Test users** (so you can consent without app verification).

4. **OAuth client ID.**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - Application type: **Chrome App** (a.k.a. Chrome Extension).
   - Application ID: your extension ID from step 1.
   - Copy the client ID → that's `GMAIL_OAUTH_CLIENT_ID`.

5. **Build with the env vars and reload.**
   ```
   GMAIL_OAUTH_CLIENT_ID=xxxxx.apps.googleusercontent.com EXTENSION_KEY=MIIB... npm run build
   ```
   Reload the unpacked extension. Open the popup → **Connect Gmail…** → grant consent.
   The button flips to "Gmail connected ✓" and the background reads OTPs via the API from then on.

## Notes
- Scope is **read-only** (`gmail.readonly`) — the extension only searches recent Greenhouse mail.
- The token is cached by Chrome; the background refreshes it silently. If it's ever rejected (401)
  the code drops the cached token so the next read re-fetches.
- Nothing secret is committed: `oauth2`/`key` only appear in the manifest when the env vars are set.
