"use server";

import { revalidatePath } from "next/cache";
import { getGig, getInterviewPrep, saveInterviewPrep, setStatus } from "@/lib/store";
import type { GigStatus } from "@/lib/store";
import { actionErr, actionOk, type ActionResult } from "@/lib/actions/result";
import { runRadar, stageApplication } from "@/lib/apply/runner";
import { generatePrepPacket, type PrepPacketContent } from "@/lib/apply/prep";
import { loadConfig } from "@/lib/config/load";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";
import { reconcileGoFractionalStatuses, type ReconciliationResult } from "@/lib/sources/gofractional-status";
import { reconcileWellfoundStatuses } from "@/lib/sources/wellfound-status";
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
 *
 * dashboard-redesign story: marking a gig "applied" also best-effort
 * auto-generates its prep packet when `Config.autoPrepOnApply` is on and
 * one doesn't already exist yet (`getInterviewPrep()` check — never
 * regenerates/overwrites one the owner may have since edited-by-hand
 * expectations around, though today nothing edits a packet in place).
 * AWAITED, not fire-and-forget: the row's status `<select>` is already
 * disabled for the duration of this action (dashboard-client.tsx's
 * `isPending`), so the extra LLM-call latency rides the same "this was
 * already a pending mutation" UX cost — and awaiting means the
 * `revalidatePath()` below picks up the freshly-generated packet
 * immediately, no separate refresh/poll needed. A generation failure
 * (missing API key, LLM error) is swallowed here: the status change is
 * the one thing that MUST succeed, same discipline `notifyOnGreenMatch`'s
 * own notification-failure handling uses.
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

  if (status === "applied") {
    const config = ConfigSchema.safeParse(readRawConfig());
    if (config.success && config.data.autoPrepOnApply && !getInterviewPrep(key)) {
      await runPrepPacketGeneration(key).catch(() => {
        // Best-effort — see doc comment above. runPrepPacketGeneration()
        // already returns an {ok:false} ActionResult for its own known
        // failure modes rather than throwing; this catch only guards
        // against something genuinely unexpected.
      });
    }
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

/**
 * Specific, actionable error when no Anthropic API key is set — mirrors
 * `src/app/config/actions.ts`'s `MISSING_API_KEY_ERROR`, reworded for this
 * action's own context (drafting, not resume extraction), never a generic
 * Anthropic SDK authentication failure.
 */
const MISSING_API_KEY_ERROR =
  'gigradar apply: no Anthropic API key is set. Enter one in the "Anthropic API key" field on /config, then try again.';

/**
 * Resolves the LLM credential via `resolveLlmCredential()` — freshly, on
 * every call, exactly like `extractProfileFromResumeAction`
 * (src/app/config/actions.ts) — never `process.env` directly and never a
 * module-scope constant. This Next.js Server Action request path never
 * populates `process.env` from `.env` the way the CLI/cron path
 * (`loadConfig()`) does; see draft.ts's/runner.ts's own header comments for
 * why `generateDraft()`/`stageApplication()` take `credential` as a REQUIRED,
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

  const credential = resolveLlmCredential();
  if (!credential) {
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
    await stageApplication(matchResult, parsedConfig.data, credential);
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
 * `Profile` alone. No `revalidatePath()` here — callers own that, since
 * `updateGigStatusAction`'s best-effort auto-prep call below already does
 * its own regardless of whether generation succeeded.
 */
async function runPrepPacketGeneration(key: string): Promise<ActionResult<PrepPacketContent>> {
  const gig = getGig(key);
  if (!gig) {
    return actionErr(new Error(`gigradar career-crm: no gig found for key "${key}".`));
  }

  const credential = resolveLlmCredential();
  if (!credential) {
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
    content = await generatePrepPacket(gig, parsedConfig.data.profile, parsedConfig.data.applyProfile, credential);
  } catch (e) {
    return actionErr(e);
  }

  saveInterviewPrep(key, content);
  return actionOk(content);
}

export async function generatePrepPacketAction(key: string): Promise<ActionResult<PrepPacketContent>> {
  const result = await runPrepPacketGeneration(key);
  if (result.ok) revalidatePath("/");
  return result;
}

// ---------------------------------------------------------------------------
// GoFractional status reconciliation (product-review-followups epic,
// status-reconciliation-from-platforms story, first source). Dashboard
// button action -- resolves the FULL config via loadConfig() (this action
// genuinely needs the real, working session-state settings, same
// "resolve here, never echo back" discipline runPrepPacketGeneration()'s
// own credential resolution above already follows) and hands the resolved
// "gofractional" source entry to reconcileGoFractionalStatuses(), which
// scrapes the owner's own real application-status dashboard and updates
// any locally-tracked gig whose status has genuinely changed.
// ---------------------------------------------------------------------------

export async function reconcileGoFractionalStatusesAction(): Promise<ActionResult<ReconciliationResult>> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return actionErr(e);
  }

  const source = config.sources.find((s) => s.id === "gofractional");
  if (!source) {
    return actionErr(new Error('gigradar status-reconciliation: no "gofractional" source configured.'));
  }

  try {
    const result = await reconcileGoFractionalStatuses(source);
    if (result.updated.length > 0) {
      revalidatePath("/");
      revalidatePath("/gigs");
    }
    return actionOk(result);
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// Wellfound status reconciliation (product-review-followups epic,
// status-reconciliation-from-platforms story, second source). Same shape
// as reconcileGoFractionalStatusesAction() above.
// ---------------------------------------------------------------------------

export async function reconcileWellfoundStatusesAction(): Promise<ActionResult<ReconciliationResult>> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return actionErr(e);
  }

  const source = config.sources.find((s) => s.id === "wellfound");
  if (!source) {
    return actionErr(new Error('gigradar status-reconciliation: no "wellfound" source configured.'));
  }

  try {
    const result = await reconcileWellfoundStatuses(source);
    if (result.updated.length > 0) {
      revalidatePath("/");
      revalidatePath("/gigs");
    }
    return actionOk(result);
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// Sweep now (dashboard-drafts-data-integrity epic, sonar-sweep-header-widget
// story). The manual, on-demand counterpart to the scheduler's own scheduled
// runRadarFn() cycle (src/scheduler/index.ts) -- runs a real scan across
// every configured source right now. Same loadConfig()+runRadar() call
// shape as the MCP server's run_scan tool (src/mcp/server.ts's
// handleRunScan(), "the ONE [MCP] tool allowed to call loadConfig()" per
// that file's own comment -- scoped to MCP's 5 tools, not a repo-wide
// restriction; this app's Server Actions already call loadConfig()
// elsewhere, e.g. reconcileGoFractionalStatusesAction() above). Returns
// counts/error strings ONLY, matching run_scan's own safe return contract
// -- never a resolved secret, per CLAUDE.md's Secret handling section.
// ---------------------------------------------------------------------------

export interface SweepResult {
  passedCount: number;
  newCount: number;
  errors: { sourceId: string; message: string }[];
}

export async function sweepNowAction(): Promise<ActionResult<SweepResult>> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return actionErr(e);
  }

  try {
    const { passed, errors, newlyInsertedKeys } = await runRadar(config, {}, { credential: resolveLlmCredential() });
    revalidatePath("/");
    revalidatePath("/gigs");
    return actionOk({
      passedCount: passed.length,
      newCount: newlyInsertedKeys.length,
      errors: errors.map((e) => ({ sourceId: e.sourceId, message: e.message })),
    });
  } catch (e) {
    return actionErr(e);
  }
}
