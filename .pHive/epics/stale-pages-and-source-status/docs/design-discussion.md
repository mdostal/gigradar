# Design Discussion: stale-pages-and-source-status

## 0. Prelude

Two real, user-confirmed bugs surfaced during dogfooding (2026-08-26): the Dashboard/Issues/Drafts UI showed a frozen empty state ("0 sources configured", "Profile: needs setup", "0 of 0 gigs") despite a real `gigs.db` holding 1,347 gigs accumulated by a week of real scheduler runs; and the `/config` Sources list gives no visual signal for which sources actually have a working login vs. which need one, which the user could not tell apart by eye.

Scope boundary (explicit, from the requester): fix these two bugs only. A broader visual/design pass on `/config` and the dashboard is a separate, later phase — not touched here.

## 1. Goal

1. Every page that reads live app data (gigs, drafts, issues, config) reflects reality on every request — including data written by the standalone scheduler process, which today never triggers any cache invalidation.
2. Every source row in `/config` shows, at a glance, whether it needs a login and whether one is already captured.

## 2. Root cause (Bug 1) — confirmed via code research, not guesswork

None of the six `page.tsx` files export `dynamic`/`revalidate`, so Next 15 statically prerenders each one at `next build` time and serves that frozen HTML/RSC forever, until an explicit `revalidatePath()` call from *inside a live request* targets that route.

Per-route findings:

| Route | Live data read | Existing `revalidatePath` coverage | Verdict |
|---|---|---|---|
| `/` (dashboard) | `listGigs()`, `listDrafts()`, `readRawConfig()` | Covers in-app mutations (gig status, prep packet, mark-submitted, resolve-issue) | Gap: scheduler-written gigs never revalidate |
| `/issues` | `listIssues()` | Covers *resolving* an issue only | Gap: *raising* an issue (the scheduler's `raiseIssue()`, the only place issues are created) never revalidates — this is the headline bug |
| `/drafts` | `listDrafts()`, `getGig()` | Covers in-app draft edits | Gap: scheduler auto-draft/auto-fire writes never revalidate |
| `/chat` | none | N/A | **Safe as-is, no fix needed** |
| `/profile-assist` | `readRawConfig()` | **None at all** — confirmed zero `revalidatePath("/profile-assist")` calls anywhere | Gap: a source added via `/config` never appears here without a rebuild |
| `/config` | `readRawConfig()`, `isPortunusAvailable()` | Best-covered — every mutating config action already revalidates | Lower-priority residual gap (out-of-band file edits, Portunus install/uninstall) |

`layout.tsx` (shared by every route) independently reads `listIssues()` and `readRawConfig()` and is embedded in every route's own cache entry — it needs the same treatment.

**The Issues nav badge's apparent freshness is a red herring, not evidence the current model works.** It showed a correct "4" while the page body was stale purely because *other, unrelated* Server Actions (`updateGigStatusAction`, `markSubmittedAction`, etc.) call `revalidatePath("/")`, which happens to also refresh the shared layout's badge count as a side effect — while `/issues` itself never gets revalidated on a new issue. This is an accident, not a working invalidation path, and shouldn't inform the fix.

**`revalidatePath()`/`revalidateTag()` cannot be called from the scheduler at all.** They depend on Next's request-scoped `AsyncLocalStorage` store, which only exists inside a live Server Action/Route Handler/Middleware call within the running Next.js process. `src/scheduler/index.ts` is a separate `tsx`-run Node process with no Next.js runtime — there is no supported way for it to invalidate the cache from outside.

## 3. Approach (Bug 1)

**Mark `/`, `/issues`, `/drafts`, `/profile-assist`, and `layout.tsx`'s own reads as dynamic** (`export const dynamic = "force-dynamic"`), and include `/config` for completeness given it's effectively free. Leave `/chat` untouched (no live data at all).

Rejected alternative: an on-demand revalidation HTTP endpoint that the scheduler calls after each write. Rejected because:
- This is a single-user, `127.0.0.1`-bound, self-hosted app (Electron/Tauri-packaged) — there is no CDN/edge cache in front of these routes for static optimization to actually pay for.
- The underlying reads are cheap local SQLite/file reads — re-running them per request is free in practice.
- Going dynamic fixes both the in-app-forgot-a-revalidatePath-call fragility (`/profile-assist` has zero coverage today) *and* the scheduler's out-of-process-write problem in one uniform move, with no new endpoint to build, secure, or remember to call.

## 4. Root cause (Bug 2) — confirmed via code research

No existing function answers "does source X already have a usable captured session on disk." The one that sounds relevant, `checkCaptureReadiness()` (from the `llm-capture-readiness-check` story), is a *live-browser, LLM-driven* check — it needs an open Playwright `Page` mid-Capture-Login and is wired only into the `CaptureLoginControl`'s "Check if I'm ready" button. It cannot be reused for a passive, always-visible badge in the idle Sources list without spawning a real browser + LLM call per source per page render.

`showsCaptureLogin(source)` (`config-client.tsx:222-225`) is already the correct predicate for "does this source need `browser-session` auth at all" and should gate the badge.

The `<sourceId>-session.json` naming convention is inlined once, in `finishCapture()` (`session-capture.ts:356`), not extracted into a shared helper — worth extracting so both the existing capture-finish code and the new readiness check use one source of truth.

`src/app/config/page.tsx` already computes one live, server-side signal (`isPortunusAvailable()`) and threads it into `ConfigClient` as a plain prop (`page.tsx:57,73` → `config-client.tsx:1223`) — this is the exact precedent to follow for readiness, avoiding a new Server Action/round-trip for the common case.

## 5. Approach (Bug 2)

1. Extract the session-file-path convention into a small shared helper (used by both `finishCapture()` and the new check).
2. Add a lightweight readiness check: local backend → file exists + parses + passes `isStorageStateShape()`; Portunus backend → a probe via the existing Portunus read path. No new LLM/browser involvement.
3. Compute a per-source readiness map in `src/app/config/page.tsx` (same place/pattern as `portunusAvailable`), thread it into `ConfigClient` as a new prop.
4. Render a badge on each source row's top line (`config-client.tsx` ~1888–1967, alongside the existing Enabled/Custom (LLM)/Gmail digest checkboxes): "No login needed" (auth: none) / "Connected" (has session) / "Needs login" (browser-session, no session) — gated on `showsCaptureLogin()`.

Deliberately out of scope: any richer expiry/validity check beyond file-exists + parses + right shape (no cookie-expiry inspection) — flagged as an open question below, not silently decided.

## 6. Risks

- **Dynamic rendering removes the Full Route Cache benefit entirely for these five routes.** Acceptable given the reasoning in §3 (single-user local app, cheap local reads) — flagging so it's an explicit, not silent, tradeoff.
- **Portunus-backed readiness checks are real subprocess spawns** (`portunus session load`-equivalent) — one per portunus-backed source, per `/config` render. Same cost class as the existing `isPortunusAvailable()` call already paid on every `/config` load; not a new category of cost, but additive if many sources use Portunus.
- **A session file that exists and parses correctly can still be expired/invalid** — the badge would say "Connected" for a session that actually fails on next use. This is a real, known limitation (see open question below), not silently glossed over.

## 7. Open questions

1. Is file-exists + parses + right-shape sufficient for "Connected," or should the badge also warn on a session past its cookie expiry (would require new logic — nothing today reads Playwright's `cookies[].expires` field for this purpose)? **Recommendation: ship the simple version now — a wrong "Connected" self-heals the same way scan failures already do (clear error surfaced, not a crash), consistent with this session's `custom-source-recipe.ts` fix. Expiry-awareness can be a fast-follow if it turns out to matter in practice.**
2. Should `/config` be included in the dynamic-rendering fix, given it's already well-covered and the residual gap is narrow (out-of-band file edits, Portunus install/uninstall mid-session)? **Recommendation: yes, include it — the cost is effectively zero and it removes the last static-page edge case entirely, for consistency.**

## 8. Scale assessment

**Medium** — multi-file (5 page.tsx + layout.tsx for Bug 1; a new helper + page.tsx + config-client.tsx for Bug 2), cross-stack (Server Component reads, a new prop-threading path, client-side rendering), but each bug is well-understood and low-risk in isolation. No H/V planning ceremony needed beyond this design discussion — proceeding directly to story decomposition.
