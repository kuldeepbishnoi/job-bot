# Gmail API for the OTP (one-time setup)

The apply flow needs the 8-char Greenhouse security code that arrives by email. By default the
extension scrapes an **open** `mail.google.com` tab — fragile (two codes in the inbox, unread/read
ordering, snippet truncation) and it forces you to keep Gmail open. Connecting the **Gmail API**
removes all of that: the background reads the newest `no-reply@us.greenhouse-mail.io` email directly.

The code degrades gracefully: with no OAuth configured, `chrome.identity` fails and `getOtp` falls
back to the tab scrape. So this setup is optional but recommended.

## Already done for you
- A signing key was generated at `~/.jobbot/extension-key.pem` (keep it; don't commit — `*.pem` is
  git-ignored). Its public half is written to `.env` as `EXTENSION_KEY`, which pins the extension ID.
- **Your extension ID is `hajmnimjcboohangbokbekphbcdonkff`** — use it verbatim in step 3 below.
- `.env` is pre-filled with the key and an empty `GMAIL_OAUTH_CLIENT_ID` waiting for step 3's value.

So the only thing you must do is create the OAuth client in your Google account and paste its ID.

## Steps (account-bound — must be done in the Console UI)

1. **Google Cloud project + Gmail API.**
   - Create/select a project at <https://console.cloud.google.com>.
   - APIs & Services → Library → enable **Gmail API**.

2. **OAuth consent screen.**
   - User type: External. Fill the required app name/email.
   - Add scope `https://www.googleapis.com/auth/gmail.readonly`.
   - Add your Google account under **Test users** (so you can consent without app verification).

3. **OAuth client ID.**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - Application type: **Chrome App** (a.k.a. Chrome Extension).
   - Application ID: **`hajmnimjcboohangbokbekphbcdonkff`** (already pinned by the generated key).
   - Copy the client ID → paste it into `.env` as `GMAIL_OAUTH_CLIENT_ID`.

4. **Rebuild and reload.**
   ```
   npm run build   # picks up .env automatically
   ```
   Reload the unpacked extension at `chrome://extensions`. Open the popup → **Connect Gmail…** →
   grant consent. The button flips to "Gmail connected ✓" and the background reads OTPs via the API.

## Notes
- Scope is **read-only** (`gmail.readonly`) — the extension only searches recent Greenhouse mail.
- The token is cached by Chrome; the background refreshes it silently. If it's ever rejected (401)
  the code drops the cached token so the next read re-fetches.
- Nothing secret is committed: `oauth2`/`key` only appear in the manifest when the env vars are set.
