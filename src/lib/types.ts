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

/**
 * The engagement types a Gig can be, or a user can declare acceptable.
 * "contract-to-hire" is deliberately its own value, not folded into
 * "contract" — a user who wants pure contract work but not a CTH pipeline
 * (or vice versa) needs to be able to say so distinctly, same as this
 * project's pre-existing (now-superseded) `allowContractToHire` flag did.
 */
export type EngagementType = "contract" | "fractional" | "contract-to-hire" | "full-time";

/**
 * One named rate/hours threshold for a set of engagement types — e.g.
 * "Fractional/contract" at $250/hr, or "Full-time (700k+)" at $700,000/yr.
 * `Needs.engagementProfiles` is a LIST of these (a user can have several:
 * different roles, different minimum bars for different engagement types)
 * — every profile whose `types` covers a gig's engagement type is checked,
 * and a gig can clear more than one (matching/gate.ts's gate() reports
 * every profile id a gig matched under, not just the first).
 *
 * `maxHours`/`maxHoursAtHighRate` only apply when `rateUnit === "hour"` — a
 * salaried/`"year"` profile has no weekly-hours concept in this schema
 * (full-time roles aren't gated on hours/week here).
 */
export interface EngagementProfile {
  /** Stable slug, e.g. "fractional-contract" — referenced by Gig.matchedProfileIds, never re-derived from label (which the user can freely rename). */
  id: string;
  /** User-facing name shown in match reasons/dashboard, e.g. "Fractional/contract". */
  label: string;
  /** Which engagement type(s) this profile covers. Usually one; contract+fractional commonly share a profile since they're priced the same way. */
  types: EngagementType[];
  minRate: number;
  /** A higher rate that unlocks more weekly hours (see maxHoursAtHighRate) — only meaningful when rateUnit is "hour". */
  highRate: number;
  /**
   * Weekly-hours caps — REQUIRED when `rateUnit === "hour"`, omitted when
   * `rateUnit === "year"` (a salaried profile has no weekly-hours concept
   * in this schema). config/schema.ts's EngagementProfileSchema enforces
   * this conditional requirement at validation time via `.refine()`.
   */
  maxHours?: number;
  maxHoursAtHighRate?: number;
  /** "hour" for contract/fractional/contract-to-hire work; "year" for full-time (total annual compensation). */
  rateUnit: "hour" | "year";
}

/** Your hard constraints — the GO/NO-GO gate is built from these. */
export interface Needs {
  /**
   * Ranked (display-order, not priority-order — see gate.ts, EVERY matching
   * profile is checked, not just the first) list of accepted
   * engagement-type + rate combinations. At least one profile is required —
   * this is the gate's rate/hours/engagement-type hard constraint set,
   * superseding the old flat `minRate`/`highRate`/`maxHours`/
   * `maxHoursAtHighRate`/`allowContractToHire` fields. A config.json still
   * using that old flat shape is migrated on read into a single default
   * profile (see config/load.ts's migrateNeedsEngagementProfiles()).
   */
  engagementProfiles: EngagementProfile[];
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
  /** career-documents epic: a path reference to an encrypted-at-rest resume file (see src/lib/documents/resume-store.ts). Omitted = no resume on file, not an error. */
  resumePath?: string;
  /** career-documents epic, persisted-links story: portfolio/GitHub/personal-site links -- generalizes linkedInUrl (kept unchanged) into a real list. Read by buildApplicantDataBlock() so every LLM call site (generateDraft, generatePrepPacket) picks it up automatically. */
  links?: string[];
}

/** A source the user has enabled (a job platform / board / feed). */
export interface SourceConfig {
  id: string;                 // matches a registered Source.id, OR any user-chosen id when kind is set
  enabled: boolean;
  /**
   * llm-custom-sources epic: when set to `"custom-llm"`, `id` is NOT looked
   * up in the static `registerSource()` registry at all — `runner.ts`
   * routes it to the single generic `customLlmSource` (src/lib/sources/
   * custom-llm-source.ts) instead, which reads everything it needs
   * (`settings.url`, `settings.hint`, etc.) from THIS config entry. Absent
   * (every hand-written adapter) is today's behavior, byte-identical.
   *
   * `"gmail-digest"` (email-digest-ingestion epic): same fallback-routing
   * mechanism, extended a second time — routes to `gmailDigestSource`
   * (src/lib/sources/gmail-digest-source.ts) instead.
   */
  kind?: "custom-llm" | "gmail-digest";
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
  /**
   * Opt-in: when true, each scheduled scan cycle (src/scheduler/index.ts's
   * runCycle()) auto-generates a real draft (stageApplication(), unmodified)
   * for new green-tier matches — capped at 5/cycle, skipping any gig that
   * already has a draft (any status), and skipping entirely for the cycle
   * (with one clear log line, not per-gig spam) if ANTHROPIC_API_KEY or
   * applyProfile isn't configured. Omitted/false => no behavior change from
   * before this flag existed — same "omission is a meaningful, valid
   * do-nothing default" pattern as roleArea/schedule/applyProfile above.
   * Auto-DRAFTING only, never auto-SUBMITTING — see
   * .pHive/epics/auto-draft-on-scan/docs/design-discussion.md.
   */
  autoDraftOnScan?: boolean;
  /**
   * Opt-in: when true, each scheduled scan cycle that finds one or more
   * BRAND-NEW (never seen before this cycle) green-tier matches fires one
   * best-effort desktop notification summarizing them (see
   * src/lib/notify/desktop.ts) — never per-gig spam, never more than one
   * notification per cycle. A notification failure (unsupported platform,
   * missing OS notification tool) is logged and swallowed, never breaks the
   * scan. Omitted/false => no behavior change from before this flag
   * existed — same "omission is a meaningful, valid do-nothing default"
   * pattern as autoDraftOnScan above.
   */
  notifyOnGreenMatch?: boolean;
  /**
   * Opt-in, per-`(sourceId, tier)` real submission automation
   * (graduated-auto-fire-trust epic) — see `src/lib/apply/autofire.ts`'s
   * `evaluateAutoFire()`. Omitted => auto-fire never runs for anything, the
   * correct do-nothing default, same pattern as `autoDraftOnScan`/
   * `notifyOnGreenMatch` above. `killSwitch: true` stops EVERY pair
   * unconditionally, checked before any per-pair rule is even loaded --
   * the fast "turn it all off" path.
   */
  autoFire?: {
    killSwitch?: boolean;
    rules: AutoFireRuleConfig[];
  };
  /**
   * Which app-icon option (favicon + in-app header mark) to render — an id
   * from `APP_ICONS` in src/lib/app-icons.ts. Omitted (or an id that no
   * longer exists) falls back to `DEFAULT_APP_ICON_ID` there, never an
   * error — same "meaningful, valid do-nothing default" pattern as the
   * other optional fields on this interface. Not a secret, cosmetic only.
   */
  appIcon?: string;
}

/**
 * One `(sourceId, tier)` pair's auto-fire trust configuration
 * (graduated-auto-fire-trust epic). `minApprovals` is the graduation
 * threshold -- see `approvedCount()`/`isGraduated()` in
 * `src/lib/apply/autofire.ts`. `dailyCap` bounds how many auto-fires this
 * pair can trigger per day even once graduated and enabled.
 */
export interface AutoFireRuleConfig {
  sourceId: string;
  tier: Tier;
  enabled: boolean;
  minApprovals: number;
  dailyCap: number;
}

/**
 * One row of `evaluateAutoFire()`'s append-only decision log
 * (`autofire_decisions` table, graduated-auto-fire-trust epic) -- written
 * for EVERY evaluation, fired or not, so a config-drift question ("why did
 * this fire / why didn't it") is always answerable from real history, not
 * current config state (which may have changed since).
 */
export interface AutoFireDecision {
  gigKey: string;
  decidedAt: string;
  fired: boolean;
  reasons: string[];
  /** The AutoFireRuleConfig in effect at decision time, or undefined when no per-pair rule was ever loaded (e.g. the kill switch stopped evaluation first). */
  ruleSnapshot?: AutoFireRuleConfig;
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
  /**
   * A source's EXPLICIT engagement-type signal, when it has one (e.g.
   * BuiltIn's JobPosting JSON-LD `employmentType: "FULL_TIME"` —
   * live-confirmed present on real listings). Deliberately 3-way, not
   * 4-way: "contract-to-hire" is never set here — that signal already has
   * its own dedicated `contractToHire` field above, which
   * matching/gate.ts's effectiveEngagementType() takes priority over this
   * field. Unset (most sources/listings) means "no explicit source
   * signal" — the gate falls back to inferring from `rate.unit` instead of
   * treating this as "unknown, always passes."
   */
  employmentType?: "contract" | "fractional" | "full-time";
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
  /**
   * `EngagementProfile.id`s this gig cleared, stamped on by the runner from
   * `MatchResult.matchedProfiles` — same "optional because a raw
   * Source-returned Gig hasn't been through gate() yet, stamped by the
   * runner afterward, rides through the store's normal upsert path"
   * pattern as `tier` above. An adapter's `fetch()` never sets this.
   */
  matchedProfileIds?: string[];
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
  /**
   * Every `EngagementProfile.id` this gig cleared (rate + hours), NOT just
   * the first one tried — a gig can legitimately satisfy several profiles
   * at once (e.g. both "Fractional/contract" and a separate
   * "Contract-to-hire" profile). Empty when `pass` is false because it
   * failed on engagement type/rate specifically (still possibly non-empty
   * alongside a `pass: false` if it cleared a profile's rate but failed a
   * DIFFERENT, non-profile check like role/skill fit — see gate.ts). Also
   * mirrored onto `gig.matchedProfileIds` for persistence, same pattern as
   * `tier` above.
   */
  matchedProfiles: string[];
}
