// Persistence for LLM-drafted applications (assisted-apply-drafting epic,
// draft-generation-foundation story). Mirrors gigs.ts's shape: a thin,
// typed layer over one table (`application_drafts`, schema.ts) — the only
// place in the codebase that writes raw SQL against it. Nothing outside
// src/lib/store should ever need to.
import type { DraftContent } from "../types.js";
import { getDb, withTransaction } from "./db.js";
import type { DbOption } from "./gigs.js";
import { setStatus } from "./gigs.js";
import type { DraftFilter, DraftStatus, StoredDraft } from "./types.js";

interface DraftRow {
  gig_key: string;
  content: string;
  status: string;
  generated_at: string;
  approved_at: string | null;
  submitted_at: string | null;
}

function toStoredDraft(row: DraftRow): StoredDraft {
  return {
    gigKey: row.gig_key,
    content: JSON.parse(row.content) as DraftContent,
    status: row.status as DraftStatus,
    generatedAt: row.generated_at,
    approvedAt: row.approved_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * Persists a freshly-generated draft for `gigKey` — insert-or-replace: a
 * regenerated draft for a gig that already has one REPLACES it wholesale,
 * always resetting `status` back to `'draft'` and clearing
 * `approved_at`/`submitted_at` (a stale approval/submission timestamp must
 * never survive next to brand-new generated content). `gigKey` must already
 * exist in `gigs` — `PRAGMA foreign_keys = ON` (db.ts) enforces the FK for
 * real, not just documents it: an insert for a nonexistent gig throws (see
 * store.test.ts's FK-enforcement test).
 */
export function saveDraft(gigKey: string, content: DraftContent, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO application_drafts (gig_key, content, status, generated_at, approved_at, submitted_at)
     VALUES (:gig_key, :content, 'draft', :now, NULL, NULL)
     ON CONFLICT(gig_key) DO UPDATE SET
       content = excluded.content,
       status = 'draft',
       generated_at = excluded.generated_at,
       approved_at = NULL,
       submitted_at = NULL`,
  ).run({ gig_key: gigKey, content: JSON.stringify(content), now });
}

/** Fetch one draft by its linked gig's key. */
export function getDraft(gigKey: string, opts: DbOption = {}): StoredDraft | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare("SELECT * FROM application_drafts WHERE gig_key = ?").get(gigKey) as DraftRow | undefined;
  return row ? toStoredDraft(row) : undefined;
}

/** List drafts, optionally filtered by status. Newest-generated-first. */
export function listDrafts(filter: DraftFilter = {}, opts: DbOption = {}): StoredDraft[] {
  const db = opts.db ?? getDb();
  const where = filter.status ? "WHERE status = :status" : "";
  const rows = db
    .prepare(`SELECT * FROM application_drafts ${where} ORDER BY generated_at DESC`)
    .all(filter.status ? { status: filter.status } : {}) as unknown as DraftRow[];
  return rows.map(toStoredDraft);
}

/**
 * Sets a draft's status directly — the `'draft' -> 'approved'` /
 * `'draft' -> 'rejected'` transitions the review/approve UI (a sibling
 * story) drives. Stamps `approved_at` when transitioning TO `'approved'`.
 * Throws if no draft exists for `gigKey`, matching gigs.ts's `setStatus()`
 * convention.
 *
 * Deliberately does NOT touch the linked gig's own status — rejecting a
 * draft isn't a claim about the gig itself, just that draft. See
 * `markDraftSubmitted()` below for the one status transition that DOES also
 * update the gig, and why that one must be a single atomic transaction
 * rather than this function plus a separate `gigs.setStatus()` call.
 */
export function setDraftStatus(gigKey: string, status: DraftStatus, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE application_drafts SET
         status = :status,
         approved_at = CASE WHEN :status = 'approved' THEN :now ELSE approved_at END
       WHERE gig_key = :gig_key`,
    )
    .run({ status, now, gig_key: gigKey });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar store: setDraftStatus: no draft with gig_key "${gigKey}"`);
  }
}

/**
 * Marks a draft `'submitted'` AND the linked gig `'applied'` — in ONE
 * `withTransaction()` call (the exact pattern `recordScan()` uses), never
 * two separate, non-atomic calls. Reuses `gigs.ts`'s own `setStatus()`
 * (passed the SAME `db` connection the transaction opened) rather than
 * duplicating an UPDATE, so both statements genuinely run inside one
 * `BEGIN IMMEDIATE`/`COMMIT` — a throw from either one (the draft's own
 * missing-row check, or `setStatus()`'s own missing-gig check, or anything
 * else) rolls BOTH updates back via `withTransaction()`'s `catch` ->
 * `ROLLBACK`. See drafts.test.ts's atomic-transaction test, which forces a
 * failure between the two updates and asserts neither commits.
 */
export function markDraftSubmitted(gigKey: string, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();

  withTransaction(db, () => {
    const result = db
      .prepare(`UPDATE application_drafts SET status = 'submitted', submitted_at = :now WHERE gig_key = :gig_key`)
      .run({ now, gig_key: gigKey });
    if (Number(result.changes) === 0) {
      throw new Error(`gigradar store: markDraftSubmitted: no draft with gig_key "${gigKey}"`);
    }
    setStatus(gigKey, "applied", { db });
  });
}
