# Vertical plan: email-digest-ingestion

Four independently-shippable slices, each landing as its own story with
real test coverage before the next begins.

## Slice 1 — Generic OAuth2 mechanism

`src/lib/auth/oauth2.ts`: PKCE authorization-URL builder, token exchange,
`getValidAccessToken()` with auto-refresh, provider-agnostic (`OAuthProvider`
config shape: authorize/token URLs, scope, client-id/secret env-ref keys).
Generalizes `session-backend.ts`'s Portunus functions to a generic
`writeSecretViaPortunus<T>`/`readSecretViaPortunus<T>` (existing
`writeSessionViaPortunus`/`readSessionViaPortunus` become thin wrappers —
byte-identical behavior, existing tests must stay green unmodified).
No Gmail-specific code yet — this slice is the seam, story 2 is the first
thing plugged into it.

## Slice 2 — Gmail provider + `/api/oauth/[provider]/callback` route

The Gmail `OAuthProvider` config, gigradar's first `app/api/` route
handler (receives the real redirect, validates `state`, exchanges the
code, stores the token set), and `docs/gmail-oauth-setup.md` (the
copy-pasteable Google Cloud Console walkthrough naming the exact redirect
URI/scope). Ends with: a user can complete a real OAuth handshake and see
a connected token set land in local vault or Portunus.

## Slice 3 — `gmail-digest-source.ts` + extraction

The `Source` with `auth: "oauth"`, `kind: "gmail-digest"`: Gmail
`messages.list`/`messages.get` via `getValidAccessToken()`, configurable
sender allowlist with a sensible default, BEGIN/END-delimited LLM
extraction returning `Gig[]` per email (no-fabricated-data, real
per-listing URLs from the email body). Wired into `runner.ts`'s fallback
chain (`getSource(sc.id) ?? customLlmSource-check ?? gmail-digest-check`)
and `Source.auth`'s new `"oauth"` value.

## Slice 4 — `/config` UI: Connect Gmail

A "Connect Gmail" button (mirrors "Custom (LLM)"/"Capture Login"'s
existing button conventions) that starts the flow, a connected-state
display (masked, never the raw token), a Disconnect action, and the
read-only-scope disclosure copy from the design doc's §6. Server Actions:
`startGmailOAuthAction()` (returns the authorization URL to redirect to),
`disconnectGmailAction()`.

## Where owner input is unavoidable

Per design-discussion.md §8: the real Google Cloud OAuth client
(project/consent screen/client id+secret/redirect URI registration) and
the first live connect-and-scan pass against a real Gmail account. Every
slice above builds and unit-tests against mocks first; these two steps are
explicitly the user's own, not simulated.
