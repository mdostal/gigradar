# Connecting Gmail for email-digest ingestion

gigradar can scan your Gmail inbox for job-alert digest emails (LinkedIn
Job Alerts, Indeed, ZipRecruiter, ...) and extract listings from them —
but it needs its own real OAuth client, one you create yourself. gigradar
is never a centrally-registered app anyone else authenticates against
(same BYOK model as the Anthropic API key) — every gigradar install uses
its own Google Cloud OAuth client.

**Scope**: gigradar requests `gmail.readonly` only. It can never send,
delete, or modify anything in your inbox.

## 1. Create a Google Cloud project (skip if you already have one)

Go to [console.cloud.google.com](https://console.cloud.google.com/), create
a new project (any name — e.g. "gigradar-personal").

## 2. Configure the OAuth consent screen

In the project, go to **APIs & Services → OAuth consent screen**. Choose
**External** (unless you have a Google Workspace org and want Internal),
fill in the required app name/support email fields, and add the scope
`https://www.googleapis.com/auth/gmail.readonly` under **Scopes**. You can
leave the app in "Testing" status and add your own Gmail address as a test
user — it doesn't need to go through Google's verification review for
personal use.

## 3. Create the OAuth client

**APIs & Services → Credentials → Create Credentials → OAuth client ID.**
Application type: **Web application**.

Under **Authorized redirect URIs**, add EXACTLY:

```
http://127.0.0.1:3000/api/oauth/gmail/callback
```

gigradar prefers port 3000 across every runtime mode (browser, Electron, the
packaged `.app`) specifically so this registered redirect URI keeps working
across launches without you needing to touch it again.

**If port 3000 is already used by something else on your machine** (another
local app or service), gigradar still starts — it falls back to a random
free port instead of refusing to launch — but that fallback port won't match
what you registered above, so Gmail Connect won't work for that session. Fix
it by picking a port you control and setting it explicitly:

```
GIGRADAR_PORT=3900
```

(in your shell environment, or your data directory's `.env`) and using that
same port in step 3 above (`http://127.0.0.1:3900/api/oauth/gmail/callback`)
instead of 3000. As long as `GIGRADAR_PORT` stays free and set the same way
every time you launch gigradar, this only needs doing once.

Save, then copy the **Client ID** and **Client secret** Google shows you.

## 4. Enable the Gmail API

**APIs & Services → Library**, search "Gmail API", click **Enable**.

## 5. Add the client id/secret to gigradar

Same `env:VAR_NAME` convention as every other secret in gigradar's
`config.json` (see `docs/ARCHITECTURE.md`'s "Secrets" section) — never a
raw value directly in `config.json`.

In your gigradar data directory's `.env` (via `/config`, or hand-edit):

```
GMAIL_OAUTH_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GMAIL_OAUTH_CLIENT_SECRET=your-client-secret-here
```

In `config.json`, add a source with `kind: "gmail-digest"`:

```json
{
  "id": "gmail-digest",
  "enabled": true,
  "kind": "gmail-digest",
  "settings": {
    "gmailClientId": "env:GMAIL_OAUTH_CLIENT_ID",
    "gmailClientSecret": "env:GMAIL_OAUTH_CLIENT_SECRET"
  }
}
```

(Or use `/config`'s "Connect Gmail" flow, which writes this for you.)

## 6. Connect

In `/config`, click **Connect Gmail** on the source you just added. You'll
be sent to Google's real consent screen, then redirected back — gigradar
never sees your Gmail password, only the token Google issues after you
approve.
