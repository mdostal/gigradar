# Contributing to gigradar

Thanks for considering it. The short version: read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before touching anything
under `src/lib/` or `src/app/` — it's the design contract for this
codebase, not optional background reading.

## The one rule that matters most

**Core stays generic.** `src/lib/*` and `src/app/*` must never know
anything about any specific user — no personal data, no private adapters,
no hardcoded criteria/credentials. If adding a source, changing a rate
rule, or wiring a scraper requires editing core code, the boundary is
wrong; fix that before adding the feature. See `CLAUDE.md`'s "core/user-layer
boundary" section for the full contract.

## Adding a new source

The most common contribution shape. A `Source` is
`{ id, label, auth, fetch(cfg, profile, apiKey?) → Gig[] }`, registered via
`registerSource()` — see any adapter under `src/lib/sources/` for a real
example, and `src/lib/sources/example-source.ts` for an annotated
template. `fetch()` must return real per-listing URLs, never a search-page
URL. Add tests alongside the adapter (`src/lib/sources/__tests__/`) using
fixture HTML/JSON, never live network calls.

## Before opening a PR

```
npm test
npm run typecheck
```

Both must pass — `npm test` runs the vitest suite (no live network calls),
`npm run typecheck` runs `tsc --noEmit`. For UI changes, run `npm run dev`
and actually exercise the feature in a browser before calling it done.

## Secret handling

Never log, return, or serialize a resolved secret value, anywhere.
`config.json` only ever stores `"env:VAR_NAME"` references; only
`loadConfig()` resolves those to real values, and its output must never be
echoed back, written to disk, or included in an error message. See
`CLAUDE.md`'s "Secret handling" section for the full mechanism — if you're
touching anything that reads `Config`, check whether you actually need
`loadConfig()`'s resolving read or the raw, unresolved
`readRawConfig()` (the answer is almost always the latter).

## Questions / discussion

Open an issue, or see the README's "Support this project" section for
other ways to reach the maintainer.
