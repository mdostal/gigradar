// resume-store-multi-resume-and-tailoring story. Persistence for the chat
// co-pilot's gated resume-review-suggestion tool (agent-chat-loop.ts's
// propose_resume_review) -- mirrors drafts.ts's/prep.ts's exact shape: a
// thin, typed layer over one table (`resume_review_suggestions`,
// schema.ts) -- the only place in the codebase that writes raw SQL against
// it. Append-only (see schema.ts's own header comment on this table): a
// row is written ONLY on explicit owner approval, never before, and never
// updated afterward.
import { getDb } from "./db.js";
import type { DbOption } from "./gigs.js";

export interface ResumeReviewSuggestion {
  gigKey: string;
  resumeId: string;
  summary: string;
  suggestions: string[];
  /** ISO datetime -- always set (this row is only ever written on approval, see this file's header comment). */
  approvedAt: string;
}

interface ResumeReviewRow {
  gig_key: string;
  resume_id: string;
  summary: string;
  suggestions: string;
  approved_at: string;
}

function toResumeReviewSuggestion(row: ResumeReviewRow): ResumeReviewSuggestion {
  return {
    gigKey: row.gig_key,
    resumeId: row.resume_id,
    summary: row.summary,
    suggestions: JSON.parse(row.suggestions) as string[],
    approvedAt: row.approved_at,
  };
}

/**
 * Persists an APPROVED resume-review suggestion -- always a fresh INSERT,
 * never an upsert (mirrors `autofire_decisions`' append-only audit-log
 * convention, not `saveDraft()`'s insert-or-replace one): a later
 * re-review of the same `(gigKey, resumeId)` pair is a NEW row, preserving
 * the history of what was suggested and when. `gigKey` must already exist
 * in `gigs` -- `PRAGMA foreign_keys = ON` (db.ts) enforces the FK for
 * real, matching `saveDraft()`'s/`saveInterviewPrep()`'s own discipline.
 */
export function saveResumeReviewSuggestion(
  gigKey: string,
  resumeId: string,
  summary: string,
  suggestions: string[],
  opts: DbOption & { now?: string } = {},
): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO resume_review_suggestions (gig_key, resume_id, summary, suggestions, approved_at)
     VALUES (:gig_key, :resume_id, :summary, :suggestions, :now)`,
  ).run({ gig_key: gigKey, resume_id: resumeId, summary, suggestions: JSON.stringify(suggestions), now });
}

/** Every approved resume-review suggestion for `gigKey`, newest-approved-first (a gig can accumulate several over time, one per review). */
export function listResumeReviewSuggestions(gigKey: string, opts: DbOption = {}): ResumeReviewSuggestion[] {
  const db = opts.db ?? getDb();
  const rows = db
    .prepare("SELECT * FROM resume_review_suggestions WHERE gig_key = ? ORDER BY approved_at DESC")
    .all(gigKey) as unknown as ResumeReviewRow[];
  return rows.map(toResumeReviewSuggestion);
}
