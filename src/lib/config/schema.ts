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

/** Mirrors `Needs` in src/lib/types.ts — every field here is required (the gate's hard constraints). */
export const NeedsSchema = z.object({
  minRate: z.number(),
  highRate: z.number(),
  maxHours: z.number(),
  maxHoursAtHighRate: z.number(),
  allowContractToHire: z.boolean(),
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
});

/** Mirrors `SourceConfig` in src/lib/types.ts. `settings` is intentionally opaque — never raw secrets. */
export const SourceConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Mirrors `Config` in src/lib/types.ts exactly. `roleArea`, `schedule`,
 * `applyProfile`, and `autoDraftOnScan` MUST stay `.optional()` — see the
 * file-level comment above and types.ts's doc comments for why defaulting or
 * requiring them would be wrong.
 */
export const ConfigSchema = z.object({
  profile: ProfileSchema,
  needs: NeedsSchema,
  sources: z.array(SourceConfigSchema),
  roleArea: RoleAreaConfigSchema.optional(),
  schedule: z.string().optional(),
  applyProfile: ApplyProfileConfigSchema.optional(),
  autoDraftOnScan: z.boolean().optional(),
});
