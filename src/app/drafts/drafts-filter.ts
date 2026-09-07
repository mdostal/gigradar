// Pure logic for the /drafts page, split out of drafts-client.tsx so it's
// directly unit-testable without React Testing Library (not a dependency of
// this project — see src/app/dashboard-filter.ts's header comment for the
// same convention this file follows).
import type { DraftStatus } from "@/lib/store";
import type { DraftContent, Gig } from "@/lib/types";
import { resolveDisplayTier } from "../dashboard-filter";

export type DraftStatusFilter = DraftStatus | "all";

export const DRAFT_STATUS_TABS: DraftStatusFilter[] = ["all", "draft", "approved", "rejected", "submitted"];

/**
 * drafts-page-group-context story (group-scoped-automation-fixes epic). One
 * group a draft's underlying gig actually matched, with THAT group's own
 * label and tier (via `resolveDisplayTier()`, dashboard-filter.ts) — never
 * the flat/primary-group tier, which can disagree (e.g. flat red, but green
 * for the non-primary group that actually triggered this draft).
 */
export interface DraftMatchedGroup {
  id: string;
  label: string;
  tier: Gig["tier"];
}

/** One draft flattened together with the read-only fields of its linked gig (see drafts/page.tsx). */
export interface DraftListItem {
  gigKey: string;
  content: DraftContent;
  status: DraftStatus;
  generatedAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  gigTitle: string;
  gigCompany?: string;
  /** The real, per-listing gig URL — never a search page (docs/ARCHITECTURE.md's data-integrity rule). */
  gigUrl: string;
  /**
   * drafts-gig-context-surfacing story: forwarded from Gig.rate/Gig.tier/
   * Gig.sourceId (already read in full by drafts/page.tsx's getGig() call,
   * previously discarded before reaching this interface) so reviewing
   * several near-identical drafts isn't a blind guess — see this epic's
   * docs/design-discussion.md §3.
   */
  gigRate?: Gig["rate"];
  gigTier?: Gig["tier"];
  gigSourceId: string;
  /**
   * drafts-page-group-context story: which of the owner's configured
   * groups this gig actually matched, each with its own real tier. Always
   * `[]` with only one group configured (see `resolveDraftMatchedGroups()`)
   * so the single-group Drafts list renders byte-identical to before this
   * story — zero added visual noise for the common case.
   */
  matchedGroups: DraftMatchedGroup[];
}

/**
 * drafts-page-group-context story. Computes the per-group badges a draft's
 * gig should show — pure and directly unit-testable (no DOM), same
 * established split as `resolveDisplayTier()` itself.
 *
 * Gated on `groups.length > 1` — the same "2+ groups" gate every other
 * group-count-sensitive component in this codebase uses (NavHeader's
 * switcher, config-client.tsx's Group selectors) — so a single-group
 * install (still the common case) always gets `[]` back here, and the
 * Drafts list falls back to rendering the plain flat tier badge exactly as
 * it did before this story existed.
 *
 * With 2+ groups configured, returns one entry per id in
 * `gig.matchedGroupIds` (the real groups this gig cleared), each carrying
 * ITS OWN tier via `resolveDisplayTier(gig, id)` — never the flat/primary
 * `gig.tier`, which is anchored to the primary group only and can disagree
 * (a gig auto-drafted purely because it's green for a non-primary group
 * could show flat red/yellow otherwise). A matched id with no corresponding
 * entry in `groups` (deleted/renamed group, stale data) falls back to
 * showing the raw id as its own label rather than being silently dropped.
 */
export function resolveDraftMatchedGroups(
  gig: Pick<Gig, "tier" | "matchedGroupIds" | "matchedGroupTiers">,
  groups: readonly { id: string; label: string }[],
): DraftMatchedGroup[] {
  if (groups.length <= 1) return [];
  const labelById = new Map(groups.map((g) => [g.id, g.label]));
  return (gig.matchedGroupIds ?? []).map((id) => ({
    id,
    label: labelById.get(id) ?? id,
    tier: resolveDisplayTier(gig, id),
  }));
}

/** Status filter only — newest-generated-first ordering already comes from listDrafts() itself. */
export function filterDrafts(items: readonly DraftListItem[], status: DraftStatusFilter): DraftListItem[] {
  if (status === "all") return [...items];
  return items.filter((item) => item.status === status);
}

/**
 * Renders a `DraftContent` as clean, copy-ready plain text: the cover
 * message, then (only if there are any) a blank line and each
 * question/answer pair as `Q: <question>` / `A: <answer>` — nothing else.
 * Deliberately NOT `JSON.stringify()` or any structure carrying raw
 * LLM-internal formatting (tool-call shape, escaped quotes, etc.) — this is
 * exactly what the user pastes into a real application form (review step's
 * acceptance criteria: "the copy-ready draft doesn't accidentally include
 * any raw LLM-internal formatting").
 */
export function formatCopyReadyDraft(content: DraftContent): string {
  const parts = [content.coverText];
  const answerEntries = Object.entries(content.answers);
  if (answerEntries.length > 0) {
    const qa = answerEntries.map(([question, answer]) => `Q: ${question}\nA: ${answer}`).join("\n\n");
    parts.push(qa);
  }
  return parts.join("\n\n");
}
