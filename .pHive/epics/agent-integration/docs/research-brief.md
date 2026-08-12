# Research Brief: agent-integration

## 1. Summary

Two related pieces so an AI agent (Claude Desktop, Claude Code, or any
other MCP client) can both develop AND actually use a running gigradar
instance: (1) a `CLAUDE.md` — this repo has never had one, `docs/ARCHITECTURE.md`
has carried that role alone since kickoff; (2) a real MCP server
(`@modelcontextprotocol/sdk`, confirmed available at v1.30.0) exposing
gigradar's own store/config functions as tools — list/filter gigs, get one
gig, change its status, trigger a scan, read profile/config status —
reusing the exact functions the dashboard and CLI already call, not a new
parallel implementation.

## 2. Key files & surfaces

- `src/lib/store/gigs.ts` — `listGigs(filter)`, `getGig(key)`,
  `setStatus(key, status)`: the exact functions the dashboard's Server
  Actions already call. An MCP server's tools should call these directly,
  not re-derive query logic.
- `src/lib/apply/runner.ts` — `runRadar(config)`: the same function
  `npm run radar` and the (now-fixed) CLI entrypoint use.
- `src/lib/config/load.ts` / `save.ts` — `loadConfig()`/`readRawConfig()`:
  the config summary an MCP tool would read. Same secret-handling rules
  apply here as everywhere else in this project — an MCP tool must never
  return a resolved secret value.
- `docs/ARCHITECTURE.md` — the design contract `CLAUDE.md` should point
  to, not duplicate.
- No `.claude/` skill or command content exists in this repo today (only
  an unrelated `scheduled_tasks.lock` file).

## 3. Patterns & conventions

- MCP servers are a well-established, simple pattern: a small
  `@modelcontextprotocol/sdk` `Server` instance over stdio transport,
  declaring `tools` with a name/description/input schema and a handler.
  No new dependency risk — one official, actively maintained SDK package.
  Runs as its own local process (`npm run mcp`), separate from the Next.js
  dev/prod server — an agent (e.g., Claude Desktop) launches it directly
  via its own MCP client config, it isn't served over HTTP.
- This project already has a hard rule (repeated in every epic that
  touches `Config`): never log, return, or otherwise surface a resolved
  secret value. An MCP tool that returns "profile/config status" must use
  the SAME non-resolving reader (`readRawConfig()`) the dashboard's status
  strip already uses — never `loadConfig()`, which resolves `env:`
  references to real secret values.
- `runRadar()` is a real, potentially slow, real-network operation (each
  live source's `fetch()`/browser session). An MCP "run a scan" tool needs
  to set expectations about that (it's not instant), but needs no new
  mechanism — it's the exact same call the CLI already makes.

## 4. Constraints

- **Never let an MCP tool become a second, parallel secret-handling path.**
  Every tool that touches `Config` must go through the exact same
  non-resolving readers the rest of the app already uses — no new
  resolution logic invented for this surface.
- **Single-user, local-only posture holds here too.** The MCP server talks
  to the SAME local SQLite DB and config files a given install already
  has — it's another local client of the same local state, not a new
  network service. No auth layer needed (same trust boundary as the
  Next.js dev server's own `127.0.0.1`-only binding), but it should NOT
  bind to any network port at all — stdio transport only, so there's no
  listening socket to worry about in the first place.
- `runRadar()` requires `Config` to be loaded first (`loadConfig()`) —
  same first-run/missing-config-file error behavior as the CLI; an MCP
  tool calling it should surface that error clearly to the agent, not
  swallow it.

## 5. Risks

- **Low — an MCP tool accidentally using `loadConfig()` instead of
  `readRawConfig()` for a "show me my config" query would leak a resolved
  secret to whatever agent is connected.** Concrete, testable: assert the
  MCP server's config-summary tool never returns a value where an
  `env:`-prefixed string was in the raw file.
- **Low — new dependency surface** (`@modelcontextprotocol/sdk`) — official,
  widely used, low risk, same class of decision as `@anthropic-ai/sdk`
  earlier this session.
- **Low — `run_scan` tool exposes a real, slow, real-network-calling
  operation to an agent** — needs a stated timeout/expectation, not a
  blocking design problem.

## 6. Open questions

1. Which tools exactly? Leaning: `list_gigs` (filtered by tier/status/
   search), `get_gig`, `update_gig_status`, `get_status_summary` (sources
   configured / profile complete / last scan — same data the dashboard's
   status strip already computes), `run_scan`. Assisted-apply drafting
   (`stageApplication`) is still an unimplemented TODO in the core itself
   — no MCP tool can expose it yet.
2. Where does the MCP server live in the repo — a new top-level
   `src/mcp/` directory, parallel to `src/lib`/`src/app`? Leaning: yes,
   its own directory, since it's a third "layer" (a client of `src/lib`,
   like `src/app` is, but a different kind of client).
