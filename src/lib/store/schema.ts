// Single-table schema for persisted gigs.
//
// No migrations framework yet — this is idempotent (IF NOT EXISTS) and safe
// to run on every connection open. If the shape ever needs to change under
// existing data, add PRAGMA user_version-guarded ALTER TABLE steps here
// rather than editing the CREATE TABLE below out from under existing DBs.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gigs (
  key               TEXT PRIMARY KEY,   -- \`\${sourceId}:\${externalId}\`, see gigKey()
  source_id         TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  title             TEXT NOT NULL,
  company           TEXT,
  url               TEXT NOT NULL,      -- always the real listing url (see ARCHITECTURE.md)
  rate_min          REAL,
  rate_max          REAL,
  rate_unit         TEXT,               -- 'hour' | 'month' | 'year'
  weekly_hours      REAL,
  remote            INTEGER,            -- 0/1, nullable (unknown != false)
  contract_to_hire  INTEGER,            -- 0/1, nullable
  stage             TEXT,               -- 'fresh' | 'stale' | 'proposed' | 'unknown'
  posted_at         TEXT,               -- ISO date, as reported by the source
  description       TEXT,
  raw               TEXT,               -- JSON-stringified original payload, for debugging
  tier              TEXT                -- 'green' | 'yellow' | 'red', nullable (not yet classified); see matching/tiering.ts
                      CHECK (tier IS NULL OR tier IN ('green', 'yellow', 'red')),
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'applied', 'interview', 'archived', 'ignored')),
  first_seen        TEXT NOT NULL,      -- ISO datetime, set once, never overwritten
  last_seen         TEXT NOT NULL,      -- ISO datetime, bumped every scan the gig appears in
  unavailable_since TEXT,               -- ISO datetime, null while believed available
  reappeared_at     TEXT                -- ISO datetime of the most recent reappearance, if any
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gigs_source_external ON gigs(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_gigs_status ON gigs(status);
CREATE INDEX IF NOT EXISTS idx_gigs_unavailable ON gigs(unavailable_since);

-- LLM-drafted applications (assisted-apply-drafting epic,
-- draft-generation-foundation story). One row per gig, keyed by the SAME
-- gig_key gigs.key uses -- the FK is real, not just documented: PRAGMA
-- foreign_keys=ON (see db.ts) rejects an insert whose gig_key doesn't exist
-- in gigs. status is deliberately separate from gigs.status: a gig can have
-- a draft long before, or without ever, being marked "applied" -- see
-- store/drafts.ts's markDraftSubmitted() for the one transition (draft
-- 'submitted' + gig 'applied') that keeps both in sync, atomically.
CREATE TABLE IF NOT EXISTS application_drafts (
  gig_key      TEXT PRIMARY KEY REFERENCES gigs(key),
  content      TEXT NOT NULL,      -- JSON-stringified DraftContent ({coverText, answers})
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'approved', 'rejected', 'submitted')),
  generated_at TEXT NOT NULL,      -- ISO datetime, set on every saveDraft() (including regeneration)
  approved_at  TEXT,               -- ISO datetime, set when status -> 'approved'
  submitted_at TEXT                -- ISO datetime, set when status -> 'submitted'
) STRICT;
`;
