// Public API of the SQLite-backed Gig store. This is the only import path
// anything outside src/lib/store should use — see docs/ARCHITECTURE.md.
export { DEFAULT_BUSY_TIMEOUT_MS, closeDb, getDb } from "./db.js";
export { getDefaultDataDir, getDefaultDbPath } from "./path.js";
export { getGig, gigKey, listGigs, listGroupScores, recordScan, setOutcome, setRankBucket, setStatus, setTier } from "./gigs.js";
export type { DbOption, RecordScanOptions } from "./gigs.js";
export { ARCHIVE_AFTER_DAYS, RETIER_AFTER_DAYS, runStaleGigMaintenance } from "./maintenance.js";
export type { StaleGigMaintenanceResult } from "./maintenance.js";
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
export { getLastScanCycle, recordScanCycle } from "./scan-cycles.js";
export type { RecordScanCycleInput } from "./scan-cycles.js";
export { listResumeReviewSuggestions, saveResumeReviewSuggestion } from "./resume-reviews.js";
export type { ResumeReviewSuggestion } from "./resume-reviews.js";
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
  StoredScanCycle,
} from "./types.js";
