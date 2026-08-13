// Core domain types for gigradar. One place; everything imports from here.

/** Who you are and what you're looking for — the user's config. */
export interface Profile {
  /** Display name / owner (never required to be real for OSS users). */
  name: string;
  /** Roles you present as, in priority order. Used for fit-matching. */
  roles: string[]; // e.g. ["Fractional CTO", "Principal Architect", "AI Engineering Advisor"]
  /** Free-text skills / keywords that signal fit. */
  skills: string[];
  /** Where you can work from (timezone the sources are matched against). */
  timezone: string; // IANA, e.g. "America/Chicago"
  /** Home location, optional — used only if a source scores distance. */
  homeBase?: { city: string; lat: number; lng: number };
}

/** Your hard constraints — the GO/NO-GO gate is built from these. */
export interface Needs {
  minRate: number;            // floor hourly rate ($)
  /** A higher rate that unlocks more weekly hours (see maxHoursAtHighRate). */
  highRate: number;           // e.g. 250
  maxHours: number;           // normal weekly-hours ceiling, e.g. 20
  maxHoursAtHighRate: number; // hours ceiling allowed when rate >= highRate, e.g. 40
  allowContractToHire: boolean; // reject CTH by default
  freshStageOnly: boolean;    // reject stale / already-proposed listings
  remoteOnly: boolean;
}

/** GREEN/YELLOW/RED role-area classification — see matching/tiering.ts. */
export type Tier = "green" | "yellow" | "red";

/**
 * User-supplied keyword sets for the role-area GREEN/YELLOW/RED classifier
 * (see matching/tiering.ts). The core ships with zero keywords in it — every
 * string here is something the user configures for themselves. Hardcoding
 * any specific person's job titles/keywords in src/lib would violate this
 * repo's core/user-layer boundary (docs/ARCHITECTURE.md).
 *
 * There is deliberately no keyword list for "yellow": yellow is the
 * unmatched fallback tier ("surface it, worth a look"), never something you
 * opt into or a hard reject — see tiering.ts's precedence order.
 */
export interface RoleAreaConfig {
  /**
   * Unambiguous title matches — "this IS my target role" (e.g. a user's
   * exact job-title synonyms). Checked against the gig TITLE only. Wins over
   * everything else, including a redKeywords hit in that same title.
   */
  coreTitles: string[];
  /** Broader green-signal keywords, checked against title+description, only once coreTitles/redKeywords have both missed. */
  keywords: string[];
  /** Title-only "definitely not this" signals (e.g. adjacent-but-wrong roles/domains). Only a hard stop when no coreTitles match. */
  redKeywords: string[];
}

/**
 * Apply-specific fields a real application form needs that `Profile`
 * doesn't hold today — email, phone, LinkedIn, a short headline/bio, and a
 * single rate figure to anchor when a form asks for one. Optional on
 * `Config` (see below): omitted means "not configured yet," the same valid,
 * do-nothing default `roleArea`/`schedule` already establish — never an
 * error. See `apply/draft.ts`'s `generateDraft()` and
 * `apply/runner.ts`'s `stageApplication()`, which throws a specific error
 * when this is unset rather than attempting a degraded draft.
 */
export interface ApplyProfileConfig {
  email: string;
  phone?: string;
  linkedInUrl?: string;
  headline?: string;
  bio?: string;
  /** The single number to anchor when a form asks for a rate. */
  rateAnchor?: number;
}

/** A source the user has enabled (a job platform / board / feed). */
export interface SourceConfig {
  id: string;                 // matches a registered Source.id
  enabled: boolean;
  /** Opaque per-source settings (session cookie ref, query, etc.). Never store raw secrets here in OSS — reference an env/keychain entry. */
  settings?: Record<string, unknown>;
}

/** Full user configuration. Lives in the user's own storage, never in the repo. */
export interface Config {
  profile: Profile;
  needs: Needs;
  sources: SourceConfig[];
  /**
   * Optional role-area keyword config for the GREEN/YELLOW/RED classifier
   * (matching/tiering.ts). Omitted => every gig tiers "yellow" (nothing to
   * match against yet), which is the correct do-nothing default, not an error.
   */
  roleArea?: RoleAreaConfig;
  /** Cron cadence, e.g. "0 9 * * *" (daily 9am). */
  schedule?: string;
  /**
   * Optional apply-specific profile fields (email/phone/LinkedIn/headline/
   * bio/rate anchor) `generateDraft()` needs to fill a real application.
   * Omitted => `stageApplication()` throws, pointing the user at /config,
   * rather than drafting with garbled/missing contact fields — see
   * `ApplyProfileConfig`'s own doc comment.
   */
  applyProfile?: ApplyProfileConfig;
}

/** A normalized gig, whatever source it came from. */
export interface Gig {
  sourceId: string;
  externalId: string;         // stable id within the source (for dedup)
  title: string;
  company?: string;
  url: string;                // the REAL listing url, never a search page
  rate?: { min?: number; max?: number; unit: "hour" | "month" | "year" };
  weeklyHours?: number;
  remote?: boolean;
  contractToHire?: boolean;
  stage?: "fresh" | "stale" | "proposed" | "unknown";
  postedAt?: string;          // ISO date
  description?: string;
  raw?: unknown;              // original payload for debugging
  /**
   * GREEN/YELLOW/RED role-area classification (matching/tiering.ts). NOT set
   * by a Source — a source only reports what the listing itself says. The
   * runner computes this via tier() after gate() and stamps it on here so it
   * rides through the store's normal upsert path (see store/gigs.ts) instead
   * of recordScan()/SourceScanBatch needing a parallel shape just to carry
   * one extra value alongside each Gig.
   */
  tier?: Tier;
}

/**
 * One LLM-drafted application: a cover message plus any structured answers
 * to application-specific questions the gig listing implies (keyed by
 * question text; empty object if none apply). Produced by
 * `apply/draft.ts`'s `generateDraft()`, grounded strictly in real
 * `Profile`/`ApplyProfileConfig`/`Gig` data — never fabricated. Persisted
 * JSON-stringified in `application_drafts.content` (`src/lib/store/`).
 */
export interface DraftContent {
  coverText: string;
  answers: Record<string, string>;
}

/** The gate's verdict on a single gig — always explainable. */
export interface MatchResult {
  gig: Gig;
  pass: boolean;
  /** Why it passed or failed — one human-readable reason per checked rule. */
  reasons: string[];
  /** 0..1 fit score for ranking the passers. */
  score: number;
  /**
   * GREEN/YELLOW/RED role-area classification from matching/tiering.ts.
   * Optional (wrapped-in, not required) rather than a plain field because
   * gate() itself has no opinion on role-area fit and still returns a fully
   * valid MatchResult on its own — tiering is a second, independent
   * classification pass the runner merges in afterward (see apply/runner.ts),
   * not part of the gate's pass/fail verdict. Also mirrored onto
   * `gig.tier` — see that field's doc for why.
   */
  tier?: Tier;
}
