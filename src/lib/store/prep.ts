// Persistence for LLM-generated per-gig interview prep packets (career-crm
// epic, prep-packet-mechanism story). Mirrors drafts.ts's exact shape: a
// thin, typed layer over one table (`interview_prep`, schema.ts) — the
// only place in the codebase that writes raw SQL against it.
import type { PrepPacketContent } from "../apply/prep.js";
import { getDb } from "./db.js";
import type { DbOption } from "./gigs.js";
import type { StoredInterviewPrep } from "./types.js";

interface InterviewPrepRow {
  gig_key: string;
  content: string;
  generated_at: string;
}

function toStoredInterviewPrep(row: InterviewPrepRow): StoredInterviewPrep {
  return {
    gigKey: row.gig_key,
    content: JSON.parse(row.content) as PrepPacketContent,
    generatedAt: row.generated_at,
  };
}

/**
 * Persists a freshly-generated prep packet for `gigKey` — insert-or-replace:
 * a regenerated packet for a gig that already has one REPLACES it wholesale,
 * same discipline `saveDraft()` uses. `gigKey` must already exist in
 * `gigs` — `PRAGMA foreign_keys = ON` (db.ts) enforces the FK for real, not
 * just documents it.
 */
export function saveInterviewPrep(gigKey: string, content: PrepPacketContent, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO interview_prep (gig_key, content, generated_at)
     VALUES (:gig_key, :content, :now)
     ON CONFLICT(gig_key) DO UPDATE SET
       content = excluded.content,
       generated_at = excluded.generated_at`,
  ).run({ gig_key: gigKey, content: JSON.stringify(content), now });
}

/** Fetch one prep packet by its linked gig's key. */
export function getInterviewPrep(gigKey: string, opts: DbOption = {}): StoredInterviewPrep | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare("SELECT * FROM interview_prep WHERE gig_key = ?").get(gigKey) as InterviewPrepRow | undefined;
  return row ? toStoredInterviewPrep(row) : undefined;
}

/** List every persisted prep packet, newest-generated-first. */
export function listInterviewPrep(opts: DbOption = {}): StoredInterviewPrep[] {
  const db = opts.db ?? getDb();
  const rows = db.prepare("SELECT * FROM interview_prep ORDER BY generated_at DESC").all() as unknown as InterviewPrepRow[];
  return rows.map(toStoredInterviewPrep);
}
