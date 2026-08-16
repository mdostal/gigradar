# Design discussion: email-digest-ingestion

## 0. Prelude

**NORTH STAR**: task #53 ("Email digest ingestion — Gmail + other inboxes,
job-alert emails"), picked up directly from the user: "yes email digest
should have you gmail oauth and in all honesty, we should be doing the
oauth for a good deal of these logins -- we've discussed this repeatedly."
Two asks bundled into one instruction: (1) Gmail digest ingestion as a real
feature, and (2) a **generic OAuth2 mechanism**, not a Gmail-only one-off —
this session's `browser-session`/storageState-replay pattern already
covers sites with no OAuth API; this epic is the first source that has a
real, documented OAuth API instead, and the user wants that path built
properly so it generalizes to whatever comes next (a job board with an
OAuth API, Google Calendar for interview scheduling, etc.), not
re-invented per-integration.

## 1. Goal

A user connects their Gmail account once (real OAuth2, not an app
password/IMAP hack), and gigradar periodically scans it for job-alert
digest emails (LinkedIn Job Alerts, Indeed, ZipRecruiter, ...), extracts
Gig-shaped listings from each one via the BYOK LLM, and feeds them into
the exact same gate → tier → store pipeline every other source already
goes through. "Done": a connected Gmail account shows up as a real,
schedulable source in `/config`, the scheduler picks up new digest emails
on its normal cadence, and disconnecting/reconnecting doesn't require
touching `config.json` by hand.

## 2. What already exists to build on (not reinvent)

- **`session-backend.ts`'s dual-backend pattern** (local AES-256-GCM vault
  via `vault.ts`'s `encrypt()`/`decrypt()`, OR Portunus, owner-selectable
  via `SourceConfig.settings.sessionBackend`) — the right shape for
  storing a sensitive credential blob, just currently hard-coded to
  `StorageState`'s shape. OAuth tokens (`{accessToken, refreshToken,
  expiresAt, scope}`) are a SECOND blob shape needing the exact same
  storage discipline (never plaintext on disk, owner-selectable backend,
  never logged). See §3 for the generalization decision.
- **`readEnvVar()`/BYOK Anthropic key convention** — resolved fresh per
  call, never module-scope. The Gmail OAuth **client id/secret** (created
  by the user in their own Google Cloud Console — this is a BYOK model
  exactly like the Anthropic key, gigradar itself is never a registered
  OAuth app anyone else's users authenticate against) follow the identical
  `env:VAR_NAME` reference convention already established for every other
  secret in `config.json`.
- **`custom-source-recipe.ts`'s LLM-extraction pattern** — BEGIN/END
  untrusted-DATA framing, forced structured tool-use, no-fabricated-data
  discipline. Digest-email parsing reuses this shape directly: the email
  body is untrusted DATA, the LLM extracts `Gig[]`-shaped listings from
  it, same as a scraped job-board page.
- **`Source` interface + `runner.ts`'s fallback-routing pattern** — a
  `kind: "gmail-digest"` `SourceConfig` routes to a dedicated `Source`
  object the exact same way `kind: "custom-llm"` routes to
  `customLlmSource`, through the ONE shared `getSource(sc.id) ?? ...`
  fallback chain (now already a chain of two, extending cleanly to a
  third).
- **No `app/api/` route exists yet** — every server-side entry point so
  far is a Server Action. OAuth's redirect step fundamentally can't be:
  Google redirects the user's browser to `http://127.0.0.1:3000/...?code=
  ...&state=...` via a real top-level GET navigation, which only a real
  HTTP route handler can receive. This epic adds gigradar's first
  `app/api/` route for exactly this reason — not a broader shift away from
  Server Actions.
- **Fixed local port**: `electron/main.ts`, `src-tauri/src/lib.rs`, and
  `npm run dev`/`start` all agree the app always runs at
  `http://127.0.0.1:3000` across all three runtime modes. This makes the
  OAuth redirect URI a single, fixed, documentable value — no dynamic
  port negotiation needed.

## 3. Root design decision: generalize session-backend.ts, or duplicate it?

`session-backend.ts`'s Portunus functions
(`writeSessionViaPortunus`/`readSessionViaPortunus`) are typed directly to
`StorageState` and import `isStorageStateShape()` for validation. Two
options:

**(A) Duplicate** — a new `oauth-token-store.ts` with its own
`writeTokenViaPortunus`/`readTokenViaPortunus`, copy-pasting the
spawn/stdin/tempfile-cleanup plumbing.

**(B) Generalize** — parameterize the Portunus read/write functions over a
generic value type + a caller-supplied shape validator, so the (real,
hard-won: stdin-only, never argv, tempfile deleted after every read,
non-zero-exit error surfacing) plumbing is written once and reused by both
`StorageState` and a new `OAuthTokenSet` shape.

**Chosen: (B).** The user's own framing — "we should be doing the oauth
for a good deal of these logins" — says this is the first of several, not
a one-off; duplicating the Portunus plumbing now just means a third
duplicate the next time a different secret shape shows up. The generic
signature:

```ts
async function writeSecretViaPortunus<T>(site: string, account: string, value: T, ttlSeconds: number): Promise<void>
async function readSecretViaPortunus<T>(site: string, account: string, validate: (v: unknown) => v is T): Promise<T>
```

`writeSessionViaPortunus`/`readSessionViaPortunus` become thin wrappers
(`writeSecretViaPortunus(site, account, storageState, ttl)`,
`readSecretViaPortunus(site, account, isStorageStateShape)`) — every
existing caller's signature and behavior is unchanged, so this is a
mechanical refactor plus new tests for the generic layer, not a rewrite.
`vault.ts`'s local-backend path is already fully generic
(`encrypt(plaintext: string)`/`decrypt(envelopeJson: string)`, no shape
coupling at all) — nothing to change there, both StorageState and
OAuthTokenSet just JSON.stringify before encrypt / JSON.parse after
decrypt, exactly like the storageState local-write path already does.

## 4. The OAuth2 flow itself

**Authorization Code flow with PKCE**, `src/lib/auth/oauth2.ts`, provider-
agnostic (Gmail is the first provider, not the only supported shape):

1. **`buildAuthorizationUrl(provider, state)`** — generates a PKCE
   `code_verifier`/`code_challenge` pair (crypto-random, S256), builds the
   provider's real authorize URL (`https://accounts.google.com/o/oauth2/
   v2/auth` for Gmail) with `client_id` (resolved via `readRawConfig()` +
   `env:` reference, same as every other secret), `redirect_uri` (the
   fixed `http://127.0.0.1:3000/api/oauth/{provider}/callback`), `scope`
   (`https://www.googleapis.com/auth/gmail.readonly` — least-privilege,
   read-only, gigradar never sends or modifies email), `access_type=
   offline` + `prompt=consent` (forces a refresh_token on every connect,
   not just the first), and `state` (CSRF-binding, checked on callback).
   The `code_verifier` is held server-side (in-memory, `globalThis`-pinned
   map keyed by `state` — same HMR-survival idiom as every other session
   map this session already established) until the callback arrives.
2. **`GET /api/oauth/[provider]/callback/route.ts`** (new, first API
   route) — validates `state` against the pending map, exchanges `code`
   for `{access_token, refresh_token, expires_in}` via a plain `fetch()`
   POST to the provider's token endpoint (no SDK — same "pin the real API,
   minimal deps" discipline `scan-scheduler`'s croner choice already
   established; Gmail's OAuth2 and REST APIs are plain JSON over HTTPS,
   no client library needed), stores the resulting `OAuthTokenSet` via
   `session-backend.ts`'s generalized Portunus/local path (§3), then
   redirects the browser back to `/config` with a success/failure query
   param the UI reads once and clears.
3. **`getValidAccessToken(sourceId)`** — reads the stored token set,
   returns the access token as-is if not yet expired (with a small clock-
   skew buffer), otherwise POSTs a refresh-token grant to the same token
   endpoint and re-stores the refreshed set before returning. Every Gmail
   API call goes through this — no caller ever reads a raw stored token
   directly.

## 5. Gmail digest fetching + extraction

`src/lib/sources/gmail-digest-source.ts` — a `Source` with `auth:
"oauth"` (new value on the `Source.auth` union), `kind: "gmail-digest"`:

1. `fetch()` calls `getValidAccessToken(sc.id)`, then Gmail's
   `messages.list` REST endpoint with a query narrowing to likely
   job-alert senders (`from:jobalerts-noreply@linkedin.com OR
   from:indeedapply@indeed.com OR ...` — a **configurable, editable
   allowlist** in `settings.digestSenders`, not hardcoded, since which
   boards someone gets alerts from is inherently personal — with a
   sensible built-in default list covering the common ones).
2. For each matched message: `messages.get` (format=`full`) to read the
   body, strip to plain text/simplified HTML, then the SAME
   BEGIN/END-delimited untrusted-DATA LLM extraction shape
   `custom-source-recipe.ts` already uses — one email digest often lists
   MULTIPLE jobs (LinkedIn's "5 new jobs matching your search" emails),
   so the tool-use schema returns `Gig[]`, not a single `Gig`.
   `externalId` is derived from the listing's own real URL found in the
   email (never fabricated), matching every other source's dedup
   contract.
3. **No recipe-caching layer here** (unlike `custom-source-recipe.ts`) —
   digest email HTML structure varies per-sender and changes far less
   predictably-cacheable than a single job board's own page layout; every
   email is a fresh LLM call. This is an accepted, explicit cost/latency
   tradeoff for v1 (digest volume is naturally bounded — a handful of
   emails per scan cycle, not hundreds of listings), not an oversight.
4. Gmail messages already come with the site's OWN listing URL embedded
   (the "View Job" link) — no separate page fetch needed to get a real
   per-listing URL, unlike scraping.

## 6. Safety (non-negotiable, per this repo's existing convention)

- Read-only scope (`gmail.readonly`) — gigradar can never send, delete, or
  modify anything in the connected inbox. Stated explicitly in the
  `/config` UI's connect flow, not just in code comments.
- Same no-fabricated-data rule as every other LLM extraction path in this
  repo — a field the email doesn't show stays unset.
- OAuth tokens never logged, never returned from a Server Action, never
  included in an error message — same discipline `loadConfig()`'s
  resolved-secret handling already established for the Anthropic key.
- `state` CSRF binding on the callback (§4.1) — the callback route
  rejects a request whose `state` isn't a live, pending entry.

## 7. Scale assessment: **Large**

New OAuth2 flow (first in the app), first `app/api/` route, generalized
Portunus/vault secret storage (affects an already-shipped module), a new
`Source` auth kind, and a new LLM-extraction path. Comparable in scope to
`oauth-session-capture-v2`. Full H/V slicing, not a single story.

## 8. Where owner input is genuinely unavoidable

- **Creating the actual Google Cloud OAuth client** (project, consent
  screen, client id/secret, registering the fixed redirect URI) — this is
  a real Google Console action only the user can do; gigradar ships a
  copy-pasteable setup doc (`docs/gmail-oauth-setup.md`, mirroring
  `docs/mcp-setup.md`'s convention) naming the exact redirect URI and
  scope to configure, but cannot do this step itself.
- **Live-verifying the real OAuth handshake + a real digest email**
  against the user's actual Gmail account — everything else (token
  storage, refresh logic, extraction) is built and unit-tested against
  mocks first, matching this session's established discipline; the live
  connect-and-scan pass is the user's own step (or done together,
  watching), never repeated unattended runs against a real account per
  [[feedback_never_touch_real_local_data_dir]]'s broader "no repeated
  install/wipe/live-test cycles" constraint.

## 9. Open questions, resolved

- **Q: Should the generic OAuth module be provider-agnostic from day one,
  or Gmail-specific with generalization deferred?**
  A: Provider-agnostic from day one — a `provider` config object
  (authorize URL, token URL, scope, client-id/secret env-ref keys) rather
  than Gmail constants inlined into the flow functions, since the user's
  own framing is "a good deal of these logins," not just this one. Gmail
  is the only registered provider in this epic, but the seam is real, not
  aspirational.
- **Q: Reuse `session-backend.ts`'s `sessionBackendFrom(cfg)` setting
  reader for OAuth token backend selection too, or a separate setting?**
  A: Reuse as-is — it already just reads `cfg.settings.sessionBackend`
  generically, doesn't care what's being stored.
- **Q: `googleapis` npm SDK, or plain `fetch()`?**
  A: Plain `fetch()` against Gmail's REST API and Google's OAuth2 REST
  endpoints. No new heavy dependency, matches `scan-scheduler`'s own
  "pin the real API, avoid unnecessary deps" precedent, and the actual
  surface area used (list/get messages, token exchange/refresh) is small
  enough that a full SDK buys little.
