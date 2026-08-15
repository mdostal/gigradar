# CLAUDE.md

gigradar is an open-source tool suite that finds and helps you interact with
fractional/contract engagements: you configure your profile, needs, and
sources; it scans, gates, tiers, and tracks matching gigs, and assists
(never auto-submits) your applications.

**Read `docs/ARCHITECTURE.md` in full before touching anything under
`src/lib/` or `src/app/`.** It is the design contract for this codebase —
this file is just a pointer to it, not a summary of it.

## The core/user-layer boundary

This repo (`src/lib/*`, `src/app/*`) is generic OSS core: it must know
nothing about any specific user — no personal data, no private adapters, no
hardcoded criteria. Anything specific to one person (their `Config`,
credentials/session files, private `Source`/apply adapters) lives in *their
own* storage outside this repo, and only ever plugs into the core through
config or a registered plugin. The test for whether you've broken this
boundary: if adding a site, changing rate rules, or wiring a private scraper
requires editing core code, the boundary is wrong — fix that before adding
the feature. See `docs/ARCHITECTURE.md` for the full contract (`Source`,
`Profile`, `Needs`, `Gig`, etc.).

## Secret handling

**Never log, return, or serialize a resolved secret value — anywhere.**
`config.json` only ever stores `"env:VAR_NAME"` references, never raw
values; only `loadConfig()` resolves those references to real values (for
the pipeline runner), and its resolved output must never be echoed back,
written to disk, or included in an error message. Every other read path
(`readRawConfig()`, the config UI, the MCP server's tools other than
`run_scan`) works with the raw, unresolved document. If you're adding code
that touches `Config`, check which of the two reads it needs — resolving is
the exception, not the default. See `docs/ARCHITECTURE.md`'s "Secrets"
section for the full mechanism.

## Verification

Before considering any change done:

```
npm test
npm run typecheck
```

Both must pass. `npm test` runs the vitest suite (no live network calls);
`npm run typecheck` runs `tsc --noEmit`.

## Runtime modes: browser, Electron, or a packaged Tauri app

`npm run dev` / `npm run build && npm run start` — the default, unchanged
browser mode. `npm run electron` — same app in a native desktop window
(spawns `npm run start` as a child process; server code never runs inside
Electron's own process). See `docs/ARCHITECTURE.md`'s "Two runtime modes"
section for the full mechanism.

A third mode, a true double-clickable `.app`/`.dmg` (`src-tauri/`, `npx
tauri dev` / `npx tauri build`), packages the same server into a bundled
Node sidecar with real signed auto-update (dev/prod channel toggle via a
native tray menu) — see `docs/ARCHITECTURE.md`'s roadmap entry for the
`tauri-installer` epic and `.github/workflows/tauri-release.yml` for the
release pipeline.

## Using gigradar as an MCP tool

gigradar ships an MCP server (`src/mcp/server.ts`, run via `npm run mcp`)
exposing 5 tools over stdio: `list_gigs`, `get_gig`, `update_gig_status`,
`get_status_summary`, `run_scan`. See
[`docs/mcp-setup.md`](docs/mcp-setup.md) for copy-pasteable client config
for both Claude Desktop and Claude Code.
