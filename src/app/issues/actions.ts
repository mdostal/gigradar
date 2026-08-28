"use server";

import { revalidatePath } from "next/cache";
import { actionErr, actionOk } from "@/lib/actions/result";
import { runRadar } from "@/lib/apply/runner";
import { checkCaptureReadiness, type CaptureReadiness } from "@/lib/auth/capture-guidance";
import { closeCopilotSession, getCopilotPage, openCopilotSession } from "@/lib/auth/verification-copilot-session";
import { loadConfig } from "@/lib/config/load";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { readRawConfig } from "@/lib/config/save";
import { resolveIssue, resolveIssuesForSource } from "@/lib/notify/issues";
import { registerAllSources } from "@/lib/sources/register-all";
import type { ActionResult } from "@/lib/actions/result";

/**
 * Marks an issue resolved. Revalidates BOTH `/issues` (the list itself)
 * AND `/` (layout.tsx's nav badge reads `listIssues()` on every render,
 * but Next's Full Route Cache needs the explicit invalidation to actually
 * re-run that read — same convention `saveConfigAction` already
 * established for `/config`). Every route shares the same root layout, so
 * `/` is enough to cover the badge everywhere, not just the dashboard.
 */
export async function resolveIssueAction(id: string): Promise<ActionResult<null>> {
  try {
    resolveIssue(id);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/issues");
  revalidatePath("/");
  return actionOk(null);
}

// ---------------------------------------------------------------------------
// Verification co-pilot actions (verification-copilot epic,
// verification-copilot-browser-action story) — thin wrappers around
// verification-copilot-session.ts, reusing the exact same ActionResult<T>
// convention as resolveIssueAction above. Only reachable from an issue
// whose title is "Needs human verification" (issues-client.tsx's own
// render gate) — never a generic "open a browser" affordance for every
// issue.
// ---------------------------------------------------------------------------

/**
 * Finds `sourceId`'s RAW (possibly "env:VAR_NAME") sessionStatePath
 * setting from config.json — reads via `readRawConfig()`, never
 * `loadConfig()`, same "raw everywhere except the actual pipeline resolve
 * step" rule this codebase holds everywhere else (CLAUDE.md's Secret
 * handling section). Mirrors profile-assist/actions.ts's own
 * `rawSessionStatePathFor()`.
 */
function rawSessionStatePathFor(sourceId: string): string | undefined {
  const raw = readRawConfig();
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const entry = sources.find(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );
  const settings = entry && typeof entry.settings === "object" && entry.settings !== null ? (entry.settings as Record<string, unknown>) : undefined;
  const value = settings?.sessionStatePath;
  return typeof value === "string" ? value : undefined;
}

/**
 * Wraps `openCopilotSession()`: resolves `sourceId`'s raw sessionStatePath
 * setting from config, then opens the co-pilot browser on `blockedUrl`.
 * `openCopilotSession()` itself never throws a generic message — its
 * errors already name the exact failure — so this action's `catch` just
 * carries that message through verbatim.
 *
 * No `revalidatePath()` call: opening a session only creates in-memory
 * Playwright state, nothing on disk `/issues`' render depends on — same
 * reasoning `startCaptureAction()` (config/actions.ts) already documents
 * for its own identical case.
 */
export async function openCopilotSessionAction(sourceId: string, blockedUrl: string): Promise<ActionResult<{ sessionId: string }>> {
  const sessionStatePathSetting = rawSessionStatePathFor(sourceId);
  if (!sessionStatePathSetting) {
    return actionErr(
      new Error(`gigradar issues: source "${sourceId}" has no captured session yet — capture a login for it in /config first.`),
    );
  }

  try {
    const { sessionId } = await openCopilotSession(sourceId, blockedUrl, sessionStatePathSetting);
    return actionOk({ sessionId });
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Wraps `checkCaptureReadiness()` (capture-guidance.ts, reused AS-IS — its
 * prompt is already generic enough to cover "still showing a verification
 * challenge," see design-discussion.md §3) against the co-pilot session's
 * current page. ADVISORY ONLY: never closes the session, never resolves
 * the issue — same discipline `checkCaptureReadinessAction()`
 * (config/actions.ts) already established for the identical UI pattern on
 * Capture Login.
 */
export async function checkCopilotReadinessAction(sessionId: string, sourceId: string): Promise<ActionResult<CaptureReadiness>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error("No Anthropic API key configured — set one in Config before checking readiness."));
  }

  try {
    const page = getCopilotPage(sessionId);
    const readiness = await checkCaptureReadiness(page, sourceId, credential);
    return actionOk(readiness);
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * "I'm done": closes the co-pilot session AND resolves the issue —
 * ALWAYS both together, never one without the other (see this story's own
 * acceptance criteria). `closeCopilotSession()` is documented as
 * idempotent/never-throwing; `resolveIssue()` can throw (unknown id), in
 * which case the session is still closed (real browser resource cleanup
 * must never depend on the issue-store write succeeding) but the specific
 * error is surfaced rather than silently swallowed.
 */
export async function finishCopilotSessionAction(sessionId: string, issueId: string): Promise<ActionResult<null>> {
  await closeCopilotSession(sessionId);

  try {
    resolveIssue(issueId);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/issues");
  revalidatePath("/");
  return actionOk(null);
}

// ---------------------------------------------------------------------------
// "Retry now" (source-status-features epic, inline-issue-actions story) —
// the real ACTION this page was missing: instead of only ever being able to
// "mark resolved" a "Source fetch failed" / "Needs human verification"
// issue, re-run THAT ONE source's fetch right now and report what actually
// happened. On success, resolves every open issue for that source the same
// way the scheduler's own auto-resolve loop does (resolveIssuesForSource())
// -- no need to wait for the next scheduled cycle to confirm a fix (e.g.
// right after Capture Login) worked.
// ---------------------------------------------------------------------------

export interface RetrySourceResult {
  ok: true;
  foundCount: number;
}

/**
 * Resolves the FULL config via `loadConfig()` (this action genuinely runs
 * the pipeline for one source -- the "resolving is the exception" case
 * CLAUDE.md's Secret handling section carves out, same as the scheduler's
 * own runRadarFn call) and re-fetches ONLY `sourceId`, ignoring every other
 * source's enabled state. Persists via the same `runRadar()`/`recordScan()`
 * path a real scheduled cycle uses, so a newly found gig actually shows up
 * on the dashboard, not just a dry-run preview (contrast
 * `testCustomSourceExtractionAction()` in config/actions.ts, which
 * deliberately never persists).
 *
 * A thrown/returned error's message is a `src.fetch()`-authored string --
 * same convention every other action in this file already follows -- never
 * a resolved secret (no code path here ever returns `runOpts.credential` or
 * any config value that isn't already a public-shaped error string).
 *
 * runner-registry-and-sidecar-lifecycle epic: `registerAllSources()` is
 * called FIRST, unconditionally -- this is a Next.js Server Action, and
 * unlike the CLI/scheduler/MCP entry points, the app-server process has no
 * other startup hook that ever registers the adapter modules. Without
 * this, `runRadar()` below reports "no such registered source" for every
 * genuinely valid, already-configured source (live-verified this session
 * against "fractionus" before this fix).
 */
export async function retrySourceAction(sourceId: string): Promise<ActionResult<RetrySourceResult>> {
  await registerAllSources();
  const config = loadConfig();
  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) {
    return actionErr(new Error(`gigradar issues: no source configured with id "${sourceId}".`));
  }

  const singleSourceConfig = { ...config, sources: [{ ...source, enabled: true }] };

  try {
    const result = await runRadar(singleSourceConfig, {}, { credential: resolveLlmCredential() });
    const failure = result.errors.find((e) => e.sourceId === sourceId);
    if (failure) {
      return actionErr(new Error(failure.message));
    }

    resolveIssuesForSource(sourceId);
    revalidatePath("/issues");
    revalidatePath("/");
    return actionOk({ ok: true, foundCount: result.results.length });
  } catch (e) {
    return actionErr(e);
  }
}
