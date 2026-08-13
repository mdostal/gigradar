// Public API of the SQLite-backed Gig store. This is the only import path
// anything outside src/lib/store should use — see docs/ARCHITECTURE.md.
export { DEFAULT_BUSY_TIMEOUT_MS, closeDb, getDb } from "./db.js";
export { getDefaultDataDir, getDefaultDbPath } from "./path.js";
export { getGig, gigKey, listGigs, recordScan, setStatus } from "./gigs.js";
export type { DbOption, RecordScanOptions } from "./gigs.js";
export { getDraft, listDrafts, markDraftSubmitted, saveDraft, setDraftStatus } from "./drafts.js";
export type { GetDbOptions } from "./db.js";
export type { DraftFilter, DraftStatus, GigFilter, GigStatus, ScanSummary, SourceScanBatch, StoredDraft, StoredGig } from "./types.js";
