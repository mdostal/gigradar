// Pure logic for the nav badge showing open-issue count/severity
// (notifications-epic) — split out of nav-header.tsx/layout.tsx so it's
// directly unit-testable without React Testing Library, same convention
// src/app/dashboard-filter.ts and src/app/drafts/drafts-filter.ts already
// follow.
import type { IssueSeverity } from "@/lib/notify/issues";

export interface IssuesBadgeInfo {
  count: number;
  /** "red" whenever ANY open issue is severity="error" -- an error outranks any number of open warnings for badge color. "amber" only when every open issue is a warning. */
  color: "red" | "amber";
}

/**
 * `null` at zero open issues -- the nav renders NO badge at all in that
 * case (this repo's established "omission is the correct empty state"
 * convention), not a "0" badge.
 */
export function issuesBadgeInfo(openIssues: readonly { severity: IssueSeverity }[]): IssuesBadgeInfo | null {
  if (openIssues.length === 0) return null;
  const hasError = openIssues.some((i) => i.severity === "error");
  return { count: openIssues.length, color: hasError ? "red" : "amber" };
}
