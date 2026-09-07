// Durable, one-row-per-cycle scan-completion record
// (status-strip-reflects-cycle-completion story, real-usability-
// verification-and-fixes epic). See schema.ts's own header comment on the
// `scan_cycles` table for the full rationale: this is the REAL signal the
// scheduler (src/scheduler/index.ts) and the manual "Sweep now" action
// (src/app/actions.ts) already compute every time a cycle finishes --
// persisted here so src/lib/status/status-strip.ts can distinguish a
// fully-completed last cycle from a partial one, instead of only ever
// reflecting MAX(gigs.last_seen) (per-gig recency, not per-cycle
// completion).
import { getDb } from "./db.js";
import type { DbOption } from "./gigs.js";
import type { StoredScanCycle } from "./types.js";

export interface RecordScanCycleInput {
  /** ISO datetime the cycle finished. Defaults to `opts.now` / `new Date().toISOString()`. */
  completedAt?: string;
  /** Count of enabled sources this cycle was supposed to cover. */
  sourcesTotal: number;
  /** Source ids that errored or were skipped (backoff) this cycle -- [] means a full, clean cycle. */
  incompleteSourceIds: string[];
}

interface ScanCycleRow {
  completed_at: string;
  sources_total: number;
  incomplete_source_ids: string;
}

function toStoredScanCycle(row: ScanCycleRow): StoredScanCycle {
  return {
    completedAt: row.completed_at,
    sourcesTotal: row.sources_total,
    incompleteSourceIds: JSON.parse(row.incomplete_source_ids) as string[],
  };
}

/**
 * Records one completed scan cycle's real completion state. Append-only --
 * mirrors autofire_decisions' own recordAutoFireDecision() convention
 * (drafts.ts): every cycle gets its own row, never an update-in-place, so
 * this table doubles as a real history of cycle health over time, not just
 * "the latest."
 */
export function recordScanCycle(input: RecordScanCycleInput, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const completedAt = input.completedAt ?? opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO scan_cycles (completed_at, sources_total, incomplete_source_ids)
     VALUES (:completed_at, :sources_total, :incomplete_source_ids)`,
  ).run({
    completed_at: completedAt,
    sources_total: input.sourcesTotal,
    incomplete_source_ids: JSON.stringify(input.incompleteSourceIds),
  });
}

/**
 * The most recently completed cycle, or `undefined` when none has ever been
 * recorded -- either a brand-new install, or a DB that predates this story
 * (no scan_cycles rows yet, even though gigs may already exist). Ordered by
 * `completed_at` first (the real-world "most recent" the owner cares about),
 * `id` as a tiebreaker for two cycles stamped with the same timestamp.
 */
export function getLastScanCycle(opts: DbOption = {}): StoredScanCycle | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare(`SELECT * FROM scan_cycles ORDER BY completed_at DESC, id DESC LIMIT 1`).get() as ScanCycleRow | undefined;
  return row ? toStoredScanCycle(row) : undefined;
}
