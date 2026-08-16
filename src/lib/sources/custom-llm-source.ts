// llm-custom-sources epic, custom-source-core-mechanism +
// custom-source-recipe-caching stories. THE core mechanism that fixes
// CLAUDE.md's core/user-layer boundary rule for real: an owner can point
// gigradar at ANY job site by adding a config entry with `kind:
// "custom-llm"` — no TypeScript, no PR to this repo. See
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
// HEADLESS, chromium.launch() — NOT real-chrome.ts, NOT headed. This slice
// covers only `auth: "none"` custom sources; nothing here has been shown to
// need a visible window or bot-detection workaround, and headless is
// materially cheaper for an unattended scheduler loop. Auth support
// (real-chrome.ts, headed) is custom-source-auth's job, layered on top of
// this file in a later story — not duplicated here.
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
// cache-then-fallback orchestration plus the Source wiring.
import { chromium } from "playwright";
import type { Source } from "./source.js";
import type { Gig, Profile, SourceConfig } from "../types.js";
import { deriveRecipeAndExtract, extractWithRecipe, readRecipe, writeRecipe } from "./custom-source-recipe.js";

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
  async fetch(cfg: SourceConfig, _profile: Profile, apiKey?: string): Promise<Gig[]> {
    const url = urlFrom(cfg);
    const hint = hintFrom(cfg);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url);

      const cached = readRecipe(cfg.id);
      if (cached) {
        const viaRecipe = await extractWithRecipe(page, cfg.id, cached);
        if (viaRecipe) return viaRecipe;
      }

      // Cache miss or stale recipe: derive a fresh one via the LLM. This is
      // the ONLY path that needs an API key — checked here, not earlier, so
      // a source with a still-valid cached recipe keeps working even if the
      // key is temporarily unset/invalid.
      if (!apiKey) {
        throw new Error(
          `${MODULE_PREFIX}: source "${cfg.id}" is a custom LLM source but no Anthropic API key was supplied. ` +
            "Set one in Config before scanning.",
        );
      }

      const { gigs, recipe } = await deriveRecipeAndExtract(page, cfg.id, hint, apiKey);
      writeRecipe(cfg.id, recipe);
      return gigs;
    } finally {
      await browser.close();
    }
  },
};
