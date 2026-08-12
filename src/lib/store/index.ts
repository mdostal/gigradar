// Public API of the SQLite-backed Gig store. This is the only import path
// anything outside src/lib/store should use — see docs/ARCHITECTURE.md.
export { DEFAULT_BUSY_TIMEOUT_MS, closeDb, getDb } from "./db.js";
export { getDefaultDataDir, getDefaultDbPath } from "./path.js";
export { getGig, gigKey, listGigs, recordScan, setStatus } from "./gigs.js";
export type { DbOption, RecordScanOptions } from "./gigs.js";
export type { GetDbOptions } from "./db.js";
export type { GigFilter, GigStatus, ScanSummary, SourceScanBatch, StoredGig } from "./types.js";
