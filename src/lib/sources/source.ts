import type { Gig, SourceConfig, Profile } from "../types.js";

/**
 * The plugin contract every source implements. Add a platform by implementing
 * this and registering it — the rest of the system (gate, ranking, apply)
 * never needs to know which source a gig came from.
 *
 * Mirrors the pluggable-interface pattern from mapstack's Dataset interface.
 */
export interface Source {
  /** Stable id, e.g. "fractional-jobs", "go-fractional", "braintrust". */
  id: string;
  /** Human label for the UI. */
  label: string;
  /**
   * Does this source need an authenticated browser session / API key?
   * The runner surfaces this so the user knows what to turn on.
   */
  auth: "none" | "api-key" | "browser-session" | "oauth";
  /**
   * Fetch current listings and normalize them to Gig[].
   * MUST return real per-listing urls (never a search page) and set `stage`
   * where the source exposes it. Throw on auth failure so the runner can
   * report "needs login" instead of silently returning zero.
   *
   * `apiKey`: an optional trailing parameter (llm-custom-sources epic) —
   * every hand-written adapter ignores it (TS structural typing already
   * allows an implementation to declare fewer parameters than the
   * interface, so none of them need to change). Only `customLlmSource`
   * (src/lib/sources/custom-llm-source.ts) reads it, to construct its own
   * Anthropic client — resolved by the CALLER (runner.ts), never
   * module-scope, same discipline `stageApplication()`'s own `apiKey`
   * parameter already established.
   */
  fetch(cfg: SourceConfig, profile: Profile, apiKey?: string): Promise<Gig[]>;
}

const registry = new Map<string, Source>();

export function registerSource(s: Source): void {
  if (registry.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
  registry.set(s.id, s);
}

export function getSource(id: string): Source | undefined {
  return registry.get(id);
}

export function listSources(): Source[] {
  return [...registry.values()];
}
