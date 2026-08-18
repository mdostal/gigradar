"use server";

// profile-assist epic, profile-assist-persistent-session-manual-mode
// story. Thin Server Action wrappers around assist-session.ts/
// profile-suggest.ts, reusing this app's established conventions exactly:
// the shared ActionResult<T> shape (actionOk()/actionErr()), and the
// Anthropic API key resolved FRESH inside the handler via env-store.ts's
// readEnvVar() (never process.env, never a module-scope constant) — same
// discipline extractProfileFromResumeAction (src/app/config/actions.ts)
// already establishes, for the same reason: this app's Server Action
// request path never populates process.env from .env itself.
import { actionErr, actionOk } from "@/lib/actions/result";
import {
  endAssistSession,
  getAssistSessionInfo,
  getAssistSessionPage,
  startAssistSession,
  type AssistMode,
} from "@/lib/auth/assist-session";
import { sessionBackendFrom } from "@/lib/auth/session-backend";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { ConfigSchema } from "@/lib/config/schema";
import { readRawConfig } from "@/lib/config/save";
import { suggestProfileFields, type FieldSuggestion } from "@/lib/apply/profile-suggest";
import { advanceLoopTurn, answerHuman, clearLoop, resolveApproval, type LoopEvent } from "@/lib/apply/profile-assist-loop";
import type { ActionResult } from "@/lib/actions/result";
import type { LlmCredential } from "@/lib/config/env-store";
import type { ApplyProfileConfig, Profile } from "@/lib/types";

const MISSING_API_KEY_ERROR =
  "No Anthropic API key configured — set one in Config before starting an assisted session.";

/**
 * Finds `sourceId`'s RAW (possibly "env:VAR_NAME") sessionStatePath setting
 * from config.json — reads via readRawConfig(), never loadConfig(), same
 * "raw everywhere except the actual pipeline resolve step" rule this
 * codebase holds everywhere else (see CLAUDE.md's Secret handling
 * section). The raw value is handed to startAssistSession(), which
 * resolves it internally via resolveEnvString() — mirroring how every
 * browser-session-auth adapter already passes its own raw
 * storageStatePathSetting into withBrowserSession() the same way.
 */
function rawSourceSettingsFor(sourceId: string): Record<string, unknown> | undefined {
  const raw = readRawConfig();
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const entry = sources.find(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );
  return entry && typeof entry.settings === "object" && entry.settings !== null ? (entry.settings as Record<string, unknown>) : undefined;
}

/**
 * Finds `sourceId`'s RAW (possibly "env:VAR_NAME") sessionStatePath setting
 * from config.json — reads via readRawConfig(), never loadConfig(), same
 * "raw everywhere except the actual pipeline resolve step" rule this
 * codebase holds everywhere else (see CLAUDE.md's Secret handling
 * section). The raw value is handed to startAssistSession(), which
 * resolves it internally via resolveEnvString() — mirroring how every
 * browser-session-auth adapter already passes its own raw
 * storageStatePathSetting into withBrowserSession() the same way.
 */
function rawSessionStatePathFor(sourceId: string): string | undefined {
  const value = rawSourceSettingsFor(sourceId)?.sessionStatePath;
  return typeof value === "string" ? value : undefined;
}

export async function startAssistSessionAction(
  sourceId: string,
  mode: AssistMode,
): Promise<ActionResult<{ sessionId: string }>> {
  const cfg = { id: sourceId, enabled: true, settings: rawSourceSettingsFor(sourceId) ?? {} };
  const sessionBackend = sessionBackendFrom(cfg);

  const sessionStatePathSetting = sessionBackend === "local" ? rawSessionStatePathFor(sourceId) : undefined;
  if (sessionBackend === "local" && !sessionStatePathSetting) {
    return actionErr(
      new Error(`gigradar profile-assist: source "${sourceId}" is missing settings.sessionStatePath — capture a login for it first.`),
    );
  }

  try {
    const { sessionId } = await startAssistSession(sourceId, mode, sessionStatePathSetting, sessionBackend, cfg);
    return actionOk({ sessionId });
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * No revalidatePath() call: ending a session only closes in-memory
 * Playwright state, same reasoning startCaptureAction's own doc comment
 * gives for why it also skips revalidation — nothing on disk that a
 * Server Component render reads has changed.
 *
 * clearLoop() (profile-assist-guided-mode story) runs unconditionally
 * BEFORE endAssistSession() — a session ending is the natural end of its
 * loop's lifetime too (a Guided/Full-auto session's tool-use conversation
 * has no meaning once the browser it was acting on is gone), and clearing
 * it first means an unexpected endAssistSession() failure still leaves no
 * orphaned loop state.
 */
export async function endAssistSessionAction(sessionId: string): Promise<ActionResult<null>> {
  clearLoop(sessionId);
  try {
    await endAssistSession(sessionId);
    return actionOk(null);
  } catch (e) {
    return actionErr(e);
  }
}

function readProfileAndApplyProfile(): { profile: Profile; applyProfile: ApplyProfileConfig } | { error: string } {
  const raw = readRawConfig();
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "gigradar profile-assist: config.json is missing or invalid — configure your profile in Config first." };
  }
  if (!parsed.data.applyProfile) {
    return { error: "gigradar profile-assist: no apply profile configured — fill in the Apply profile section in Config first." };
  }
  return { profile: parsed.data.profile, applyProfile: parsed.data.applyProfile };
}

export async function suggestProfileFieldsAction(sessionId: string): Promise<ActionResult<FieldSuggestion[]>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const profileData = readProfileAndApplyProfile();
  if ("error" in profileData) {
    return actionErr(new Error(profileData.error));
  }

  try {
    const page = getAssistSessionPage(sessionId);
    const suggestions = await suggestProfileFields(page, profileData.profile, profileData.applyProfile, credential);
    return actionOk(suggestions);
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// Guided/Full-auto tool-use loop actions (profile-assist-guided-mode story)
// — thin wrappers around profile-assist-loop.ts, resolving the same
// credential/profile/applyProfile/page every advanceLoopTurnAction() call
// needs via readAssistLoopInputs() below, mirroring suggestProfileFieldsAction's
// own resolution above rather than a third, duplicated version of it.
// ---------------------------------------------------------------------------

function readAssistLoopInputs(
  sessionId: string,
):
  | { credential: LlmCredential; profile: Profile; applyProfile: ApplyProfileConfig; mode: "guided" | "full-auto" }
  | { error: string } {
  const credential = resolveLlmCredential();
  if (!credential) return { error: MISSING_API_KEY_ERROR };

  const info = getAssistSessionInfo(sessionId);
  if (!info) return { error: `gigradar profile-assist: session not found or expired (id "${sessionId}").` };
  if (info.mode !== "guided" && info.mode !== "full-auto") {
    return { error: `gigradar profile-assist: session "${sessionId}" is not in a tool-use mode (mode: "${info.mode}").` };
  }

  const profileData = readProfileAndApplyProfile();
  if ("error" in profileData) return { error: profileData.error };

  return { credential, profile: profileData.profile, applyProfile: profileData.applyProfile, mode: info.mode };
}

export async function advanceLoopTurnAction(sessionId: string): Promise<ActionResult<LoopEvent>> {
  const inputs = readAssistLoopInputs(sessionId);
  if ("error" in inputs) return actionErr(new Error(inputs.error));

  try {
    const page = getAssistSessionPage(sessionId);
    const event = await advanceLoopTurn(sessionId, page, inputs.mode, inputs.profile, inputs.applyProfile, inputs.credential);
    return actionOk(event);
  } catch (e) {
    return actionErr(e);
  }
}

export async function resolveApprovalAction(
  sessionId: string,
  approve: boolean,
  editedValue?: string,
): Promise<ActionResult<null>> {
  try {
    const page = getAssistSessionPage(sessionId);
    await resolveApproval(sessionId, page, approve, editedValue);
    return actionOk(null);
  } catch (e) {
    return actionErr(e);
  }
}

export async function answerHumanAction(sessionId: string, answer: string): Promise<ActionResult<null>> {
  try {
    answerHuman(sessionId, answer);
    return actionOk(null);
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// embedded-profile-assist epic, embedded-view-readonly story -- a read-only
// live view of the session's page for the /profile-assist UI's "Embedded"
// view, deliberately decoupled from profile-assist-loop.ts's own ARIA-
// snapshot-based reading (that stays unchanged; this is purely for the
// human's benefit). Same JPEG-quality-70/data-URL shape agent-chat-loop.ts's
// take_screenshot tool already established for a screenshot rendered inline
// in this app's own UI, just JPEG instead of PNG here (profile-assist's
// pane refreshes far more often than a one-off chat screenshot, so the
// smaller payload matters more).
// ---------------------------------------------------------------------------

export async function getSessionScreenshotAction(sessionId: string): Promise<ActionResult<{ dataUrl: string }>> {
  try {
    const page = getAssistSessionPage(sessionId);
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    return actionOk({ dataUrl: `data:image/jpeg;base64,${screenshot.toString("base64")}` });
  } catch (e) {
    return actionErr(e);
  }
}
