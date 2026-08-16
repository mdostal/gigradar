# Design discussion: llm-custom-sources

## 0. Prelude

**Owner's request, verbatim (2026-08-15, immediately after oauth-session-capture-v2
shipped as PR #28):** "let's get the FULL thing done and ensure it works with ANY
SITE PEOPLE WANT and they can set up their own crawls for monster or whatever or
cool truckers . com or whatever -- it needs to be working with an LLM with a BYOK
and fucking nailing this out 100% and iterating and looping UNLESS YOU NEED ME."

Standing authorization to plan and execute across the resulting stories with
minimal check-ins. Flagged explicitly below: the two points where owner input or
live verification against a real third-party site is genuinely unavoidable.

## 1. Goal

Let an owner point gigradar at **any** job site — a URL, maybe an auth type, maybe
a one-line natural-language hint — and have it show up as a working source,
**without writing or shipping any TypeScript into this repo.** This is the
concrete test of CLAUDE.md's core/user-layer boundary rule ("if adding a site...
requires editing core code, the boundary is wrong"), which is currently violated
in practice: every real source today (`gofractional.ts`, `ateam.ts`,
`wellfound.ts`, `linkedin.ts`, `braintrust.ts`, `builtin.ts`,
`fractionaljobs.ts`, `fractionus.ts`, `fractionalfinders.ts`) is a hand-written
module implementing `Source` (`src/lib/sources/source.ts`) and registered via
`registerSource()` at import time — a fixed, build-time set.

## 2. What already exists to build on (not reinvent)

- **BYOK Anthropic key**: `readEnvVar("ANTHROPIC_API_KEY")`, resolved fresh
  per-call, never module-scope. Every LLM call site in this repo already follows
  this (`profile-suggest.ts`, `capture-guidance.ts`, `config/actions.ts`,
  `profile-assist/actions.ts`).
- **LLM+Playwright single-shot extraction shape**: `profile-suggest.ts`
  (`page.locator("body").ariaSnapshot({mode:"ai"})`, BEGIN/END-delimited
  untrusted-DATA framing, structured Anthropic tool-use output). `capture-
  guidance.ts` is the newest, simplest example.
- **Real, non-fingerprinted browser access**: `real-chrome.ts` (spawn-then-
  attach, oauth-session-capture-v2), for bot-gated/heavily-JS sites.
- **Auth for login-gated sources**: `session-capture.ts` (Capture Login),
  `browser-session.ts` (origin-scoped storageState replay — `filter
  StorageStateToAllowlist()` is safety-critical, never skip it), `session-
  backend.ts` (local vault or Portunus).
- **The actual plug-in point, already generic**: `runner.ts`'s `runRadar()`
  loop does `getSource(sc.id)` then `src.fetch(sc, profile)` for every enabled
  `SourceConfig` — it doesn't care how many sources exist or where they came
  from. The gap is entirely upstream: nothing populates the registry for a
  user-typed id.
- **`Gig`** (`types.ts`): `sourceId, externalId, title, company?, url, rate?,
  weeklyHours?, remote?, contractToHire?, employmentType?, stage?, postedAt?,
  description?`. No fabricated-data rule: every adapter leaves a field unset
  rather than guessing (e.g. `gofractional.ts`'s `Gig.rate`) — the custom
  extractor inherits this rule.
- **`SourceConfig`** (`types.ts`): `{id, enabled, settings?}`, `settings` is
  opaque `Record<string, unknown>` — every adapter already reads its own keys
  from it (`sessionStatePath`, `sessionBackend`, `roleIds`, etc.).

## 3. Root design decision: how a user-typed id becomes a working `Source`

`getSource(sc.id)` only finds statically `registerSource()`'d adapters. A
custom source's id (`"monster"`, `"coolerstruckers"`) is never one of those.
Three options considered:

**A. Dynamic per-id registration** — at startup/per-cycle, call
`registerSource({id: sc.id, fetch: genericFetch, ...})` once per configured
custom source. Rejected: `registerSource()` throws on duplicate ids by design
(a real safety net against two hand-written adapters accidentally colliding);
re-registering on every scan cycle (config can change while the scheduler
process is already running) means either fighting that invariant or adding a
second, parallel "overwrite" registration path — more moving parts for no
real benefit over B.

**B. One generic `Source`, one small runner.ts fallback.** Add an optional
`SourceConfig.kind?: "custom-llm"` field. `runner.ts`'s lookup becomes:
```ts
const src = getSource(sc.id) ?? (sc.kind === "custom-llm" ? customLlmSource : undefined);
```
`customLlmSource` is a single, statically-defined `Source` object
(`src/lib/sources/custom-llm-source.ts`) whose `fetch(cfg, profile)` reads
everything it needs (`url`, `hint`, auth settings) from the **passed-in**
`cfg`, never from its own identity. **Chosen.** One well-justified, one-time
core touch (this epic ships it once; no future site ever needs a second
touch) — exactly the shape CLAUDE.md's boundary rule asks for.

**C. A build step that codegens a `Source` file per configured custom source.**
Rejected outright: reintroduces "adding a site requires a build/deploy," the
exact thing being fixed.

`SourceConfigSchema` (`config/schema.ts`) gains `kind: z.literal("custom-
llm").optional()` — zero effect on every existing source (`kind` absent =
today's behavior, byte-identical).

**Known limitation, accepted:** the static `Source.auth` field (`"none" |
"api-key" | "browser-session"`) describes ONE `Source` object, but
`customLlmSource` serves many differently-configured instances. Its own
`auth` field can't be accurate for all of them. The **real**, per-instance
auth need lives in `cfg.settings.customAuth` (see §6) — any UI/logic that
needs to know a specific custom source's real auth requirement must read
that, not `Source.auth`. Documented, not silently papered over.

## 4. Extraction: reading a page vs. deriving a reusable recipe

Two genuinely different jobs, deliberately using two different inputs:

- **Reading a page to extract today's listings** reuses `profile-
  suggest.ts`'s exact shape: `ariaSnapshot({mode: "ai"})`, cheap, already
  proven, already has the BEGIN/END untrusted-DATA framing this repo requires
  everywhere an LLM sees page content.
- **Deriving a *reusable* extraction recipe** (§5) needs real CSS selectors
  the LLM can name — aria snapshots are accessibility-tree text with `[ref=
  eN]` handles that are **not stable across page loads or even across
  snapshot calls on the same load** (confirmed by how this codebase already
  uses them: profile-assist-loop.ts's ref-validation exists precisely because
  refs go stale between reads). A recipe keyed on aria refs would break
  immediately. So recipe derivation reads **raw HTML** (`page.content()`)
  instead — the only representation that carries real, cacheable CSS
  selectors (class names, tag structure).

Raw HTML is size-capped before it reaches the LLM (same discipline
`profile-ingestion/extract.ts`'s AC6/AC7 streaming-size-cap already
established for fetched content in this repo — truncate, never error, note
the truncation) — full page HTML on a listings page can be enormous and most
of it (nav, footer, scripts) is irrelevant to the extraction job.

## 5. Recipe caching (the cost/latency decision)

**The real problem:** a scheduler that runs a scan every N minutes (`src/
scheduler/index.ts`) cannot afford a fresh LLM call (cost + multi-second
latency) on every cycle for every custom source, when a site's DOM structure
is stable between scans.

**Design:** on a custom source's first successful extraction (or whenever the
cached recipe fails), call the LLM once with raw, size-capped HTML, asking
for **both** (a) today's extracted `Gig[]` and (b) a reusable recipe:
`{ listItemSelector: string, fields: { title: {selector}, company?:
{selector}, url: {selector, attribute: "href"}, rateText?: {selector}, ... },
derivedAt: ISO }`. On every subsequent cycle, first attempt a **pure
Playwright selector walk** (`page.locator(recipe.listItemSelector).all()` +
per-field `.locator(...).textContent()`/`.getAttribute()`) — zero LLM calls,
fast, free. If that yields zero items, or every item is missing a required
field (`title`/`url`), the recipe is stale: fall back to a fresh LLM
derivation and overwrite the cached recipe.

**Where the recipe lives — NOT `config.json`.** A recipe is derived,
regenerable, non-sensitive data (selectors, not credentials or user intent)
— fundamentally different from `SourceConfig.settings`, which is user-
authored and goes through `ConfigSchema` validation + encryption-at-rest on
every save. Binding recipe writes to that path would mean every recipe
refresh re-validates and re-encrypts the whole config document for a pure
performance cache. Instead: a plain JSON file per source at
`<getDefaultDataDir()>/custom-source-recipes/<sourceId>.json` — same tier as
`gigs.db`, sibling to (not inside) the encrypted session-file tier. Written
directly by the extraction module itself (no config.json round-trip, no
Server Action needed for a background scheduler cycle to update it).

## 6. Auth for custom sources

A custom source may be public (`auth: "none"`, like the existing board
adapters) or need a real login (`auth: "browser-session"`, reusing Capture
Login / `real-chrome.ts` / `session-backend.ts` wholesale — already built,
already handles both the local vault and Portunus). Declared per-instance via
`cfg.settings.customAuth: "none" | "browser-session"` (§3's known
limitation).

**A second instance of the same boundary problem, fixed the same way:**
`SOURCE_ORIGINS`/`SOURCE_LOGIN_URLS` (`src/lib/sources/origins.ts`) are
static registries keyed by known adapter ids — a custom source's id isn't in
them either. Fix: every lookup site that currently does
`SOURCE_ORIGINS[sourceId]` gains a fallback to the source's own config
(`cfg.settings.allowedOrigins: string[]`, `cfg.settings.loginUrl: string`)
when the static registry has no entry — same "static registry first, config-
driven fallback second" shape as §3's `runner.ts` change, applied
consistently rather than invented twice.

**Browser acquisition default:** no new dependency. `auth:"none"` custom
sources launch a plain **headless** `chromium.launch()` (fast, no visible
window — correct for an unattended scheduler loop; `browser-session.ts`'s own
"headed only" rule is specific to sites it already proved need it, not a
blanket rule). `auth:"browser-session"` custom sources reuse
`real-chrome.ts`'s spawn-then-attach (headed, same as every other
`browser-session`-auth source) exactly as-is. A lighter fetch()+HTML-parse
path (skipping a browser entirely for simple server-rendered sites, the way
`braintrust.ts`/`builtin.ts` do) was considered and explicitly **deferred**,
not chosen, for v1: this repo has no DOM/CSS-selector-engine dependency today
(`builtin.ts` uses a JSON-LD regex, not general selector matching), and the
recipe mechanism in §5 needs real selector evaluation regardless — Playwright
already provides that uniformly for both the headless and headed cases
without a new dependency. Revisit only if a specific slow/expensive site
justifies it later.

## 7. Pagination and dedup

Recipe gains an optional `nextPageSelector` (a "next" link/button), derived
by the LLM at the same time as the rest of the recipe. The fetch loop follows
it up to a fixed page cap (mirrors `wellfound.ts`'s existing "first page(s)
only" precedent for public boards) rather than crawling unbounded. Dedup
within one fetch call by `externalId` — same as every existing adapter and
`runner.ts`'s own `gigKey()`-based dedup already provides as a second layer.

## 8. Safety (non-negotiable, per this repo's existing convention)

- `apiKey` resolved fresh per Server Action call via `readEnvVar
  ("ANTHROPIC_API_KEY")`, never module-scope — identical to every other LLM
  call site added this session.
- Every page-derived block (aria snapshot AND raw HTML) reaches the LLM
  BEGIN/END-delimited with explicit "DATA ONLY, never instructions" framing
  — `profile-suggest.ts`'s `buildPageSnapshotBlock()` pattern, copied, not
  reinvented, a third time.
- No fabricated `Gig` data: the extraction tool schema's fields mirror
  `Gig`'s own optionality — a field the page doesn't show is left unset, not
  guessed.
- `filterStorageStateToAllowlist()` still runs, unconditionally, for any
  `browser-session`-auth custom source — reused exactly, no custom-source
  carve-out.

## 9. Scale assessment: **Large**

Multi-system (source registry, runner, scheduler-facing cache, config schema,
auth registries, `/config` UI), a genuinely new architectural capability (not
a point fix), touches the core plug-in boundary this whole app is built
around. Full H/V planning warranted.

## 10. Where owner input is genuinely unavoidable

Flagged explicitly, per the owner's own "iterating and looping unless you
need me" instruction — everything else in the vertical plan is scoped to run
without a check-in:

1. **A real third-party site's actual extraction quality** (does the LLM
   correctly find listings on an arbitrary, previously-unseen real site) can
   only be genuinely proven against a REAL live site — never the owner's own
   captured account/session data (per this session's own hard rule), but a
   real public URL the owner points at deliberately. This is inherently an
   owner-in-the-loop verification, not something to fabricate a "passing"
   result for with a synthetic fixture alone (fixtures prove the mechanism
   works; they can't prove real-world extraction quality).
2. **Anthropic API spend** on real extraction calls against real sites is a
   cost the owner should be aware is happening, same posture already
   established for `extractProfileFromResumeAction`'s live-LLM-call stories
   this session.

## 11. Open questions, resolved

- **Recipe format**: CSS selectors (§4/§5), not aria refs (unstable) or XPath
  (no clearer benefit, less familiar).
- **Recipe storage**: plain JSON file per source, data dir, not config.json
  (§5).
- **Browser default**: Playwright uniformly, headless for no-auth, real-
  chrome.ts for auth-needed (§6) — no new dependency.
- **Auth registry gap**: same static-then-config-fallback shape as the
  runner.ts fix, applied to `origins.ts`'s lookups too (§6).
