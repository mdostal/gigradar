"use server";

// product-review-followups epic, setup-wizard story. The wizard's own
// final-save action -- deliberately separate from config/actions.ts's
// saveConfigAction() rather than reusing it directly, because the wizard
// only ever collects a KNOWN-sources enable/disable checklist (never the
// full raw sources array config-client.tsx's Settings editor works with),
// and saveConfig()'s top-level merge REPLACES `sources` wholesale --
// naively passing just the wizard's checked ids through would silently
// delete every custom source, per-source setting (sessionStatePath,
// custom-llm settings, etc.) not touched by this wizard. See
// docs/ARCHITECTURE.md's "Secrets"/config-write-path notes and this
// repo's CLAUDE.md for the shallow-merge contract this respects.
import { revalidatePath } from "next/cache";
import { actionErr } from "@/lib/actions/result";
import { readRawConfig, saveConfig } from "@/lib/config/save";
import { KNOWN_SOURCES } from "@/lib/sources/origins";
import type { ActionResult } from "@/lib/actions/result";
import type { Config, Needs, Profile, RoleAreaConfig } from "@/lib/types";

/**
 * Folds `enabledSourceIds` (a subset of KNOWN_SOURCES's own ids) into the
 * CURRENT raw sources array: an already-present KNOWN_SOURCES entry has
 * only its `enabled` flag flipped, preserving every other field
 * (settings.sessionStatePath, etc.) untouched; a not-yet-present one is
 * appended as a new minimal `{id, enabled}` entry. Every entry that isn't
 * a KNOWN_SOURCES id at all (a custom source, gmail-digest, etc.) is left
 * completely alone -- the wizard has no opinion on those.
 */
function mergeEnabledKnownSources(rawSources: unknown, enabledSourceIds: ReadonlySet<string>): Record<string, unknown>[] {
  const sources = Array.isArray(rawSources) ? [...(rawSources as unknown[])] : [];
  const knownIds = new Set(KNOWN_SOURCES.map((s) => s.id));

  for (const known of KNOWN_SOURCES) {
    const idx = sources.findIndex((s) => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === known.id);
    const enabled = enabledSourceIds.has(known.id);
    if (idx >= 0) {
      sources[idx] = { ...(sources[idx] as Record<string, unknown>), enabled };
    } else if (enabled) {
      // Only append a fresh entry for a NEWLY-enabled known source -- never
      // add a disabled placeholder for one the user never touched.
      sources.push({ id: known.id, enabled: true });
    }
  }

  return sources.filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null) as Record<string, unknown>[];
}

export interface WizardSaveInput {
  profile: Profile;
  needs: Needs;
  roleArea: RoleAreaConfig;
  enabledSourceIds: string[];
}

/**
 * The wizard's single save point -- everything collected across every step
 * lands here at once, on "Finish". Deliberately not a per-step incremental
 * save: an abandoned wizard run (closed the tab mid-flow) leaves the
 * user's real config.json completely untouched, not half-migrated.
 */
export async function saveWizardConfigAction(input: WizardSaveInput): Promise<ActionResult<Config>> {
  try {
    const raw = readRawConfig();
    const sources = mergeEnabledKnownSources(raw.sources, new Set(input.enabledSourceIds));

    // Slice 1 of the multi-group-architecture epic has no group-management
    // UI yet (Slice 2) — the wizard only ever edits the FIRST/primary group,
    // preserving its existing id/label (a re-run must update that group, not
    // spawn a second one) and falling back to the same migration default
    // (migrateFlatNeedsRoleAreaToGroups() in load.ts) on true first-run.
    const rawGroups = Array.isArray(raw.groups) ? (raw.groups as unknown[]) : [];
    const existingGroup = rawGroups[0];
    const groupId =
      existingGroup && typeof existingGroup === "object" && typeof (existingGroup as Record<string, unknown>).id === "string"
        ? ((existingGroup as Record<string, unknown>).id as string)
        : "default-search-1";
    const groupLabel =
      existingGroup && typeof existingGroup === "object" && typeof (existingGroup as Record<string, unknown>).label === "string"
        ? ((existingGroup as Record<string, unknown>).label as string)
        : "Default Search 1";

    const result = saveConfig({
      profile: input.profile,
      groups: [{ id: groupId, label: groupLabel, needs: input.needs, roleArea: input.roleArea }],
      sources,
    });
    if (!result.ok) return result;
    revalidatePath("/config");
    revalidatePath("/");
    return result;
  } catch (e) {
    return actionErr(e);
  }
}
