// zod schema for `Config` (src/lib/types.ts) — the source of truth this file
// mirrors field-for-field. Keep the two in sync by hand; there's no
// codegen step. `roleArea` and `schedule` are `.optional()` — never
// `.default()` and never coerced — because their omission is a MEANINGFUL,
// valid state (see types.ts's doc comments: no roleArea => every gig tiers
// "yellow", the correct do-nothing default, not an error condition).
import { z } from "zod";

const HomeBaseSchema = z.object({
  city: z.string(),
  lat: z.number(),
  lng: z.number(),
});

/** Mirrors `Profile` in src/lib/types.ts. */
export const ProfileSchema = z.object({
  name: z.string(),
  roles: z.array(z.string()),
  skills: z.array(z.string()),
  timezone: z.string(),
  homeBase: HomeBaseSchema.optional(),
});

/** Mirrors `EngagementType` in src/lib/types.ts. */
export const EngagementTypeSchema = z.enum(["contract", "fractional", "contract-to-hire", "full-time"]);

/**
 * Mirrors `EngagementProfile` in src/lib/types.ts. `maxHours`/
 * `maxHoursAtHighRate` are required only when `rateUnit === "hour"` — see
 * that field's doc comment — enforced here via `.refine()` since zod's
 * object shape alone can't express a conditional-on-a-sibling-field
 * requirement.
 */
export const EngagementProfileSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    types: z.array(EngagementTypeSchema).min(1),
    minRate: z.number(),
    highRate: z.number(),
    maxHours: z.number().optional(),
    maxHoursAtHighRate: z.number().optional(),
    rateUnit: z.enum(["hour", "year"]),
  })
  .refine((p) => p.rateUnit !== "hour" || (p.maxHours !== undefined && p.maxHoursAtHighRate !== undefined), {
    message: "maxHours and maxHoursAtHighRate are required when rateUnit is \"hour\"",
  });

/** Mirrors `Needs` in src/lib/types.ts — every field here is required (the gate's hard constraints). */
export const NeedsSchema = z.object({
  engagementProfiles: z.array(EngagementProfileSchema).min(1),
  freshStageOnly: z.boolean(),
  remoteOnly: z.boolean(),
});

/**
 * Mirrors `RoleAreaConfig` in src/lib/types.ts. All three keyword lists are
 * required WITHIN this object — but the object itself is optional on
 * `Config` (see ConfigSchema below). There is deliberately no "yellow"
 * list: yellow is the unmatched fallback tier, never something configured.
 */
export const RoleAreaConfigSchema = z.object({
  coreTitles: z.array(z.string()),
  keywords: z.array(z.string()),
  redKeywords: z.array(z.string()),
});

/**
 * Mirrors `TierScoringMode` in src/lib/types.ts (customizable-tier-scoring
 * epic). Each numeric-threshold variant is `.refine()`d so the "high"
 * cutoff (`green`/`greenPercentile`) can never be configured LOWER than
 * the "low" one (`yellow`/`yellowPercentile`) — a config the UI should
 * never accept, since green would then be unreachable before yellow.
 */
export const TierScoringModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keyword") }),
  z
    .object({ kind: z.literal("score-threshold"), green: z.number().min(0).max(1), yellow: z.number().min(0).max(1) })
    .refine((m) => m.green >= m.yellow, { message: "green threshold must be >= yellow threshold" }),
  z
    .object({ kind: z.literal("percentile"), greenPercentile: z.number().min(0).max(100), yellowPercentile: z.number().min(0).max(100) })
    .refine((m) => m.greenPercentile >= m.yellowPercentile, { message: "greenPercentile must be >= yellowPercentile" }),
]);

/**
 * Mirrors `GroupConfig.matchQuality` in src/lib/types.ts
 * (rate-band-match-quality epic). Both fields optional — omitted means
 * the documented defaults (15% tolerance, hide out-of-band on), same
 * "omission is a meaningful, valid do-nothing default" pattern every
 * other optional Config field already uses. Owner's own explicit
 * directive: every one of these numbers must be a real, editable
 * setting, never hardcoded — this schema is where that promise is kept.
 */
export const MatchQualityConfigSchema = z.object({
  nearBandTolerancePct: z.number().min(0).max(100).optional(),
  hideOutOfBandByDefault: z.boolean().optional(),
});

/**
 * Mirrors `GroupConfig` in src/lib/types.ts (multi-group-architecture
 * epic). `roleArea` stays `.optional()`, same do-nothing-default pattern
 * as the old top-level `Config.roleArea` it replaces.
 */
export const GroupConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  needs: NeedsSchema,
  roleArea: RoleAreaConfigSchema.optional(),
  aiVerify: z.boolean().optional(),
  tierScoring: TierScoringModeSchema.optional(),
  matchQuality: MatchQualityConfigSchema.optional(),
});

/**
 * Mirrors `ApplyProfileConfig` in src/lib/types.ts. Only `email` is
 * required within this object — the object itself is `.optional()` on
 * `Config` (see ConfigSchema below), same "omitted = not configured, not an
 * error" pattern as `RoleAreaConfigSchema`/`schedule`.
 */
export const ApplyProfileConfigSchema = z.object({
  email: z.string(),
  phone: z.string().optional(),
  linkedInUrl: z.string().optional(),
  headline: z.string().optional(),
  bio: z.string().optional(),
  rateAnchor: z.number().optional(),
  /** career-documents epic, resume-store story: a path reference to an encrypted-at-rest resume file (resume-store.ts's getResumePath()), same "path in config, real bytes on disk" convention as SourceConfig.settings.sessionStatePath. Omitted = no resume on file, not an error. */
  resumePath: z.string().optional(),
  /** career-documents epic, persisted-links story: portfolio/GitHub/personal-site links, generalizing linkedInUrl (kept unchanged). */
  links: z.array(z.string()).optional(),
});

/** Mirrors `SourceConfig` in src/lib/types.ts. `settings` is intentionally opaque — never raw secrets. `kind` absent (every hand-written adapter) is today's behavior, byte-identical (llm-custom-sources epic). */
export const SourceConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  kind: z.enum(["custom-llm", "gmail-digest"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** multi-group-architecture epic — see SourceConfig.groupIds's own doc comment in types.ts. Omitted = every group. */
  groupIds: z.array(z.string()).optional(),
});

/**
 * Mirrors `Config` in src/lib/types.ts exactly. `roleArea`, `schedule`,
 * `applyProfile`, `autoDraftOnScan`, `notifyOnGreenMatch`, and
 * `autoPrepOnApply` MUST stay `.optional()` — see the file-level comment
 * above and types.ts's doc comments for why defaulting or requiring them
 * would be wrong.
 */
/** Mirrors `Tier` in src/lib/types.ts (matching/tiering.ts's own green/yellow/red). */
const TierSchema = z.enum(["green", "yellow", "red"]);

/**
 * Mirrors `AutoFireRuleConfig` in src/lib/types.ts
 * (graduated-auto-fire-trust epic). `minApprovals`/`dailyCap` floors of 1
 * match that story's own design decision — a rule that could "graduate" at
 * 0 approvals or fire unboundedly per day defeats the whole point of a
 * trust threshold.
 */
export const AutoFireRuleConfigSchema = z.object({
  sourceId: z.string().min(1),
  tier: TierSchema,
  enabled: z.boolean(),
  minApprovals: z.number().int().min(1),
  dailyCap: z.number().int().min(1),
});

/**
 * Mirrors `Config["autoFire"]` in src/lib/types.ts. Like `applyProfile`/
 * `autoDraftOnScan`/`notifyOnGreenMatch` above, `autoFire` itself MUST stay
 * `.optional()` -- its omission means auto-fire never runs at all for
 * anything, the correct do-nothing default (see types.ts's doc comment).
 * `killSwitch` is independently `.optional()` inside it for the same
 * reason: omitted/false are behaviorally identical (normal operation).
 */
export const AutoFireConfigSchema = z.object({
  killSwitch: z.boolean().optional(),
  rules: z.array(AutoFireRuleConfigSchema),
});

export const ConfigSchema = z.object({
  profile: ProfileSchema,
  sources: z.array(SourceConfigSchema),
  // multi-group-architecture epic: replaces the old flat needs/roleArea
  // fields. At least one group is always required -- mirrors
  // Needs.engagementProfiles's own existing .min(1) precedent.
  groups: z.array(GroupConfigSchema).min(1),
  schedule: z.string().optional(),
  applyProfile: ApplyProfileConfigSchema.optional(),
  autoDraftOnScan: z.boolean().optional(),
  notifyOnGreenMatch: z.boolean().optional(),
  // dashboard-redesign story: see types.ts's Config.autoPrepOnApply doc comment.
  autoPrepOnApply: z.boolean().optional(),
  autoFire: AutoFireConfigSchema.optional(),
  appIcon: z.string().optional(),
  // ui-theme-system epic: see types.ts's Config.uiTheme doc comment.
  uiTheme: z.enum(["radar", "editorial", "terminal", "signal-deck", "signal-desk"]).optional(),
  /**
   * llm-provider-harness epic (supersedes llm-credential-modes' original
   * "oauth-token" kind -- live-tested and found non-functional: a
   * `claude setup-token` value rejected by api.anthropic.com when reused
   * as a bare Bearer credential outside the real `claude` process, see
   * that epic's design-discussion.md). "api-key" (today's only real
   * behavior -- a raw key for `llmProvider` below, sent via the AI SDK)
   * or "claude-code-harness" (drives the local, already-authenticated
   * `claude` CLI directly, via @anthropic-ai/claude-agent-sdk -- no
   * secret value stored or resolved for this kind at all). Absent/
   * undefined means "api-key", byte-identical to every install before
   * this field existed -- see env-store.ts's resolveLlmCredential() and
   * llm-client.ts's createAiSdkModel().
   */
  llmCredentialKind: z.enum(["api-key", "claude-code-harness"]).optional(),
  /**
   * llm-provider-harness epic. Which provider's api-key mode uses --
   * meaningless when llmCredentialKind is "claude-code-harness" (Anthropic-
   * only for now, see design-discussion.md section 3.5). Absent/undefined
   * means "anthropic", byte-identical to every install before this field
   * existed.
   */
  llmProvider: z.enum(["anthropic", "openai", "google"]).optional(),
  chatAutoApproveConfigEdits: z.boolean().optional(),
});
