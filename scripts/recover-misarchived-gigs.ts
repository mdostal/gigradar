/**
 * deep-dive-audit-and-testing-framework epic, recover-misarchived-applied-gigs
 * story. One-off data-migration script for the recordScan() collateral-
 * damage bug (see fix-recordscan-corruption-bug.yaml / the epic's design
 * discussion §1a) — NOT a permanent library function.
 *
 * Dry-run by default: prints every gig it WOULD restore, and why, without
 * writing anything. Pass --apply to actually write. Always run dry-run
 * first and read the output before ever passing --apply.
 *
 * Recovery heuristic — source-specific, because "outcome_reason=withdrawn"
 * does NOT mean the same thing for every source:
 *
 * GoFractional: gofractional-status.ts's own OUTCOME_REASON_MAP has NO
 * "withdrawn" key at all (only passed/rejected/"not selected"/declined ->
 * "rejected" — "withdrawn" is explicitly left out as genuinely ambiguous,
 * per that file's own comment). This means outcome_reason="withdrawn" is
 * STRUCTURALLY IMPOSSIBLE to produce via a real GoFractional-reported
 * status label — it can ONLY have been written by
 * flagUnavailableForSource()'s own applied/interview -> "withdrawn"
 * inference (the bug). Any gofractional gig with status='archived' AND
 * outcome_reason='withdrawn' is therefore CONCLUSIVELY bug-produced,
 * independent of timestamp evidence.
 *
 * Wellfound: the mirror-image case — wellfound-status.ts's
 * OUTCOME_REASON_MAP DOES map a real "expired" status label to
 * "withdrawn", so outcome_reason='withdrawn' can be genuinely
 * platform-reported. The externalId itself carries a real, structural
 * tell though: a backfilled row's externalId is `row.href` with the
 * leading slash stripped (wellfound-status.ts:215-216) — and Wellfound's
 * own archived-applications page anchors are `/jobs/applications/archived/
 * {id}` (vs. the active list's `/jobs/applications/{id}`). A key
 * containing `/archived/` was scraped directly off Wellfound's own
 * archived-applications view, so its terminal status is real, reported
 * data — NEVER a recovery candidate, regardless of any timestamp
 * coincidence. Only a wellfound gig WITHOUT `/archived/` in its key
 * (native gigs the owner manually marked, or backfilled from the ACTIVE
 * applications list) is even considered, and then only if its
 * unavailableSince timestamp exactly coincides with a sibling write for
 * the same source — the fingerprint of collateral damage from an
 * unrelated single-gig recordScan() batch, never a real "this listing
 * disappeared" signal.
 *
 * Anything not matching one of these two conclusive patterns is reported
 * for manual review only — never guessed.
 *
 * Usage:
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/recover-misarchived-gigs.ts            # dry run
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/recover-misarchived-gigs.ts --apply     # write
 *
 * GIGRADAR_DB_PATH (or the default XDG path) selects the database, same
 * as every other real entry point in this repo — point it at a COPY for
 * testing, never assume; this script has no test-mode guard of its own,
 * it operates on whatever DB it's pointed at.
 */
import { closeDb, getDb, getDraft, setOutcome, setStatus } from "../src/lib/store/index.js";

export interface WithdrawnRow {
  key: string;
  source_id: string;
  external_id: string;
  status: string;
  outcome_reason: string | null;
  first_seen: string;
  unavailable_since: string | null;
  title: string;
}

interface RecoveryCandidate {
  key: string;
  title: string;
  sourceId: string;
  firstSeen: string;
  unavailableSince: string | null;
  evidence: string;
  restoreToStatus: "applied" | "interview";
}

interface ExcludedRow extends WithdrawnRow {
  reason: string;
}

export function findCandidates(
  rows: WithdrawnRow[],
): { candidates: RecoveryCandidate[]; excluded: ExcludedRow[]; reportedOnly: WithdrawnRow[] } {
  const candidates: RecoveryCandidate[] = [];
  const excluded: ExcludedRow[] = [];
  const reportedOnly: WithdrawnRow[] = [];

  for (const row of rows) {
    if (row.source_id === "gofractional") {
      // OUTCOME_REASON_MAP structurally cannot produce "withdrawn" for a
      // real GoFractional-reported label -- conclusive, no further check needed.
      candidates.push({
        key: row.key,
        title: row.title,
        sourceId: row.source_id,
        firstSeen: row.first_seen,
        unavailableSince: row.unavailable_since,
        evidence: "gofractional: outcome_reason='withdrawn' is structurally impossible from a real platform label (OUTCOME_REASON_MAP has no 'withdrawn' key) — must be flagUnavailableForSource()'s own bug",
        restoreToStatus: "applied",
      });
      continue;
    }

    if (row.source_id === "wellfound") {
      if (row.external_id.includes("/archived/")) {
        // Scraped directly off Wellfound's own archived-applications page --
        // its terminal status is real, reported data. Never a candidate.
        excluded.push({ ...row, reason: "scraped from Wellfound's own /archived/ applications page — genuinely platform-reported, not gigradar's bug" });
        continue;
      }
      if (row.unavailable_since && row.unavailable_since > row.first_seen) {
        const coincident = rows.find(
          (other) =>
            other.key !== row.key &&
            other.source_id === row.source_id &&
            (other.first_seen === row.unavailable_since || other.unavailable_since === row.unavailable_since),
        );
        if (coincident) {
          candidates.push({
            key: row.key,
            title: row.title,
            sourceId: row.source_id,
            firstSeen: row.first_seen,
            unavailableSince: row.unavailable_since,
            evidence: `wellfound (not from the archived-applications page): unavailableSince (${row.unavailable_since}) exactly coincides with sibling write for ${coincident.key} — collateral-damage fingerprint`,
            restoreToStatus: "applied",
          });
          continue;
        }
      }
    }

    reportedOnly.push(row);
  }
  return { candidates, excluded, reportedOnly };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();

  const rows = db
    .prepare(
      "SELECT key, source_id, external_id, status, outcome_reason, first_seen, unavailable_since, title FROM gigs WHERE status = 'archived' AND outcome_reason = 'withdrawn'",
    )
    .all() as unknown as WithdrawnRow[];

  const { candidates, excluded, reportedOnly } = findCandidates(rows);

  console.log(`gigradar recover-misarchived-gigs: ${rows.length} archived/withdrawn gigs scanned.`);
  console.log(`  ${candidates.length} high-confidence recoverable.`);
  console.log(`  ${excluded.length} confirmed genuinely platform-reported (Wellfound's own /archived/ page) -- never a candidate.`);
  console.log(`  ${reportedOnly.length} ambiguous (no conclusive signal either way) -- reported for manual review only.`);
  console.log("");

  if (candidates.length === 0) {
    console.log("Nothing to recover.");
    closeDb();
    return;
  }

  for (const c of candidates) {
    const draft = getDraft(c.key);
    console.log(
      `${apply ? "RESTORING" : "WOULD RESTORE"}: ${c.key}\n` +
        `  title: "${c.title}"\n` +
        `  restore status -> "${c.restoreToStatus}"\n` +
        `  evidence: ${c.evidence}\n` +
        `  firstSeen: ${c.firstSeen}${draft ? `\n  has a saved draft (status: ${draft.status})` : ""}\n`,
    );
    if (apply) {
      setStatus(c.key, c.restoreToStatus);
      setOutcome(c.key, null, null);
      db.prepare("UPDATE gigs SET unavailable_since = NULL WHERE key = :key").run({ key: c.key });
    }
  }

  if (!apply) {
    console.log(`Dry run only -- no changes written. Re-run with --apply to restore the ${candidates.length} gig(s) above.`);
  } else {
    console.log(`Restored ${candidates.length} gig(s).`);
  }

  if (reportedOnly.length > 0) {
    console.log(`\n${reportedOnly.length} gig(s) ambiguous, reported but not auto-flagged (left for manual review):`);
    for (const r of reportedOnly) {
      console.log(`  ${r.key} — "${r.title}" (source: ${r.source_id}, firstSeen: ${r.first_seen}, unavailableSince: ${r.unavailable_since ?? "null"})`);
    }
  }

  if (excluded.length > 0) {
    console.log(`\n${excluded.length} gig(s) confirmed genuinely platform-reported, never candidates:`);
    for (const r of excluded) {
      console.log(`  ${r.key} — "${r.title}" (${r.reason})`);
    }
  }

  closeDb();
}

// Only run main() when this file is executed directly (`tsx
// scripts/recover-misarchived-gigs.ts`) -- NOT when imported, e.g. by this
// script's own unit test importing findCandidates(). A bare top-level
// main() call would open a real DB connection as a side effect of merely
// importing the pure logic for testing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
