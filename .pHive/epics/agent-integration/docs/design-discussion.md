# Design Discussion: agent-integration

## 0. Prelude

**NORTH STAR**: the owner wants any AI agent (Claude Desktop, Claude Code,
or another MCP client) to be able to both develop gigradar AND actually
use a running instance as a tool — "check my gigs," "mark this one
applied," "run a scan" — without hand-rolling API calls.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

1. **`CLAUDE.md`** at repo root — orients a Claude Code session working
   on this codebase: points to `docs/ARCHITECTURE.md` as the design
   contract, states the core/user-layer boundary, the secret-handling
   rule, and the test/typecheck commands. Short — a pointer, not a
   duplicate of ARCHITECTURE.md.
2. **A real MCP server** (`src/mcp/server.ts`, new `src/mcp/` directory) —
   `@modelcontextprotocol/sdk`, stdio transport, five tools:
   `list_gigs`, `get_gig`, `update_gig_status`, `get_status_summary`,
   `run_scan`. Each tool is a thin wrapper calling the EXACT SAME
   `src/lib` functions the dashboard/CLI already use — no parallel logic.
   Runs as `npm run mcp`, a separate local process from the Next.js
   server, launched directly by whatever MCP client (Claude Desktop's
   config, Claude Code's `.mcp.json`, etc.) the user points at it.

"Done": a Claude Code session opening this repo has enough context from
`CLAUDE.md` alone to know where to look; a user can point Claude Desktop
(or any MCP client) at `npm run mcp` and ask it to list/update/scan their
real gigs, with no secret value ever crossing that boundary.

## 2. What I Found

- `src/lib/store/gigs.ts`'s `listGigs()`/`getGig()`/`setStatus()` and
  `src/lib/apply/runner.ts`'s `runRadar()` are exactly the functions
  needed — already tested, already the single source of truth the
  dashboard and CLI both use.
- `readRawConfig()` (never `loadConfig()`) is the established
  non-resolving reader every UI-layer consumer already uses for "show
  config status without secrets" — the MCP server's `get_status_summary`
  tool follows the identical rule.
- `@modelcontextprotocol/sdk` is a real, current (v1.30.0), actively
  maintained package — confirmed available, not assumed.
- No `.claude/` skill/command content or `CLAUDE.md` exists in this repo
  today.

## 3. My Proposed Approach

1. **`CLAUDE.md`** (root): a short pointer document — project one-liner,
   "read `docs/ARCHITECTURE.md` before touching core," the core/user-layer
   boundary rule stated plainly, the secret-handling rule (never log/return
   a resolved secret), and `npm test`/`npm run typecheck` as the standard
   verification commands. Explicitly NOT a duplicate of ARCHITECTURE.md's
   content — a pointer + the handful of rules an agent needs before its
   first edit.
2. **`src/mcp/server.ts`** — new file, new `@modelcontextprotocol/sdk`
   dependency, `npm run mcp` script. Five tools, resolved from research
   brief open question #1:
   - `list_gigs({tier?, status?, search?})` → wraps `listGigs()`.
   - `get_gig({key})` → wraps `getGig()`.
   - `update_gig_status({key, status})` → wraps `setStatus()`. **Enum
     enforced at the tool boundary (added post-grill, resolves H1
     below)**: `GigStatus` is a TypeScript compile-time type — confirmed
     by code read, `setStatus()` itself does zero runtime validation, and
     TS types are erased once a value crosses the MCP JSON boundary. This
     tool's own input schema (the MCP SDK's JSON-schema tool definition)
     restricts `status` to the exact real enum values (`"new" | "applied"
     | "interview" | "archived" | "ignored"`), rejecting anything else
     BEFORE `setStatus()` is ever called — independent of whether the
     pre-existing, separately-tracked Server Action gap (task #40) ever
     gets fixed.
   - `get_status_summary({})` → sources configured / profile complete /
     last scan time — the SAME computation, fed by `readRawConfig()` and
     `listGigs()`, never `loadConfig()`. **Layering corrected (added
     post-grill, resolves H2 below)**: `computeStatusStrip()` and its
     helpers move from `src/app/status-strip.ts` into
     `src/lib/status/status-strip.ts` (confirmed framework-free pure TS,
     safe to relocate) — `src/app`'s dashboard and `src/mcp`'s tool both
     import from that one neutral location, avoiding an unexamined
     sideways `src/mcp → src/app` dependency between two separate
     "client of `src/lib`" layers.
   - `run_scan({})` → wraps `runRadar(loadConfig())` — this ONE tool is
     the only one allowed to call `loadConfig()`, since running the actual
     scan genuinely needs resolved secrets to authenticate; its result
     summary (passed count, per-source errors) never includes a secret
     value, only counts/messages. **Source registration added
     (collaborative-review finding, real gap)**: `runner.ts`'s CLI path
     dynamically imports the 4 built-in adapters INSIDE `main()`
     specifically to populate the `registerSource()` registry (see that
     file's own comment on why it's not a top-level import). `run_scan`
     needs the identical registration — done ONCE at `src/mcp/server.ts`'s
     process startup (not per-call, since the MCP server is a long-lived
     process, unlike the one-shot CLI), or every `run_scan` call would
     silently fail every configured source with "no such registered
     source."
   - **Error boundary (collaborative-review finding)**: every tool handler
     wraps its `src/lib` call in a try/catch and returns a clean MCP tool
     error response on failure (e.g. `loadConfig()` throwing on a missing
     config file, `setStatus()` throwing on an unknown key) — never lets
     an uncaught exception crash the stdio process itself.
   - **`key` format documented at the tool boundary (collaborative-review
     finding)**: `get_gig`/`update_gig_status`'s JSON-schema `key`
     parameter description states explicitly "the opaque `key` field from
     `list_gigs`'s output" — never implying an agent should construct
     `${sourceId}:${externalId}` itself.
3. **`src/mcp/` is its own directory**, parallel to `src/lib`/`src/app` —
   resolves research brief open question #2. It's a third kind of client
   of `src/lib`, structurally like `src/app`'s Server Actions but over
   MCP instead of HTTP/RSC.
4. **Stdio transport only, no network port** — matches research brief §4's
   constraint: this is another local client of the same local state, not
   a new network service. No listening socket at all — the real trust
   boundary is "whoever can spawn this process and read its stdio" (local
   process-execution rights), a tighter boundary than the Next.js server's
   own `127.0.0.1`-only network binding, not merely the same one.
5. **A copy-pasteable client config, shipped (added post-grill, resolves
   U1 below).** The epic's own north star is the owner actually using a
   running instance, not just being theoretically able to — so `CLAUDE.md`
   includes a short "Using gigradar as an MCP tool" section with the exact
   JSON snippet for both Claude Desktop's `claude_desktop_config.json` and
   Claude Code's `.mcp.json`, naming the real `npm run mcp` command. One
   copy-paste, not a reverse-engineering exercise.

## 4. What Could Go Wrong

- **High (if wrong) — `get_status_summary` accidentally using
  `loadConfig()` instead of `readRawConfig()` would leak a resolved secret
  to whatever agent is connected.** Mitigation: dedicated test asserting
  the tool's output never contains a value that was an `env:`-prefixed
  reference in the raw config — the exact same class of test this
  project has run for every config-touching feature this session.
- **Medium — `run_scan` is a real, slow, network-calling operation exposed
  to an agent that might call it repeatedly/impatiently.** Mitigation: the
  tool's description explicitly states it's slow and network-bound (sets
  the calling agent's expectations); no retry/rate-limiting added here —
  that's the same deferred scope as the adapter-batch epic's backoff
  discussion, not duplicated.
- **Low — `CLAUDE.md` drifting out of sync with `docs/ARCHITECTURE.md`
  over time.** Mitigated by keeping it a pointer + a short, stable rule
  list, not a mirror of content that changes per epic.

## 5. Dependencies and Constraints

- New dependency: `@modelcontextprotocol/sdk`.
- Depends on every prior epic's `src/lib` functions (store, config,
  runner) — read-only dependency, no changes needed to any of them.
- No changes to the Next.js app at all — this is a fully separate,
  additive surface.

## 5a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/agent-integration/docs/grill-record.md`,
`unresolved_count: 3`) surfaced 3 findings, all resolved:

- **H1** (`update_gig_status` had no runtime status validation) — resolved
  in §3 step 2: the MCP tool's own JSON-schema input definition enforces
  the real `GigStatus` enum, independent of the pre-existing Server Action
  gap.
- **H2** (unexamined `src/mcp → src/app` sideways import) — resolved in
  §3 step 2: the shared status-strip logic moves to `src/lib`, so both
  layers import from one neutral location.
- **U1** (the epic's "done" bar didn't actually ship a way to connect) —
  resolved in §3 step 5: `CLAUDE.md` ships the exact, copy-pasteable
  client config for both Claude Desktop and Claude Code.

## 5b. Collaborative Review Findings Addressed

One backend-implementation review, run against the grill-revised draft,
confirmed the `status-strip.ts` relocation is clean (single caller, single
test file, zero hidden `src/app` coupling) and surfaced 4 concrete gaps —
all resolved:

- `run_scan` needed the same source-registration step `runner.ts`'s CLI
  path just added — done once at server startup, §3 step 2.
- Every tool handler needs an explicit error boundary so a thrown
  `src/lib` error becomes a clean MCP error response, not a crashed
  process — §3 step 2.
- `get_gig`/`update_gig_status`'s `key` parameter needed its format
  documented at the tool boundary (opaque, from `list_gigs`, never
  agent-constructed) — §3 step 2.
- The exact `@modelcontextprotocol/sdk` API shape (Server class, stdio
  transport wiring, JSON-Schema enum enforcement) could not be verified
  by the reviewer (package isn't installed yet, no live docs access) —
  flagged as an implementation-time task, not a design blocker: the first
  story must pin the real API against the installed package before all 5
  tools are built against assumed shapes.

## 6. Open Questions

1. ~~Which tools?~~ — **resolved**: the 5 listed in §3 step 2.
2. ~~Where does the server live?~~ — **resolved**: `src/mcp/`, §3 step 3.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; @modelcontextprotocol/sdk (new)
  Platforms: Node.js
  Automated: unit tests for each of the 5 tools against a temp DB/config
    (same XDG_DATA_HOME/XDG_CONFIG_HOME test-isolation pattern this
    project already uses everywhere) — covers correct wrapping of the
    underlying src/lib functions, and the dedicated secret-leak regression
    test on get_status_summary (an env:-referenced value in a test
    config.json must never appear in that tool's output). run_scan tested
    against a config with only auth:"none" sources (no real network
    dependency in the automated suite, matching this project's existing
    convention).
  Manual: point a real MCP client (Claude Desktop or `claude mcp` CLI
    testing) at `npm run mcp`, confirm all 5 tools appear and work against
    the owner's real local data.
  Not verifying: assisted-apply drafting (stageApplication is still an
    unimplemented core TODO, out of scope until that lands).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~8-10 (CLAUDE.md, new src/mcp/server.ts + tests,
    package.json script + dependency, docs/ARCHITECTURE.md pointer update)
  Subsystems: new MCP integration layer only — zero changes to src/lib or
    src/app
  Migration required: no — purely additive
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Small-Medium, story-decompose directly, skip H/V
  RATIONALE: Every tool is a thin, direct wrapper around already-tested
    src/lib functions — the actual new-code surface is small. The one
    real risk (secret leakage via the wrong reader) is narrow and already
    has a named, testable mitigation. No structural unknowns remain.
```
