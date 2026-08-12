// Merge-not-replace dedup logic for folding extracted resume/link
// roles/skills into an existing draft array — `resume-link-ui` story,
// `profile-overview-ingestion` epic (design-discussion.md §3 step 5,
// resolving grill finding C1).
//
// Deliberately a small, standalone, framework-free module (not inlined into
// config-client.tsx): config-client.tsx is a "use client" React component
// with no existing test harness in this repo (no @testing-library/react
// dependency, no jsdom config) — this project's convention, per every
// other story, is to keep business logic testable as plain functions
// exercised directly by vitest, and let the component itself be a thin
// caller. See merge.test.ts for the dedup contract this enforces.
//
// THIS IS A MERGE, NOT A REPLACE — the deliberate divergence from
// role-templates' Apply button (which overwrites `draft.roleArea` outright,
// see role-templates.ts's own design decision). A resume is additive
// enrichment of an existing profile, not a full-profile reset.

/**
 * Merges `incoming` into `existing`, case-insensitive/trimmed-deduped:
 * - Every entry already in `existing` is kept, in its original order, with
 *   its original (un-trimmed, original-case) form untouched.
 * - Every entry in `incoming` whose trimmed-lowercased form doesn't already
 *   match something in `existing` (or an earlier entry within `incoming`
 *   itself) is appended, trimmed, in its `incoming` order.
 * - A trimmed-lowercase match ("React" vs. "react") is a duplicate and
 *   dropped. A same-idea-different-string match ("Node.js" vs. "NodeJS") is
 *   NOT a duplicate by this rule — accepted, documented limitation (see
 *   design-discussion.md §3 step 5), not something this function attempts
 *   to solve.
 * - Blank/whitespace-only `incoming` entries are dropped, never appended as
 *   empty draft rows.
 * - Never mutates either input array.
 */
export function mergeDedupe(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((v) => v.trim().toLowerCase()));
  const merged = [...existing];

  for (const item of incoming) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }

  return merged;
}
