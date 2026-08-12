# Using gigradar as an MCP tool

gigradar ships an MCP server (`src/mcp/server.ts`) that exposes 5 tools over
stdio, so any MCP client — Claude Desktop, Claude Code, or another agent —
can list/inspect/update your tracked gigs and trigger a scan without
hand-rolling API calls.

Run it directly with:

```
npm run mcp
```

(This runs `NODE_OPTIONS=--experimental-sqlite tsx src/mcp/server.ts` — see
the `mcp` script in `package.json`.) You don't normally run this yourself;
your MCP client (below) starts and stops the process for you.

## The 5 tools

Exactly as registered in `src/mcp/server.ts`:

- **`list_gigs`** — List tracked gigs, optionally filtered by role-area tier, pipeline status, and/or a case-insensitive text search over title+company.
- **`get_gig`** — Fetch a single tracked gig by its key.
- **`update_gig_status`** — Set a tracked gig's pipeline status (e.g. mark it 'applied' after you apply).
- **`get_status_summary`** — A glance-level dashboard status: how many sources are configured (and how many need attention), whether the profile is complete, and when the last scan ran. Never includes a resolved secret value.
- **`run_scan`** — Runs one radar scan across every enabled, configured source. Slow and network-bound — don't call it repeatedly in a tight loop.

## Claude Desktop (`claude_desktop_config.json`)

Location: `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Claude
Desktop isn't launched from your repo, so give `npm` an explicit `--prefix`
pointing at your gigradar checkout — replace `/absolute/path/to/gigradar`
with your actual clone path:

```json
{
  "mcpServers": {
    "gigradar": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/gigradar", "run", "mcp"]
    }
  }
}
```

Restart Claude Desktop after saving.

## Claude Code (`.mcp.json`)

Location: `.mcp.json` at the root of your gigradar checkout (project-scoped
— commit it to share with your team, or keep it local). Since Claude Code
runs from the project directory itself, no explicit path is needed:

```json
{
  "mcpServers": {
    "gigradar": {
      "command": "npm",
      "args": ["run", "mcp"]
    }
  }
}
```

Run `claude` inside the repo and approve the server when prompted (`/mcp`
to check status).

## Config and secrets

Neither snippet needs an `env` block: `npm run mcp` reads your gigradar
`config.json`/`.env` from your XDG data directory itself (see
`docs/ARCHITECTURE.md`'s "Config loading" section) — nothing is passed
through the MCP client config. Set up `config.json` first (`npm run dev`
then visit `/config`, or hand-edit per "How to configure gigradar" in
`docs/ARCHITECTURE.md`) before expecting `run_scan` or `get_status_summary`
to return anything meaningful.
