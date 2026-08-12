# Research Brief: session-capture-ui

## 1. Summary

This epic was already scoped out of `dashboard-config-ui` specifically
because it's architecturally different from a CRUD form: `browser-session.ts`'s
`withBrowserSession()` is built to CONSUME an already-valid session in one
synchronous await-chain with unconditional cleanup — it has no "stay open
for a human" mode. This epic needs new, stateful server-side code holding
a live Playwright `Browser` handle across an indeterminate, human-paced
interval (someone completing a real login, possibly with MFA/OAuth
redirects), bridged to a Next.js UI via a start/finish two-phase flow.

## 2. Key files & surfaces

- `src/lib/auth/browser-session.ts` — NOT modified by this epic (per its
  own file comment and `docs/ARCHITECTURE.md`'s framing: the intended
  design is new, separate capture code producing the same plain
  storageState file format). Reusable exports: `filterStorageStateToAllowlist()`
  (apply the same origin-scoping discipline to a freshly-captured session)
  and `checkChromiumAvailable()` (same Chromium-binary preflight check).
- `src/lib/config/save.ts` — `saveConfig()`/`readRawConfig()`, reusable to
  write the captured session's file path into a source's
  `SourceConfig.settings` once capture completes.
- `src/app/actions.ts` + `src/lib/actions/result.ts` — the established
  Server Action convention (`ActionResult<T>` + `revalidatePath()`) this
  epic's new Server Actions must follow, not reinvent.
- `src/lib/sources/gofractional.ts` / `ateam.ts` — each already declares
  its own origin allowlist internally (e.g. `["gofractional.com"]`,
  `["a.team", "platform.a.team"]|`) for `withBrowserSession()`'s
  consumption; this epic needs the SAME allowlists for capture-time
  scoping, ideally without duplicating them.
- `next.config.js` — the `resolve.extensionAlias` fix from
  `app-foundation` (`.js` imports of `.ts` files) applies to any new
  `src/lib/auth/*.ts` module this epic adds, same as every prior story.

## 3. Patterns & conventions

- **Headed-only, confirmed twice now** (browser-session-auth's live
  testing, reconfirmed by `browser-session.ts`'s hardcoded
  `headless: false`) — a capture flow launching Chromium must also be
  headed; there is no headless capture mode to consider.
- **Origin-scoping is non-negotiable everywhere session data touches a
  browser context** — established across two prior epics; this epic's
  captured session must be filtered the same way before being persisted
  or ever loaded into a context again.
- **Self-hosted-only constraint, already named in the dashboard epic's
  research**: a login-capture flow that opens a real headed browser window
  only works when the Next.js server process and the human's desktop
  session are the same machine — reconfirmed as directly relevant now
  that the mechanism is actually being built, not just anticipated.

## 4. Constraints

- **In-process state only.** A capture session's live `Browser`/
  `BrowserContext` handle must be held in an in-memory, module-level
  structure (e.g. a `Map`) across the "start capture" and "finish capture"
  Server Action calls — this works ONLY because gigradar runs as a
  long-lived `next dev`/`next start` Node process (confirmed by
  `app-foundation`'s work), not a serverless/edge runtime. This is a
  real, already-validated assumption from the prior epic, not a new risk.
- **Needs its own cleanup/timeout story.** Unlike `withBrowserSession()`'s
  unconditional `finally`-block cleanup (a single synchronous chain), a
  capture session can be abandoned mid-flow (user closes the tab, gives
  up, the server restarts) — nothing analogous to a `finally` block covers
  an abandoned in-memory handle across two separate HTTP requests.
- **Core/user-layer boundary, as always**: the capture mechanism and its
  UI are generic OSS; which specific source a user captures a session for,
  and when, is their own action — no hardcoded owner-specific flow.

## 5. Risks

- **High — leaked Chromium processes on abandoned captures.** If a user
  starts a capture and never finishes it (closes the tab, gets distracted,
  the dev server restarts), the headed Chromium process from "start"
  has no natural trigger to close. This is the epic's most novel new
  failure mode — nothing in this codebase has needed a cross-request
  timeout/cleanup mechanism before.
- **Medium — server restart loses in-memory capture state entirely.** A
  `next dev` hot-reload or crash mid-capture leaves an orphaned Chromium
  process with no record of it in the (now-restarted) in-memory map. This
  needs at least a documented limitation, and ideally a process-level
  safeguard (e.g. a max-lifetime per launched browser, not just an
  idle timer).
- **Medium — origin allowlists currently live inside each adapter file**,
  not in a shared registry. This epic either needs to import them from
  each adapter module (creating a new dependency direction: auth code
  importing from sources code, which currently doesn't happen) or extract
  a small shared per-source registry — a real design decision, not a
  trivial wiring detail.

## 6. Open questions

1. Idle-timeout duration for an abandoned capture session (e.g. 5
   minutes? 15?) — and what closes it: a `setTimeout` per capture, or a
   periodic sweep?
2. Where do per-source origin allowlists live going forward — duplicated
   into this epic's capture registry, or extracted to a shared module
   both the adapters and this epic import from?
3. Does the UI need to POLL for capture status (e.g. "has the user
   finished logging in yet"), or is a simple explicit "I'm done, capture
   now" button (user-driven, no polling) sufficient for v1?
