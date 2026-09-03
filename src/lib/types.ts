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
 * customizable-tier-scoring epic. HOW a group's GREEN/YELLOW/RED tier gets
 * computed — an alternative to (never a change to) `tier()`'s existing
 * keyword classifier (matching/tiering.ts, UNCHANGED). Omitted on
 * `GroupConfig` means `{kind:"keyword"}`, byte-identical to every install
 * before this field existed — the owner's own words, 2026-09-02: "keep it
 * green for now" (don't disturb existing tiering) "but that needs to be a
 * score" (make GREEN/YELLOW/RED customizable off the real, already-
 * computed `MatchResult.score`, not just keywords).
 *
 * - `"keyword"`: today's classifier, unchanged (matching/tiering.ts's
 *   coreTitles/redKeywords/keywords precedence).
 * - `"score-threshold"`: a gig's own `score` (0-1, matching/gate.ts's
 *   scoreOf() — rate/fit/hours/freshness composite) is compared directly
 *   against two fixed cutoffs. `green`/`yellow` are each in [0,1];
 *   `green` must be >= `yellow` (config/schema.ts's `.refine()` enforces
 *   this — a lower green cutoff than yellow would make green unreachable
 *   before yellow, a config the UI should never accept).
 * - `"percentile"`: a gig's score is ranked against the CURRENT population
 *   of other tracked gigs' scores for this SAME group (only `status:
 *   "new"` gigs — "how does this compare to what I still need to decide
 *   on," not every gig ever seen). `greenPercentile`/`yellowPercentile`
 *   are each in [0,100] (e.g. `greenPercentile: 80` means "top 20% of
 *   current scores for this group is green"); `greenPercentile` must be
 *   >= `yellowPercentile`. The population is a snapshot taken once per
 *   scan cycle (matching/group-match.ts's `matchGroups()` stays a PURE
 *   function — the population is fetched by the caller, `apply/
 *   runner.ts`, via `store/gigs.ts`'s `listGroupScores()`, and passed in
 *   — never a DB read inside the matching pipeline itself), so ranking is
 *   necessarily approximate on a nearly-empty group and self-improves as
 *   more gigs accumulate real scores.
 */
export type TierScoringMode =
  | { kind: "keyword" }
  | { kind: "score-threshold"; green: number; yellow: number }
  | { kind: "percentile"; greenPercentile: number; yellowPercentile: number };

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
  /**
   * multi-group-architecture epic: which group(s) this source's gigs get
   * evaluated against. Omitted (the default) means EVERY group — a
   * source is shared across every search unless deliberately scoped down
   * (e.g. a drone-parts-specific board that obviously shouldn't be
   * evaluated against a "fractional CTO" group's criteria at all).
   */
  groupIds?: string[];
  /**
   * platform-aware-application-drafting epic. Overrides the registered
   * `Source.applicationFormat` default (if any) for this specific source
   * instance — the one place a user/preset controls draft tone for a
   * `custom-llm`/`gmail-digest` source, which has no static `Source`
   * object of its own to hang a default on. Omitted means "use the
   * registered Source's own default, or 'cover-letter' if neither is
   * set" — see `apply/draft.ts`'s `resolveApplicationFormat()`.
   */
  applicationFormat?: DraftFormat;
}

/**
 * One named "search" — its own accept-criteria (`needs`) and role-area
 * classifier (`roleArea`), evaluated independently. multi-group-
 * architecture epic — owner's own words, 2026-09-01: "I could do a
 * software engineer full time role separately from the fractional CTO
 * role separately from a drone photographer role... it can cross over
 * and be in multiple lists but still if we apply, we only apply to the
 * singular gig ONCE." A gig can clear zero, one, or several groups at
 * once (see `matching/group-match.ts`'s `matchGroups()`) — a group never
 * OWNS a gig, the same way an `EngagementProfile` never owns one today
 * (`Gig.matchedProfileIds` already allows several). `Config.groups`
 * replaces this interface's own pre-multi-group flat `needs`/`roleArea`
 * fields — see `config/load.ts`'s `migrateFlatNeedsRoleAreaToGroups()`
 * for how an existing single-search config.json upgrades transparently.
 */
export interface GroupConfig {
  /** Stable slug, e.g. "default-search-1" — referenced by Gig.matchedGroupIds/matchedGroupTiers, never re-derived from label (which the user can freely rename). */
  id: string;
  /** User-facing name shown in the dashboard/config UI, e.g. "Fractional CTO Search". */
  label: string;
  needs: Needs;
  /** Optional, same do-nothing-default semantics as the old Config.roleArea: omitted => every gig tiers "yellow" for this group. */
  roleArea?: RoleAreaConfig;
  /**
   * ai-match-verification epic. Opt-in, off by default (keyword-only
   * heuristic matching, byte-identical to before this field existed):
   * when true, every gig this group's heuristic gate/tier already matched
   * gets a SECOND, LLM-driven check (`matching/ai-verify.ts`'s
   * `verifyGroupMatch()`) — a real semantic read on whether the gig's
   * actual ROLE TYPE fits this group's intent, catching cases keyword
   * matching can't (e.g. "Interim Finance Director" matching on the
   * generic word "interim" despite being nowhere near an engineering
   * role). Only runs for gigs that ALREADY heuristically matched this
   * group — never a replacement for the gate, never spent on gigs that
   * already failed it. A gig the AI does NOT confirm is removed from this
   * group's `Gig.matchedGroupIds` for THIS group only; the verdict and
   * reason are always recorded on `Gig.aiFlags[group.id]`, confirmed or
   * not, so nothing is silently dropped without a trace. Requires a
   * resolved LLM credential at scan time (same `resolveLlmCredential()`
   * every other LLM call site uses) — silently skipped (heuristic result
   * stands, no `aiFlags` entry) for a cycle with none, same graceful-
   * degradation posture as `Config.autoDraftOnScan`.
   */
  aiVerify?: boolean;
  /**
   * customizable-tier-scoring epic. Omitted means `{kind:"keyword"}` —
   * byte-identical to every install before this field existed. See
   * `TierScoringMode`'s own doc comment above for the full contract.
   */
  tierScoring?: TierScoringMode;
}

/** Full user configuration. Lives in the user's own storage, never in the repo. */
export interface Config {
  profile: Profile;
  sources: SourceConfig[];
  /**
   * At least one group is always required — there is no valid "zero
   * groups" state (mirrors `Needs.engagementProfiles`'s own existing
   * `.min(1)` precedent; a gig that can never match anything is a worse
   * silent-failure mode than requiring at least one, even
   * do-nothing-configured, group to exist).
   */
  groups: GroupConfig[];
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
   * Opt-in: when true, marking a gig "applied" (dashboard's status change,
   * updateGigStatusAction) best-effort auto-generates and persists its
   * interview prep packet (generatePrepPacket()/saveInterviewPrep(), same
   * call the dashboard's own "Generate prep packet" button makes) if one
   * doesn't already exist — never regenerates an existing one, never blocks
   * or fails the status change itself if generation errors (missing API
   * key, LLM failure): the failure is swallowed, same "best-effort,
   * status-change-is-the-one-thing-that-must-succeed" discipline as
   * notifyOnGreenMatch's own notification-failure handling above.
   * Omitted/false => no behavior change from before this flag existed —
   * same "meaningful, valid do-nothing default" pattern as
   * autoDraftOnScan/notifyOnGreenMatch. Owner's own words: "when the
   * research and that happens can be manually or automated (make it a
   * configuration so we can change in settings)" — "research" here is this
   * prep packet (fit/gap analysis, predicted questions, ATS check), the
   * one piece of per-gig "figure out what I'm getting into" work this
   * codebase does; dashboard-redesign story, product-review-followups epic.
   */
  autoPrepOnApply?: boolean;
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
  /**
   * ui-theme-system epic: which visual theme to render Dashboard/Config/
   * Issues in. Omitted defaults to "signal-deck" (gigradar-command-center
   * epic: promoted to default over the original "radar" theme, which
   * remains selectable) — same "meaningful, valid do-nothing default, no
   * migration needed for existing installs" pattern as appIcon above. Not
   * a secret, cosmetic only.
   */
  uiTheme?: "radar" | "editorial" | "terminal" | "signal-deck" | "signal-desk";
  /**
   * llm-provider-harness epic (supersedes llm-credential-modes' original
   * "oauth-token" kind -- live-tested and found non-functional). "api-key"
   * (today's only real behavior -- a raw key for `llmProvider` below, sent
   * via the AI SDK) or "claude-code-harness" (drives the local,
   * already-authenticated `claude` CLI directly, no secret value stored or
   * resolved for this kind at all). Omitted means "api-key",
   * byte-identical to every install before this field existed — see
   * env-store.ts's resolveLlmCredential() and llm-client.ts's
   * createAiSdkModel().
   */
  llmCredentialKind?: "api-key" | "claude-code-harness";
  /**
   * llm-provider-harness epic. Which provider's api-key mode uses --
   * meaningless when llmCredentialKind is "claude-code-harness". Omitted
   * means "anthropic", byte-identical to every install before this field
   * existed.
   */
  llmProvider?: "anthropic" | "openai" | "google";
  /**
   * chat-copilot-self-tuning epic. Opt-in, off by default (same
   * "omitted/false are identical, no tri-state" pattern as
   * autoDraftOnScan) -- when true, the chat co-pilot's propose_config_edit
   * tool skips its normal approve/reject pause and auto-executes
   * immediately, returning a distinct "auto_applied" chat event the UI
   * renders as a mandatory warning banner rather than silently applying
   * the change (owner's own words: "a toggle enabling it to auto fire
   * with a popup warning"). Applies ONLY to propose_config_edit -- every
   * other chat write tool (update_gig_status, generate_draft, etc.) is
   * completely unaffected by this toggle; see
   * agent-chat-loop.ts's runTurnLoop() for the exact scope boundary.
   */
  chatAutoApproveConfigEdits?: boolean;
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
  /**
   * multi-group-architecture epic — every `GroupConfig.id` this gig
   * cleared (its gate passed), stamped on by the runner from
   * `matchGroups()`. Same "optional, stamped after gate(), rides through
   * the store's normal upsert path" pattern as `matchedProfileIds` above
   * — a group never OWNS a gig, several can match at once.
   */
  matchedGroupIds?: string[];
  /**
   * Every group's OWN tier result (`Record<groupId, Tier>`), independent
   * of whether that group's gate passed — mirrors how `tier` above is
   * already independent of gate pass/fail. Lets a future per-group
   * dashboard show "green for your fractional-CTO search, yellow for
   * your SWE search" for the same real gig.
   */
  matchedGroupTiers?: Record<string, Tier>;
  /**
   * ai-match-verification epic — one entry per `GroupConfig.id` whose
   * `aiVerify: true` actually ran an LLM check on this gig (see
   * `GroupConfig.aiVerify`'s own doc comment), `confirmed`/`reason` from
   * `matching/ai-verify.ts`'s `verifyGroupMatch()`. A group this gig
   * never heuristically matched, or whose `aiVerify` is off/unset, or
   * that ran with no LLM credential resolved, has NO entry here — this is
   * an audit trail of checks that actually happened, never a full
   * per-group map.
   */
  aiFlags?: Record<string, { confirmed: boolean; reason: string }>;
  /**
   * customizable-tier-scoring epic. The FIRST in-scope ("primary") group's
   * own `MatchResult.score` (matching/gate.ts's `scoreOf()` — a 0-1
   * rate/fit/hours/freshness composite), persisted for the first time
   * (previously computed fresh every scan and thrown away — see
   * matching/gate.ts's `gate()`). Same backward-compat anchoring
   * convention as the flat `tier`/`matchedProfileIds` fields above.
   */
  matchScore?: number;
  /** Every in-scope group's OWN score (`Record<groupId, number>`), independent of pass/fail — mirrors `matchedGroupTiers`'s own "recorded regardless of gate outcome" convention. Feeds `TierScoringMode`'s "score-threshold"/"percentile" computation. */
  matchedGroupScores?: Record<string, number>;
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
  /**
   * platform-aware-application-drafting epic. Which real application UX
   * this draft was written for — deep-dive-audit-and-testing-framework's
   * own finding (2026-09-02) confirmed drafting was 100% platform-
   * agnostic before this field existed, always producing one generic
   * "email cover letter" shape regardless of whether the real platform
   * wants a marketplace proposal (Catalant), a single "why are you a
   * fit" pitch (GoFractional), a traditional cover letter + resume
   * upload (Indeed), or a handful of short form-field answers with no
   * real cover letter at all (LinkedIn Easy-Apply-style). Omitted
   * (existing/legacy drafts, or a platform gigradar has no specific
   * knowledge of) means "cover-letter" — today's original, universal
   * shape, byte-identical to before this field existed. The field name
   * stays `coverText` regardless of format (never renamed) — for
   * `"proposal"`/`"why-fit"` it holds that format's own primary text;
   * for `"form-fields"` it's typically empty and `answers` carries
   * everything.
   */
  format?: DraftFormat;
}

/**
 * platform-aware-application-drafting epic. See `DraftContent.format`'s
 * own doc comment for what each value means. Deliberately a closed,
 * small enum rather than free text — `generateDraft()` branches its
 * PROMPT WORDING (never its output schema) on this value, and the
 * review UI branches its section label the same way; an open-ended
 * string would defeat both.
 */
export type DraftFormat = "cover-letter" | "proposal" | "why-fit" | "form-fields";

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
