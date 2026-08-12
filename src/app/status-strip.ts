// Pure logic for the dashboard status strip (`overview-nav-status` story),
// split out of page.tsx the same way dashboard-filter.ts is split out of
// dashboard-client.tsx: this module is directly unit-testable without
// needing to render a Next.js Server Component (this repo has no React
// Testing Library dependency — see dashboard-filter.test.ts for the
// established convention this file follows).
//
// Two inputs, per the story's data-fetching note:
//   - `gigs`: listGigs()'s existing result (already read on page.tsx,
//     genuinely free) — used only for "last scan" (MAX of lastSeen).
//   - `rawConfig`: readRawConfig()'s result (src/lib/config/save.ts) — the
//     non-resolving, ENOENT-tolerant reader (`{}` when no config.json
//     exists yet). NEVER loadConfig(): the status strip only needs
//     presence/shape checks, never resolved secret values. Because it's
//     raw/unvalidated, every field here is read defensively (unknown shape
//     in, never throws).
import type { StoredGig } from "@/lib/store";

export interface StatusStripView {
  /** e.g. "3 sources configured (1 needs attention)" or "0 sources configured". */
  sourcesLabel: string;
  /** "Profile: complete" or "Profile: needs setup". */
  profileLabel: string;
  /** "Last scan: 2 hours ago" or "Last scan: never run". */
  lastScanLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * "Profile: complete" requires `profile.name`, `profile.roles`, and
 * `profile.skills` all non-empty (per the story description). Any other
 * shape (missing `profile`, empty arrays, blank name, or `rawConfig` being
 * `{}` on first-run) is "needs setup" — never a thrown error.
 */
export function computeProfileComplete(rawConfig: Record<string, unknown>): boolean {
  const profile = rawConfig.profile;
  if (!isRecord(profile)) return false;
  return isNonEmptyString(profile.name) && isNonEmptyArray(profile.roles) && isNonEmptyArray(profile.skills);
}

export interface SourceCounts {
  configured: number;
  needingAttention: number;
}

/**
 * "Needs attention" is a best-effort, glance-level heuristic (not a health
 * check, per the story's `risks` block): a source counts as needing
 * attention when it's `enabled: true` but has no non-empty `settings` object
 * — i.e. nothing that could plausibly be a resolvable session/credential.
 * Malformed source entries (not an object) are counted toward `configured`
 * (the array length) but never toward `needingAttention`, and never crash.
 */
export function computeSourceCounts(rawConfig: Record<string, unknown>): SourceCounts {
  const sources = rawConfig.sources;
  if (!Array.isArray(sources)) return { configured: 0, needingAttention: 0 };

  let needingAttention = 0;
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const enabled = source.enabled === true;
    const settings = source.settings;
    const hasSettings = isRecord(settings) && Object.keys(settings).length > 0;
    if (enabled && !hasSettings) needingAttention++;
  }

  return { configured: sources.length, needingAttention };
}

/** MAX(lastSeen) across `gigs`, or `null` when the list is empty (nothing has ever been scanned). */
export function computeLastScanIso(gigs: readonly Pick<StoredGig, "lastSeen">[]): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const gig of gigs) {
    const ms = new Date(gig.lastSeen).getTime();
    if (ms > latestMs) {
      latest = gig.lastSeen;
      latestMs = ms;
    }
  }
  return latest;
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

/**
 * Human-relative form (e.g. "2 hours ago") of an ISO datetime relative to
 * `now` (defaults to `Date.now()`, overridable for deterministic tests). An
 * unparseable `iso` falls back to a plain label rather than "Invalid Date"
 * or throwing — defensive, since `rawConfig`/`gigs` data is never guaranteed
 * well-formed this far from validation.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const thenMs = new Date(iso).getTime();
  if (Number.isNaN(thenMs)) return "unknown time";

  const diffSec = Math.round((thenMs - now) / 1000);
  const absSec = Math.abs(diffSec);

  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (absSec >= secondsInUnit) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(diffSec / secondsInUnit), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(diffSec, "second");
}

/**
 * Builds the three status-strip labels from `gigs` (listGigs()'s result)
 * and `rawConfig` (readRawConfig()'s result). Never throws: every input is
 * treated as untrusted/possibly-absent, matching readRawConfig()'s own
 * ENOENT-tolerant, non-resolving contract (an empty `{}` — first run, no
 * config.json yet — renders the same "0 sources configured" / "Profile:
 * needs setup" strip a fully-populated-but-empty config would).
 */
export function computeStatusStrip(
  gigs: readonly Pick<StoredGig, "lastSeen">[],
  rawConfig: Record<string, unknown>,
  now: number = Date.now(),
): StatusStripView {
  const { configured, needingAttention } = computeSourceCounts(rawConfig);
  const sourcesLabel =
    needingAttention > 0
      ? `${configured} source${configured === 1 ? "" : "s"} configured (${needingAttention} need attention)`
      : `${configured} source${configured === 1 ? "" : "s"} configured`;

  const profileLabel = `Profile: ${computeProfileComplete(rawConfig) ? "complete" : "needs setup"}`;

  const lastScanIso = computeLastScanIso(gigs);
  const lastScanLabel = lastScanIso === null ? "Last scan: never run" : `Last scan: ${formatRelativeTime(lastScanIso, now)}`;

  return { sourcesLabel, profileLabel, lastScanLabel };
}
