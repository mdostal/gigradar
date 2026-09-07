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
import type { StoredGig, StoredScanCycle } from "@/lib/store";
import { KNOWN_SOURCES } from "@/lib/sources/origins";

export interface StatusStripView {
  /** e.g. "3 sources configured (1 needs attention)" or "0 sources configured". */
  sourcesLabel: string;
  /** "Profile: complete" or "Profile: needs setup". */
  profileLabel: string;
  /**
   * "Last scan: up to date (2 hours ago)" (the last real cycle fully
   * completed), "Last scan: partially updated (2 hours ago) — 3 source(s)
   * didn't complete" (the last real cycle had errors/timeouts/backoff
   * skips), the pre-cycle-tracking fallback "Last scan: 2 hours ago" (gigs
   * exist but no scan_cycles row has ever been recorded — an install that
   * predates this signal), or "Last scan: never run". See
   * computeCycleCompleteness()'s own doc comment for the real signal this
   * is built from.
   */
  lastScanLabel: string;
  /**
   * "full" (last recorded cycle had zero incomplete sources), "partial"
   * (last recorded cycle had >=1 source error/timeout/backoff-skip), or
   * "unknown" (no scan_cycles row exists yet — see `lastCycle`'s own doc
   * comment on computeStatusStrip()). Exposed separately from
   * `lastScanLabel` so a UI can style a partial cycle distinctly (e.g. the
   * same amber "needs attention" treatment `sourcesLabel`/`profileLabel`
   * already use) without re-parsing the label string.
   */
  cycleStatus: "full" | "partial" | "unknown";
  /** Count of sources that errored/timed-out/were skipped in the last recorded cycle. 0 when `cycleStatus` is "full" or "unknown". */
  incompleteSourceCount: number;
}

/**
 * The real per-cycle completion signal this module needs — a trimmed view
 * of `StoredScanCycle` (src/lib/store/types.ts), passed in already-fetched
 * (this module stays DB-free, matching its own "pure logic, directly
 * unit-testable" header comment) from `getLastScanCycle()`'s result.
 * `null`/`undefined` means no cycle has ever been recorded yet (a brand-new
 * install, or a DB that predates this story) — status-strip.ts then falls
 * back to the old MAX(lastSeen)-only label rather than claiming "partial"
 * or "full" about a cycle it has no real data on.
 */
export type LastScanCycleInput = Pick<StoredScanCycle, "sourcesTotal" | "incompleteSourceIds"> | null;

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

/** `id -> auth` lookup over KNOWN_SOURCES, built once at module load — same registry the setup wizard and Capture Login button already read from, never a second copy. */
const KNOWN_SOURCE_AUTH: ReadonlyMap<string, string> = new Map(KNOWN_SOURCES.map((s) => [s.id, s.auth]));

/**
 * "Needs attention" is a best-effort, glance-level heuristic (not a health
 * check, per the story's `risks` block): a source counts as needing
 * attention when it's `enabled: true`, has no non-empty `settings` object,
 * AND genuinely needs one to function.
 *
 * FIXED 2026-08-31 (live-verified against the owner's own real config):
 * the original version flagged EVERY enabled source with empty settings,
 * including plain `auth: "none"` public boards (braintrust, builtin,
 * fractionaljobs, fractionus, fractionalfinders, linkedin — six of the
 * owner's nine real sources) that need ZERO configuration to work and
 * were working fine — a real, actively misleading false-positive ("6 need
 * attention" on a dashboard whose Issues page correctly showed zero open
 * issues). Now cross-references `KNOWN_SOURCES` (src/lib/sources/
 * origins.ts, the same registry the setup wizard and Capture Login button
 * already read from): a hand-built adapter with `auth: "none"` is NEVER
 * flagged for missing settings, regardless of whether it has any. Every
 * other case is unchanged — a `browser-session` KNOWN_SOURCES entry
 * (gofractional/ateam/wellfound) missing settings.sessionStatePath, and
 * any source NOT in KNOWN_SOURCES at all (a custom-llm/gmail-digest
 * source added by hand, which genuinely needs its own settings), still
 * count toward `needingAttention` exactly as before.
 *
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
    const id = typeof source.id === "string" ? source.id : undefined;
    const needsNoSettings = id !== undefined && KNOWN_SOURCE_AUTH.get(id) === "none";
    if (enabled && !hasSettings && !needsNoSettings) needingAttention++;
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

export interface CycleCompleteness {
  cycleStatus: "full" | "partial" | "unknown";
  incompleteSourceCount: number;
}

/**
 * status-strip-reflects-cycle-completion story (real-usability-
 * verification-and-fixes epic): the real cycle-completion signal, derived
 * from `lastCycle` (`getLastScanCycle()`'s result — the scheduler's/manual
 * "Sweep now"'s own already-computed per-cycle errored/timed-out/
 * backoff-skipped source ids, see store/scan-cycles.ts) rather than
 * inferred from gig timestamps. `null`/`undefined` (no scan_cycles row
 * exists yet) is honestly "unknown" — NEVER "full": claiming a cycle
 * "fully completed" with zero real evidence either way would be exactly
 * the falsely-reassuring label this story exists to remove.
 */
export function computeCycleCompleteness(lastCycle: LastScanCycleInput): CycleCompleteness {
  if (!lastCycle) return { cycleStatus: "unknown", incompleteSourceCount: 0 };
  const incompleteSourceCount = lastCycle.incompleteSourceIds.length;
  return { cycleStatus: incompleteSourceCount > 0 ? "partial" : "full", incompleteSourceCount };
}

/**
 * Builds the status-strip labels from `gigs` (listGigs()'s result),
 * `rawConfig` (readRawConfig()'s result), and `lastCycle`
 * (`getLastScanCycle()`'s result — see `LastScanCycleInput`'s own doc
 * comment). Never throws: every input is treated as untrusted/
 * possibly-absent, matching readRawConfig()'s own ENOENT-tolerant,
 * non-resolving contract (an empty `{}` — first run, no config.json yet —
 * renders the same "0 sources configured" / "Profile: needs setup" strip a
 * fully-populated-but-empty config would).
 *
 * `lastScanLabel`'s freshness text now honestly distinguishes THREE real
 * states rather than one undifferentiated MAX(gig.lastSeen) timestamp (the
 * owner's own real complaint this story fixes — see this module's header
 * comment): "up to date" (the last recorded cycle had zero incomplete
 * sources), "partially updated ... — N source(s) didn't complete" (the last
 * recorded cycle had real errors/timeouts/backoff-skips), or the bare
 * pre-existing timestamp form when no cycle has ever been recorded yet
 * (`lastCycle` omitted/null — an install that predates this signal, or one
 * that has gigs from a source other than a tracked cycle, e.g. a
 * status-reconciliation backfill).
 */
export function computeStatusStrip(
  gigs: readonly Pick<StoredGig, "lastSeen">[],
  rawConfig: Record<string, unknown>,
  now: number = Date.now(),
  lastCycle: LastScanCycleInput = null,
): StatusStripView {
  const { configured, needingAttention } = computeSourceCounts(rawConfig);
  const sourcesLabel =
    needingAttention > 0
      ? `${configured} source${configured === 1 ? "" : "s"} configured (${needingAttention} need attention)`
      : `${configured} source${configured === 1 ? "" : "s"} configured`;

  const profileLabel = `Profile: ${computeProfileComplete(rawConfig) ? "complete" : "needs setup"}`;

  const lastScanIso = computeLastScanIso(gigs);
  const { cycleStatus, incompleteSourceCount } = computeCycleCompleteness(lastCycle);

  let lastScanLabel: string;
  if (lastScanIso === null) {
    lastScanLabel = "Last scan: never run";
  } else {
    const relative = formatRelativeTime(lastScanIso, now);
    if (cycleStatus === "full") {
      lastScanLabel = `Last scan: up to date (${relative})`;
    } else if (cycleStatus === "partial") {
      lastScanLabel = `Last scan: partially updated (${relative}) — ${incompleteSourceCount} source${incompleteSourceCount === 1 ? "" : "s"} didn't complete`;
    } else {
      lastScanLabel = `Last scan: ${relative}`;
    }
  }

  return { sourcesLabel, profileLabel, lastScanLabel, cycleStatus, incompleteSourceCount };
}
