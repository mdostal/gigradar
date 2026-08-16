# Vertical plan: llm-custom-sources

Four slices. Slice 1 alone already closes the core ask (a custom, no-auth
site works with zero code) — Slices 2-4 are independently valuable
enhancements on top of it.

## Slice 1 — Core custom-source mechanism (no auth, no recipe caching yet)

- `SourceConfig.kind?: "custom-llm"` (`types.ts`) + `SourceConfigSchema`
  (`config/schema.ts`).
- `src/lib/sources/custom-llm-source.ts`: `customLlmSource: Source`.
  `fetch(cfg, profile)` reads `cfg.settings.url` (required) + `cfg.settings
  .hint` (optional NL description), launches headless `chromium.launch()`,
  reads the page's AI-mode aria snapshot, asks the BYOK LLM (single-shot,
  `profile-suggest.ts`'s exact call shape) to extract a `Gig[]`-shaped list —
  no recipe/caching yet, a fresh LLM call every fetch. No fabricated data;
  `Gig.sourceId`/`externalId`/`url` always real per-listing values, never
  guessed.
- `runner.ts`: `getSource(sc.id) ?? (sc.kind === "custom-llm" ?
  customLlmSource : undefined)`.
- `/config`: minimal "Add custom source" support — a source row with
  `kind: custom-llm` can be typed directly into the existing Settings
  key/value editor (`url`, `hint`) without a dedicated UI yet; a real
  dedicated add-source UI lands in Slice 4.

**Working state:** an owner adds a `{id: "monster", kind: "custom-llm",
settings: {url: "..."}}` source entry, `npm run radar`/the scheduler fetches
real listings from it via the BYOK LLM — zero TypeScript written, zero PR to
gigradar core. This is the concrete proof the core/user-layer boundary is
fixed. **Owner-verified live against a real site** (§10 point 1 in the design
discussion) before calling this slice done.

## Slice 2 — Extraction-recipe caching (cost/latency)

- `src/lib/sources/custom-source-recipe.ts`: recipe type, `readRecipe
  (sourceId)`/`writeRecipe(sourceId, recipe)` (plain JSON file at
  `<getDefaultDataDir()>/custom-source-recipes/<sourceId>.json`),
  `extractWithRecipe(page, recipe): Promise<Gig[] | null>` (Playwright
  selector walk, `null` on zero-items-or-missing-required-fields), `derive
  RecipeAndExtract(page, sourceId, hint, apiKey): Promise<{gigs, recipe}>`
  (raw `page.content()`, size-capped, single-shot LLM call producing both).
- `custom-llm-source.ts`'s `fetch()` rewired: try `extractWithRecipe()`
  first when a cached recipe exists; fall back to `deriveRecipeAndExtract()`
  (and overwrite the cache) on `null` or no cached recipe.

**Working state:** a re-scanned custom source with a stable DOM makes zero
LLM calls after its first successful scan; a layout change is detected
(empty/malformed extraction) and self-heals via one fresh LLM call.

## Slice 3 — Auth for custom sources

- `origins.ts`'s lookup sites (`SOURCE_ORIGINS[id]`, `SOURCE_LOGIN_URLS[id]`)
  gain a config-driven fallback (`cfg.settings.allowedOrigins`,
  `cfg.settings.loginUrl`) when the static registry has no entry.
- `custom-llm-source.ts` branches on `cfg.settings.customAuth` ("none"
  default, or "browser-session"): the browser-session path reuses
  `real-chrome.ts` + `browser-session.ts`'s `readStorageStateFile()`/
  `filterStorageStateToAllowlist()` (or `session-backend.ts`'s Portunus path)
  exactly as the built-in adapters already do — no new auth mechanism.
- Capture Login (`config-client.tsx`'s `CaptureLoginControl`) extended to
  show for any `kind: "custom-llm"` source with `customAuth: "browser-
  session"`, not just the static `SOURCE_ORIGINS` keys.

**Working state:** an owner can add a login-gated custom source, Capture
Login it exactly like GoFractional/A.Team/Wellfound today, and it fetches
authenticated listings.

## Slice 4 — Pagination + real `/config` UI

- Recipe gains `nextPageSelector`; `custom-llm-source.ts`'s fetch loop
  follows it up to a fixed page cap.
- `/config` gains a real "Add custom source" form (URL, optional hint,
  auth-type picker, optional "test extraction now" preview button that runs
  Slice 1/2's extraction once and shows the result before saving) — not the
  raw Settings key/value editor Slice 1 shipped with.

**Working state:** all four slices done — epic complete. Adding a brand-new
site is a form fill, not a code change, end to end.
