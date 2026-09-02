import type { DraftFormat, Gig, SourceConfig, Profile } from "../types.js";
import type { LlmCredential } from "../config/env-store.js";

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
   * `credential`: an optional trailing parameter (llm-custom-sources epic;
   * widened from a raw `apiKey?: string` by llm-provider-harness's
   * custom-llm-source-credential-migration story, so BOTH api-key
   * multi-provider mode AND claude-code-harness mode reach real scanning) —
   * every hand-written adapter ignores it (TS structural typing already
   * allows an implementation to declare fewer parameters than the
   * interface, so none of them need to change). Only `customLlmSource`
   * (src/lib/sources/custom-llm-source.ts) and `gmailDigestSource`
   * (src/lib/sources/gmail-digest-source.ts) read it, to construct their
   * own LLM client — resolved by the CALLER (runner.ts), never
   * module-scope, same discipline `stageApplication()`'s own `credential`
   * parameter already established.
   */
  fetch(cfg: SourceConfig, profile: Profile, credential?: LlmCredential): Promise<Gig[]>;
  /**
   * platform-aware-application-drafting epic. This platform's real
   * application UX, when known with real confidence — see
   * `DraftFormat`'s own doc comment (types.ts) for what each value
   * means. Omitted means "no specific knowledge of this platform's real
   * apply flow" — `apply/draft.ts`'s `resolveApplicationFormat()` falls
   * back to `"cover-letter"`, today's original, universal shape, rather
   * than guessing. `SourceConfig.applicationFormat` (if set) always
   * overrides this default.
   */
  applicationFormat?: DraftFormat;
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
