import type { ApplyProfileConfig, DraftContent, Gig } from "../types.js";

/**
 * The plugin contract a REAL, live submission automation implements
 * (graduated-auto-fire-trust epic). Deliberately mirrors
 * `src/lib/sources/source.ts`'s `Source` interface/registry shape —
 * same registration pattern, same "throw rather than fake success"
 * contract — but is otherwise fully independent: a SubmitAdapter knows
 * nothing about trust/graduation/rules (that's `src/lib/apply/autofire.ts`)
 * and has no compile-time dependency on the store.
 *
 * `submit()` MUST only ever be invoked via the orchestration layer AFTER a
 * passing `evaluateAutoFire()` decision — never called directly, same
 * "internal-only, orchestration-gated" discipline this codebase already
 * documents for other internal call sites.
 */
export interface SubmitAdapter {
  /** Stable id — MUST match the source's own `Source.id` (e.g. "gofractional"), since a submit adapter always submits INTO the same platform its fetch-side Source scrapes. */
  id: string;
  /**
   * Attempts a real submission. MUST treat ONLY a real, observed
   * post-submit confirmation state as success — never infer success from
   * "the action didn't throw." Throw a specific, actionable error on any
   * failure (network, auth, unexpected page shape, ambiguous outcome) —
   * never return a fake/optimistic success.
   */
  submit(gig: Gig, draft: DraftContent, applyProfile: ApplyProfileConfig): Promise<SubmitResult>;
}

export interface SubmitResult {
  ok: true;
  /** Whatever real, observed confirmation the target site showed (e.g. a confirmation message, a submitted-application id) — for the audit trail, never fabricated. */
  confirmation: string;
}

const registry = new Map<string, SubmitAdapter>();

export function registerSubmitAdapter(adapter: SubmitAdapter): void {
  if (registry.has(adapter.id)) throw new Error(`duplicate submit adapter id: ${adapter.id}`);
  registry.set(adapter.id, adapter);
}

export function getSubmitAdapter(id: string): SubmitAdapter | undefined {
  return registry.get(id);
}

export function listSubmitAdapters(): SubmitAdapter[] {
  return [...registry.values()];
}
