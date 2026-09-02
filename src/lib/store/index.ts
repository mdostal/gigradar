// Public API of the SQLite-backed Gig store. This is the only import path
// anything outside src/lib/store should use — see docs/ARCHITECTURE.md.
export { DEFAULT_BUSY_TIMEOUT_MS, closeDb, getDb } from "./db.js";
export { getDefaultDataDir, getDefaultDbPath } from "./path.js";
export { getGig, gigKey, listGigs, listGroupScores, recordScan, setOutcome, setStatus } from "./gigs.js";
export type { DbOption, RecordScanOptions } from "./gigs.js";
export {
  getDraft,
  listAutoFireDecisions,
  listDrafts,
  markDraftFailed,
  markDraftSubmitted,
  markDraftSubmitting,
  recordAutoFireDecision,
  saveDraft,
  setDraftStatus,
} from "./drafts.js";
export { getInterviewPrep, listInterviewPrep, saveInterviewPrep } from "./prep.js";
export {
  deleteChatSessionHistory,
  listChatPreferences,
  loadChatSessionHistory,
  recordChatPreference,
  saveChatSessionHistory,
} from "./chat.js";
export type { GetDbOptions } from "./db.js";
export type {
  DraftFilter,
  DraftStatus,
  GigFilter,
  GigStatus,
  OutcomeReason,
  ScanSummary,
  SourceScanBatch,
  StoredAutoFireDecision,
  StoredChatPreference,
  StoredDraft,
  StoredGig,
  StoredInterviewPrep,
} from "./types.js";
