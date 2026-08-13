// Pure logic for the /drafts page, split out of drafts-client.tsx so it's
// directly unit-testable without React Testing Library (not a dependency of
// this project — see src/app/dashboard-filter.ts's header comment for the
// same convention this file follows).
import type { DraftStatus } from "@/lib/store";
import type { DraftContent } from "@/lib/types";

export type DraftStatusFilter = DraftStatus | "all";

export const DRAFT_STATUS_TABS: DraftStatusFilter[] = ["all", "draft", "approved", "rejected", "submitted"];

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
