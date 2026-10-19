# Pantheon adapter

When gigradar runs as a Pantheon plugin, Pantheon drives it through a small
HTTP API on gigradar's own port, under `/api/pantheon/*`. The adapter can
trigger a radar run, report run status, return the shortlist with the gate's
reasons, and **stage** a draft. It cannot approve, fire, or submit an
application, and no route for any of those exists.

The code is in `src/lib/pantheon/` (logic) and `src/app/api/pantheon/`
(route handlers). The only service it calls is Pantheon's core-api.

## Auth

Every request must send Pantheon's operator token:

```
x-pantheon-operator-token: <token>
```

gigradar resolves the expected token through Pantheon's secrets facade
(below) using Pantheon's own selector, `provider=pantheon,kind=operator-token`.
It re-resolves at most once a minute and keeps the last good token if a
refresh fails. A missing or wrong token gets `401`. If the token has never
resolved, every request gets `503`. The adapter fails closed and never
serves an unauthenticated request.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/pantheon/runs` | Starts a run in the background (`runRadar()`, the same pipeline `npm run radar` runs). Returns `202 {run}`. If a run is already going, returns `409 {error, run}` with that run. |
| `GET` | `/api/pantheon/runs` | The latest run: `{run}`. `404` before the first run. |
| `GET` | `/api/pantheon/runs/:id` | One run: `{run}`. |
| `GET` | `/api/pantheon/shortlist[?runId=]` | `{run, passed[], rejected[]}` for the given run, or the latest **succeeded** run. Returns `409` for a run that hasn't succeeded. |
| `POST` | `/api/pantheon/drafts` | Body `{key, runId?, resumeId?}`. Stages a draft for a gig that made that run's shortlist and returns `201 {draft}`. The draft stays `draft` until a human approves it in `/drafts`. |

A `run` is `{id, status, startedAt, finishedAt, sourcesTotal, passedCount,
rejectedCount, newCount, errors[], error}`. `status` is one of `running`,
`succeeded`, `failed` (config or credentials failed to load, or the run
threw; `error` says why), or `interrupted` (the process restarted
mid-run). `errors[]` lists each source that failed (`{sourceId, message}`)
inside a run that otherwise succeeded. A source that errored is reported
there; it never shows up as zero results.

Each shortlist gig has the fields `key`, `sourceId`, `externalId`, `title`,
`company`, `url`, `tier`, `matchBand`, `score`, `pass`, `reasons`, `checks`,
`status`, and `unavailableSince`:

- `reasons` is exactly what `runRadar()` returned for that gig, in order.
  It holds every gate rule (`✓ …` / `✗ …`) followed by the tiering note.
- `checks` is the same list with each line tagged `pass` (`✓`), `fail`
  (`✗`), or `info` (anything else). The text is unchanged.
- `status` is the gig's current pipeline status in the store, which may
  have changed since the run.

`Gig.raw` (the source's original payload) is never returned.

The reasons come from the run that produced them, stored per run in
`adapter_runs`/`adapter_run_results`. They are not recomputed on read, so
a config edit made after a run can't change what that run reported.

## Credentials: the secrets facade

Credentials are not read from a committed file or a baked env. Before each
run, gigradar asks core-api for them:

```
POST $PANTHEON_CORE_API_URL/api/secrets/inject
{"tags": "<selector>", "target": "file", "path": "$PANTHEON_SECRETS_SHARED_DIR/gigradar-<uuid>.env",
 "format": "env", "key": "<VAR>"}
```

It then reads `VAR=value` from that file and deletes the file. Values are
never logged, returned, or put in an error message.

| Env var | Default | Meaning |
|---|---|---|
| `PANTHEON_CORE_API_URL` | `http://core-api:3012` | core-api base URL (the compose-network hostname) |
| `PANTHEON_SECRETS_SHARED_DIR` | `/pantheon-secrets` | the shared `pantheon-secrets` volume, which gigradar's container must mount |
| `GIGRADAR_PANTHEON_SECRETS` | unset | `;`-separated `VAR=selector` mappings, e.g. `ANTHROPIC_API_KEY=provider=anthropic,kind=api-key;BRAINTRUST_API_KEY=provider=braintrust`. Each entry splits on its first `=`. |

Each mapped value is resolved fresh for every run, so a rotation takes
effect on the next run. For that run it overrides `.env`:

- It satisfies `config.json`'s `"env:VAR"` references. It is overlaid on
  `process.env` only for the `loadConfig()` call, then restored.
- It also supplies the LLM credential (`resolveLlmCredential()`).

If any mapped secret fails to resolve, the run fails. It never runs with a
partial set of credentials.

## Why HTTP and not the MCP server

`src/mcp/server.ts` speaks MCP over **stdio**. A client has to spawn it as
a child process, which core-api can't do across containers. Its `run_scan`
also waits for the whole scan and returns only counts, so the gate's
reasons never reach the caller. The adapter is HTTP on the app's own port
for both reasons. The MCP server is unchanged and still serves local agent
clients (Claude Desktop/Code).
