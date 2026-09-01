// Types for the SQLite-backed Gig store. One place; everything in
// src/lib/store imports from here (mirrors the convention in ../types.ts).
import type { AutoFireRuleConfig, DraftContent, Gig } from "../types.js";
import type { PrepPacketContent } from "../apply/prep.js";

/**
 * Where a gig sits in your pipeline. Store-managed — sources/gate never set
 * this, only the user (via setStatus) or the store itself (new rows start
 * "new").
 */
export type GigStatus = "new" | "applied" | "interview" | "archived" | "ignored";

/**
 * WHY a gig ended up "archived" — a second dimension, orthogonal to
 * `GigStatus` itself (status-reconciliation-outcomes story, product-review-
 * followups epic). The owner's own words, 2026-09-01: "the ones we applied
 * to and got passed up by THEM (or they removed the contract)... versus...
 * any that we missed because they closed it or something (we didn't
 * apply)... so we can see if companies are all just withdrawing contracts
 * (we may be getting replaced by AI or cheaper rates) OR we are getting
 * passed up (our resume, positioning, experience, etc just isn't mapping
 * well)." `"ignored"` (the user's own "I don't like this one" choice) never
 * gets an outcomeReason — it's already self-explanatory and distinct from
 * anything COMPANY-driven, which is exactly what this field exists to
 * separate out.
 *
 * - `"rejected"` — we applied, the company explicitly said no (an
 *   application-status page's own "Passed"/"Rejected"/"Not Selected" label).
 * - `"withdrawn"` — we applied (or were mid-interview) and the listing
 *   later disappeared without an explicit rejection — the company likely
 *   pulled/filled/cancelled the role. Set either from a status label that
 *   means exactly this (Wellfound's "Expired") or automatically by
 *   recordScan() when an "applied"/"interview" gig goes unavailableSince.
 * - `"expired_unapplied"` — the listing disappeared before we ever applied
 *   at all — set automatically by recordScan() when a "new" gig goes
 *   unavailableSince. This is the "we missed it" bucket.
 */
export type OutcomeReason = "rejected" | "withdrawn" | "expired_unapplied";

/**
 * A Gig as persisted by the store: every field from `Gig` (../types.ts) plus
 * the bookkeeping fields only the store knows about. Re-scans never reset
 * `status` or `firstSeen` — see recordScan().
 */
export interface StoredGig extends Gig {
  /** `${sourceId}:${externalId}` — the store's primary key (see gigKey()). */
  key: string;
  status: GigStatus;
  /** See `OutcomeReason`'s own doc comment. Null while not (yet) known/applicable. */
  outcomeReason: OutcomeReason | null;
  /**
   * Freeform, human-readable context for `outcomeReason` — wherever
   * possible, the platform's OWN raw status-label text (e.g. "Passed",
   * "Expired"), never a fabricated summary. Null alongside a null
   * `outcomeReason`, and also null for an auto-computed `outcomeReason`
   * whose own doc comment already explains it fully (recordScan()'s two
   * delisting-driven cases set a real note too — see setOutcome() callers).
   */
  outcomeNote: string | null;
  /** ISO datetime of the first scan that ever saw this gig. Never moves once set. */
  firstSeen: string;
  /** ISO datetime of the most recent scan that saw this gig. */
  lastSeen: string;
  /**
   * ISO datetime this gig was first noticed missing from a source scan that
   * DID return other results — i.e. a real delisting signal, not a source
   * outage. Null while the gig is believed available. See recordScan().
   */
  unavailableSince: string | null;
  /**
   * ISO datetime this gig most recently reappeared in a scan after having
   * been unavailable. Kept as history — it is NOT cleared when the gig goes
   * unavailable again, only ever overwritten by a later reappearance.
   */
  reappearedAt: string | null;
}

/** One source's results for a single scan pass, as fed to recordScan(). */
export interface SourceScanBatch {
  sourceId: string;
  /**
   * Every gig this source returned this scan. MUST be an empty array (not
   * omitted) if the source ran fine but genuinely found nothing — that's
   * how recordScan tells "ran, found zero" apart from "didn't run at all".
   * Either way, a source with zero gigs never triggers delisting: only omit
   * a source from `batches` entirely when its fetch threw (see the runner's
   * `errors` list) — same rule, same non-effect on delisting.
   */
  gigs: Gig[];
}

/** Everything that happened in one recordScan() call — nothing silent. */
export interface ScanSummary {
  /** Every key upserted this scan, and whether it was a brand-new row. */
  upserted: { key: string; inserted: boolean }[];
  /** Keys that were unavailableSince before this scan and reappeared in it. */
  reappeared: string[];
  /**
   * Keys newly flagged unavailableSince this scan (real delisting signal
   * only). A key in here whose gig was `"new"` or `"applied"`/`"interview"`
   * ALSO just got auto-archived with an `OutcomeReason` stamped — see
   * flagUnavailableForSource()'s own doc comment in gigs.ts.
   */
  flaggedUnavailable: string[];
  /** Source ids that returned >=1 gig this scan (the delisting-eligible set). */
  sourcesWithResults: string[];
}

export interface GigFilter {
  status?: GigStatus;
  sourceId?: string;
  /** true = only currently-unavailable gigs, false = only currently-available, omit = both. */
  unavailable?: boolean;
}

/**
 * Where a draft sits in the review/approve workflow (store/drafts.ts).
 * Separate from `GigStatus` on purpose — a gig can have a draft long
 * before, or without ever, being marked "applied"; see markDraftSubmitted()
 * for the one transition that keeps both statuses in sync.
 */
export type DraftStatus = "draft" | "approved" | "rejected" | "submitted" | "submitting";

/** An `application_drafts` row as persisted by the store (store/drafts.ts). */
export interface StoredDraft {
  /** `${sourceId}:${externalId}` — same value as the linked gig's own key (gigKey()). */
  gigKey: string;
  /** Parsed from the row's JSON-stringified `content` column. */
  content: DraftContent;
  status: DraftStatus;
  /** ISO datetime — set on every saveDraft() call, including a regeneration. */
  generatedAt: string;
  /** ISO datetime, null until status transitions to 'approved'. */
  approvedAt: string | null;
  /** ISO datetime, null until status transitions to 'submitted'. */
  submittedAt: string | null;
}

export interface DraftFilter {
  status?: DraftStatus;
}

/** An `interview_prep` row as persisted by the store (store/prep.ts). */
export interface StoredInterviewPrep {
  /** `${sourceId}:${externalId}` — same value as the linked gig's own key (gigKey()). */
  gigKey: string;
  /** Parsed from the row's JSON-stringified `content` column. */
  content: PrepPacketContent;
  /** ISO datetime — set on every saveInterviewPrep() call, including a regeneration. */
  generatedAt: string;
}

/** An `autofire_decisions` row as persisted by the store (store/drafts.ts's recordAutoFireDecision()). */
export interface StoredAutoFireDecision {
  gigKey: string;
  decidedAt: string;
  fired: boolean;
  reasons: string[];
  /** null when no per-pair rule was ever loaded for this decision (e.g. the kill switch stopped evaluation first). */
  ruleSnapshot: AutoFireRuleConfig | null;
}
