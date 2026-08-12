# Research Brief: dashboard-config-ui

## 1. Summary

This is a genuine blank-slate epic: no `src/app/`, no styling framework, no
`next.config.js` exist. Three backend surfaces already exist and are ready
to be consumed by API routes/server actions (store, config-read, browser-
session), but two critical gaps were found that change this epic's design:
config has **no write path at all** (and a naive one would leak resolved
secrets back into plaintext `config.json`), and the existing browser-session
mechanism is **architecturally unusable for a login-capture flow** — it was
built to consume an already-valid session, not create one, and needs
genuinely new, stateful code.

## 2. Key files & surfaces

- `src/lib/store/index.ts` — `listGigs(filter?, opts?)`, `getGig(key, opts?)`,
  `setStatus(key, status, opts?)` (throws on unknown key — API routes must
  catch, not let it 500 raw). All synchronous. `GigFilter = {status?,
  sourceId?, unavailable?}` — **no pagination/limit/offset**.
- `src/lib/config/load.ts` — `loadConfig()` (sync, resolves `env:` refs to
  real values), `getConfigPath()`, `getEnvPath()`, `resolveEnvString()`.
  **No write function exists anywhere in the module.**
- `src/lib/auth/browser-session.ts` — `withBrowserSession()` requires an
  ALREADY-VALID storageState file, immediately filters+scopes it,
  navigates, checks auth, runs a callback, and unconditionally closes the
  browser in a `finally` block — zero "stay open for a human" affordance.
  Also exports `filterStorageStateToAllowlist()` (reusable) and
  `checkChromiumAvailable()`.
- `src/lib/types.ts` — full `Config`/`Profile`/`Needs`/`RoleAreaConfig`/
  `SourceConfig` shape a config form must cover; `roleArea`/`schedule` are
  meaningfully optional (omitted ≠ empty), not just blank-default fields.
- `docs/ARCHITECTURE.md` — confirms this is the next unchecked roadmap
  item, and explicitly frames the intended design: new capture-specific
  code producing the same plain storageState file format, NOT a
  modification of `withBrowserSession()` itself.
- `package.json` — Next 15 / React 19 already deps; `NODE_OPTIONS=--experimental-sqlite`
  already threaded through `dev`/`build`/`start` scripts (any new script
  touching `src/lib/store` needs the same flag).

## 3. Patterns & conventions

- Every existing module (store, config, auth) is synchronous, throws
  specific errors rather than silent-failing, and treats "secrets/local
  state never leaves its designated location" as non-negotiable — a config
  WRITE function must follow the same discipline: reuse `getConfigPath()`,
  validate via `ConfigSchema` before writing, never write a resolved
  secret value back to `config.json`.
- `filterStorageStateToAllowlist()` from the browser-session module is
  directly reusable by a new capture flow (apply the same origin-scoping
  discipline to a freshly-captured session, not just consumed ones).

## 4. Constraints

- **Core/user-layer boundary, as every prior epic**: the dashboard, forms,
  and templates are generic OSS; the owner's own criteria/sessions remain
  his local config.
- **Self-hosted-only constraint (new, real, worth naming explicitly)**: a
  login-capture flow that opens a real headed browser window only works
  when the Next.js server process and the human's desktop session are the
  same machine — this is NOT compatible with a remotely-deployed dashboard
  instance. Consistent with gigradar's existing local-first design, but a
  first case where the UI epic must explicitly acknowledge a deployment
  constraint, not just a data-storage one.
- **Resolved-secret leak risk in config writes** — `loadConfig()` returns
  `env:` references already resolved to real values; naively re-serializing
  that object back to `config.json` would write real secrets in plaintext
  where only a reference belongs. A write path must operate on/preserve
  the unresolved reference strings.
- No pagination in `listGigs()` — a dashboard listing view needs its own
  pagination/virtualization strategy or an extension to the store API.

## 5. Risks

- **High — the login-capture flow is a genuinely novel, stateful
  mechanism**, not a simple CRUD form. It requires holding a live
  Playwright `Browser` handle across an indeterminate human-paced
  interval, in-process (works only because gigradar is long-running
  Node, not serverless), with its own cleanup/timeout/cancel story. This
  is the epic's highest-complexity, highest-risk piece by a wide margin.
- **High — config write path secret-handling** is easy to get subtly
  wrong (the "re-serialize the resolved Config" trap) in a way that would
  silently violate the project's own non-negotiable secrets rule.
- **Medium — total blank-slate scope.** No app-router scaffold, no styling
  choice made, no component patterns established — this epic pays the
  full first-UI-file setup cost that every subsequent UI epic won't.

## 6. Open questions

1. Does this epic need to scope down (defer the login-capture flow, or
   defer role templates) given the blank-slate cost plus two genuinely
   hard sub-problems (capture flow, secret-safe config writes)? Or does
   the full brief (dashboard + config + capture + templates) stay as one
   epic with H/V slicing?
2. Styling/component approach — Tailwind is the de facto Next 15 default
   but nothing in the repo presupposes it. Confirm before scaffolding.
3. Config write granularity — full-document replace-on-save, or targeted
   per-field patches? Affects both the API design and how the
   secret-preservation logic works.
