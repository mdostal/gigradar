"use server";

import { revalidatePath } from "next/cache";
import { getGig, saveInterviewPrep, setStatus } from "@/lib/store";
import type { GigStatus } from "@/lib/store";
import { actionErr, actionOk, type ActionResult } from "@/lib/actions/result";
import { stageApplication } from "@/lib/apply/runner";
import { generatePrepPacket, type PrepPacketContent } from "@/lib/apply/prep";
import { readEnvVar } from "@/lib/config/env-store";
import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";
import type { MatchResult } from "@/lib/types";

/**
 * Server Action wrapping `setStatus()` — the status-change control on the
 * dashboard's rows calls this. Establishes the shared Server Action
 * convention this epic's other Server Action (config-save, a later story)
 * reuses: a typed `{ok:true,data}|{ok:false,error}` return (see
 * src/lib/actions/result.ts) instead of letting `setStatus()`'s throw on an
 * unknown key cross the client/server boundary as an unhandled 500, AND an
 * explicit `revalidatePath()` call after every successful mutation.
 *
 * The `revalidatePath()` call is load-bearing, not decorative: without it,
 * Next's App Router can serve "/" from its Full Route Cache after a
 * production build (`next build && next start`), so a status change can
 * silently fail to show after a reload even though `setStatus()` itself
 * succeeded — this exact divergence is why this story required verifying
 * under both `next dev` and `next build && next start`, not just dev's
 * looser caching.
 */
export async function updateGigStatusAction(
  key: string,
  status: GigStatus,
): Promise<ActionResult<{ key: string; status: GigStatus }>> {
  try {
    setStatus(key, status);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/");
  return actionOk({ key, status });
}

// ---------------------------------------------------------------------------
// "Generate draft" (`draft-review-ui` story, `assisted-apply-drafting`
// epic) — the dashboard row action that calls the real `stageApplication()`
// (src/lib/apply/runner.ts) for a green/yellow-tier gig. The button itself
// is never rendered for a tier='red' row at all (dashboard-draft.ts's
// canGenerateDraft(), used by dashboard-client.tsx) — this action is a
// second, server-side line of defense, not the only guardrail: even a
// direct call here for a red-tier gig still hits stageApplication()'s own
// throw, surfaced verbatim below, never silently accepted.
// ---------------------------------------------------------------------------

/** The one, dedicated .env var this feature reads — same name/convention as src/app/config/actions.ts's resume-ingestion action. */
const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";

/**
 * Specific, actionable error when no Anthropic API key is set — mirrors
 * `src/app/config/actions.ts`'s `MISSING_API_KEY_ERROR`, reworded for this
 * action's own context (drafting, not resume extraction), never a generic
 * Anthropic SDK authentication failure.
 */
const MISSING_API_KEY_ERROR =
  'gigradar apply: no Anthropic API key is set. Enter one in the "Anthropic API key" field on /config, then try again.';

/**
 * Resolves the Anthropic API key via `readEnvVar()` — freshly, on every
 * call, exactly like `extractProfileFromResumeAction`
 * (src/app/config/actions.ts) — never `process.env` directly and never a
 * module-scope constant. This Next.js Server Action request path never
 * populates `process.env` from `.env` the way the CLI/cron path
 * (`loadConfig()`) does; see draft.ts's/runner.ts's own header comments for
 * why `generateDraft()`/`stageApplication()` take `apiKey` as a REQUIRED,
 * caller-resolved parameter rather than resolving it themselves.
 *
 * The `Config` `stageApplication()` needs is built the same
 * non-resolving way `/` and `/config` already read config.json
 * (`readRawConfig()`, src/lib/config/save.ts) — NEVER `loadConfig()`,
 * which both mutates `process.env` as a side effect (loading `.env`) and
 * eagerly resolves every configured source's `"env:VAR_NAME"` settings
 * references, which could throw for a source wholly unrelated to drafting.
 * `readRawConfig()`'s raw document is validated against the same
 * `ConfigSchema` `saveConfig()` uses, so `stageApplication()` still gets a
 * genuinely well-typed `Config` — just without either side effect. Neither
 * `profile` nor `applyProfile` fields ever hold an `"env:"` reference (only
 * `SourceConfig.settings` does — see schema.ts), so skipping that
 * resolution step changes nothing `generateDraft()` actually reads.
 *
 * `stageApplication()`'s own two guardrail errors (tier='red', missing
 * `applyProfile`) are caught and returned VERBATIM via `actionErr()` — this
 * is exactly what surfaces "the specific, actionable error from
 * stageApplication() (pointing at /config)" in the dashboard UI, never a
 * generic failure message.
 */
export async function generateDraftAction(key: string): Promise<ActionResult<{ gigKey: string }>> {
  const gig = getGig(key);
  if (!gig) {
    return actionErr(new Error(`gigradar apply: no gig found for key "${key}".`));
  }

  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const parsedConfig = ConfigSchema.safeParse(readRawConfig());
  if (!parsedConfig.success) {
    return actionErr(
      new Error(
        "gigradar config: your saved configuration is incomplete or invalid — check /config before generating a draft.",
      ),
    );
  }

  const matchResult: MatchResult = {
    gig,
    pass: true,
    reasons: [],
    score: 1,
    tier: gig.tier,
    matchedProfiles: gig.matchedProfileIds ?? [],
  };

  try {
    await stageApplication(matchResult, parsedConfig.data, apiKey);
  } catch (e) {
    return actionErr(e);
  }

  revalidatePath("/drafts");
  return actionOk({ gigKey: key });
}

// ---------------------------------------------------------------------------
// "Generate prep packet" (career-crm epic, prep-packet-ui story) — the
// dashboard row action that calls generatePrepPacket() (src/lib/apply/prep.ts)
// for ANY tracked gig (no tier restriction — unlike generateDraftAction
// above, a prep packet is read-only analysis, not a real application
// artifact, so there's no red-tier guardrail to enforce). Mirrors
// generateDraftAction()'s exact apiKey/config-resolution discipline.
// ---------------------------------------------------------------------------

/**
 * Resolves the gig + the current `Profile`/`ApplyProfileConfig` (via
 * `readRawConfig()`, same non-resolving read `generateDraftAction()` uses
 * and for the same reason — see that action's own doc comment) + the BYOK
 * Anthropic key (via `readEnvVar()`, never `process.env`), calls
 * `generatePrepPacket()`, persists via `saveInterviewPrep()`.
 * `applyProfile` is optional here (unlike `generateDraftAction()`, which
 * requires it) — a prep packet's fit/gap analysis is still meaningful from
 * `Profile` alone.
 */
export async function generatePrepPacketAction(key: string): Promise<ActionResult<PrepPacketContent>> {
  const gig = getGig(key);
  if (!gig) {
    return actionErr(new Error(`gigradar career-crm: no gig found for key "${key}".`));
  }

  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const parsedConfig = ConfigSchema.safeParse(readRawConfig());
  if (!parsedConfig.success) {
    return actionErr(
      new Error(
        "gigradar config: your saved configuration is incomplete or invalid — check /config before generating a prep packet.",
      ),
    );
  }

  let content: PrepPacketContent;
  try {
    content = await generatePrepPacket(gig, parsedConfig.data.profile, parsedConfig.data.applyProfile, apiKey);
  } catch (e) {
    return actionErr(e);
  }

  saveInterviewPrep(key, content);
  revalidatePath("/");
  return actionOk(content);
}
