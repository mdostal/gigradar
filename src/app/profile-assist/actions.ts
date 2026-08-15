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
import { endAssistSession, getAssistSessionPage, startAssistSession, type AssistMode } from "@/lib/auth/assist-session";
import { readEnvVar } from "@/lib/config/env-store";
import { ConfigSchema } from "@/lib/config/schema";
import { readRawConfig } from "@/lib/config/save";
import { suggestProfileFields, type FieldSuggestion } from "@/lib/apply/profile-suggest";
import type { ActionResult } from "@/lib/actions/result";
import type { ApplyProfileConfig, Profile } from "@/lib/types";

const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";
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

export async function startAssistSessionAction(
  sourceId: string,
  mode: AssistMode,
): Promise<ActionResult<{ sessionId: string }>> {
  const sessionStatePathSetting = rawSessionStatePathFor(sourceId);
  if (!sessionStatePathSetting) {
    return actionErr(
      new Error(`gigradar profile-assist: source "${sourceId}" is missing settings.sessionStatePath — capture a login for it first.`),
    );
  }

  try {
    const { sessionId } = await startAssistSession(sourceId, mode, sessionStatePathSetting);
    return actionOk({ sessionId });
  } catch (e) {
    return actionErr(e);
  }
}

/** No revalidatePath() call: ending a session only closes in-memory Playwright state, same reasoning startCaptureAction's own doc comment gives for why it also skips revalidation — nothing on disk that a Server Component render reads has changed. */
export async function endAssistSessionAction(sessionId: string): Promise<ActionResult<null>> {
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
  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const profileData = readProfileAndApplyProfile();
  if ("error" in profileData) {
    return actionErr(new Error(profileData.error));
  }

  try {
    const page = getAssistSessionPage(sessionId);
    const suggestions = await suggestProfileFields(page, profileData.profile, profileData.applyProfile, apiKey);
    return actionOk(suggestions);
  } catch (e) {
    return actionErr(e);
  }
}
