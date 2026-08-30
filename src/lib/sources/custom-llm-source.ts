// llm-custom-sources epic, custom-source-core-mechanism +
// custom-source-recipe-caching + custom-source-auth stories. THE core
// mechanism that fixes CLAUDE.md's core/user-layer boundary rule for real:
// an owner can point gigradar at ANY job site by adding a config entry with
// `kind: "custom-llm"` — no TypeScript, no PR to this repo. See
// .pHive/epics/llm-custom-sources/docs/design-discussion.md §3 for why this
// is ONE generic Source object (not per-id dynamic registerSource() calls,
// not codegen) and runner.ts's ONE lookup-fallback line, not a second entry
// point.
//
// NOT registered via registerSource() — deliberately absent from the
// registry every hand-written adapter lives in. runner.ts routes to this
// object directly when `sc.kind === "custom-llm"`, bypassing getSource()
// entirely (see runner.ts's own comment at that call site).
//
// TWO BROWSER-ACQUISITION PATHS, chosen by `settings.customAuth`:
//   - "none" (default): plain headless `chromium.launch()` — nothing here
//     has been shown to need a visible window or bot-detection workaround,
//     and headless is materially cheaper for an unattended scheduler loop.
//   - "browser-session": reuses `withBrowserSession()` (browser-session.ts)
//     — the SAME fetch-time mechanism gofractional.ts/ateam.ts/wellfound.ts
//     already use for an authenticated read (origin-scoped storageState
//     replay, local vault OR Portunus via sessionBackendFrom()). This is a
//     deliberate refinement over design-discussion.md §6's initial guess
//     of reusing real-chrome.ts here: real-chrome.ts's spawn-then-attach is
//     specifically for the LOGIN/CAPTURE moment (session-capture.ts /
//     assist-session.ts, where a live OAuth handshake happens) — replaying
//     an already-captured session at FETCH time is exactly what
//     withBrowserSession() already does for every other browser-session
//     adapter, so reusing it here (not a second, parallel mechanism) is
//     what "no new auth mechanism" (this story's own description) actually
//     means. Custom sources' Capture Login flow (config/actions.ts's
//     startCaptureAction()) still goes through session-capture.ts's real
//     Chrome spawn-then-attach, unchanged.
//   `withBrowserSession()` has no source-specific "am I really signed in"
//   page-shape check available for an arbitrary custom site, unlike
//   gofractional.ts's isAuthenticatedGoFractional() — `isAuthenticated`
//   here is unconditionally `true`. An actually-expired session simply
//   yields an empty/malformed extraction (self-heals the recipe cache, or
//   surfaces via a real error), not a distinct "needs login" failure mode.
//
// CACHED-RECIPE FAST PATH FIRST, LLM DERIVATION AS FALLBACK
// (custom-source-recipe-caching story, design-discussion.md §5): every
// fetch() call tries custom-source-recipe.ts's extractWithRecipe() against
// a previously-cached recipe first — zero LLM calls on a cache hit. Only on
// a cache miss (first scan) or a stale recipe (extractWithRecipe() returns
// null) does this fall back to deriveRecipeAndExtract(), which ALSO
// overwrites the cache with a freshly-derived recipe. All extraction logic
// (the tool schema, no-fabricated-data discipline, prompt-injection
// delimiting) lives in custom-source-recipe.ts — this file is just the
// cache-then-fallback orchestration plus the Source/auth wiring.
import { chromium, type Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, Profile, SourceConfig } from "../types.js";
import { deriveRecipeAndExtract, extractWithRecipe, followPagination, readRecipe, writeRecipe } from "./custom-source-recipe.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom } from "../auth/session-backend.js";
import { resolveAllowedOrigins } from "./origins.js";
import type { LlmCredential } from "../config/env-store.js";

const MODULE_PREFIX = "gigradar custom-llm-source";

function urlFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.url;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      `${MODULE_PREFIX}: source "${cfg.id}" is missing settings.url. ` +
        "Set it to the page you want gigradar to scan for listings.",
    );
  }
  return configured;
}

function hintFrom(cfg: SourceConfig): string | undefined {
  const configured = cfg.settings?.hint;
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

function isBrowserSessionAuth(cfg: SourceConfig): boolean {
  return cfg.settings?.customAuth === "browser-session";
}

function sessionStatePathFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.sessionStatePath;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      `${MODULE_PREFIX}: source "${cfg.id}" has settings.customAuth:"browser-session" but is missing ` +
        "settings.sessionStatePath. Capture a login for it first (or point at the resulting session file).",
    );
  }
  return configured;
}

/**
 * The cache-then-fallback extraction shared by both browser-acquisition
 * paths below: try `readRecipe()`'s cached recipe via `extractWithRecipe()`
 * first (zero LLM calls); on a cache miss or a stale recipe (`null`), fall
 * back to `deriveRecipeAndExtract()` and overwrite the cache. `credential`
 * is only required on the fallback path — checked there, not earlier, so a
 * source with a still-valid cached recipe keeps working even if no
 * credential is currently resolvable.
 *
 * Either path's first-page result is then run through
 * `followPagination()` (custom-source-recipe-pagination story) — a no-op
 * when the recipe has no `nextPageSelector`, so this is additive and never
 * changes single-page-source behavior.
 */
async function extractViaRecipeOrDerive(page: Page, cfg: SourceConfig, hint: string | undefined, credential: LlmCredential | undefined): Promise<Gig[]> {
  // product-review-followups epic, scraper-session-fixes story: both
  // callers' page.goto(url) above has no `waitUntil`, so it resolves as
  // soon as the initial document (+ subresources) loads -- BEFORE a
  // client-rendered SPA's own async data fetch has painted anything.
  // Live-verified against gun-io: the exact same session/URL produced
  // "only <head>" without this wait, and the real page (25KB body, real
  // listings) with it. "networkidle" is the strongest available signal
  // that a SPA's own data-fetch-then-render cycle has settled; swallowed
  // on timeout (not every site's network ever goes fully idle -- e.g.
  // polling/websockets) so a slow-but-real page still falls through to
  // extraction with whatever DOM exists, rather than failing outright.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const cached = readRecipe(cfg.id);
  if (cached) {
    const viaRecipe = await extractWithRecipe(page, cfg.id, cached);
    if (viaRecipe) return followPagination(page, cfg.id, cached, viaRecipe);
  }

  if (!credential) {
    throw new Error(
      `${MODULE_PREFIX}: source "${cfg.id}" is a custom LLM source but no LLM credential was supplied. ` +
        "Set one in Config before scanning.",
    );
  }

  const { gigs, recipe } = await deriveRecipeAndExtract(page, cfg.id, hint, credential);
  writeRecipe(cfg.id, recipe);
  return followPagination(page, cfg.id, recipe, gigs);
}

/**
 * The single, generic `Source` every `kind: "custom-llm"` `SourceConfig`
 * routes to — see this file's header comment and design-discussion.md §3.
 * `id`/`label`/`auth` are static placeholders (never used for registry
 * lookup, since this object is never registered — see runner.ts's own
 * lookup fallback); `fetch()` is the only part that matters, and it reads
 * everything per-instance from the `cfg` it's actually called with.
 */
export const customLlmSource: Source = {
  id: "custom-llm",
  label: "Custom (LLM)",
  auth: "none",
  async fetch(cfg: SourceConfig, _profile: Profile, credential?: LlmCredential): Promise<Gig[]> {
    const url = urlFrom(cfg);
    const hint = hintFrom(cfg);

    if (isBrowserSessionAuth(cfg)) {
      const storageStatePathSetting = sessionStatePathFrom(cfg);
      const allowedOrigins = resolveAllowedOrigins(cfg.id, cfg);
      if (!allowedOrigins || allowedOrigins.length === 0) {
        throw new Error(
          `${MODULE_PREFIX}: source "${cfg.id}" has settings.customAuth:"browser-session" but no origin allowlist ` +
            "registered — set settings.allowedOrigins to the domain(s) this source's session cookies belong to.",
        );
      }

      return withBrowserSession(
        {
          sourceId: cfg.id,
          storageStatePathSetting,
          sessionBackend: sessionBackendFrom(cfg),
          allowedOrigins,
          url,
          isAuthenticated: async () => true,
        },
        (page) => extractViaRecipeOrDerive(page, cfg, hint, credential),
      );
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      return await extractViaRecipeOrDerive(page, cfg, hint, credential);
    } finally {
      await browser.close();
    }
  },
};
