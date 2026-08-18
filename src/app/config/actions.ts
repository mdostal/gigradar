"use server";

import { revalidatePath } from "next/cache";
import { actionErr, actionOk } from "@/lib/actions/result";
import { approvedCount } from "@/lib/apply/autofire";
import { checkCaptureReadiness, type CaptureReadiness } from "@/lib/auth/capture-guidance";
import { cancelCapture, finishCapture, getCapturePage, startCapture } from "@/lib/auth/session-capture";
import { sessionBackendFrom } from "@/lib/auth/session-backend";
import { buildAuthorizationUrl, deleteTokenSet } from "@/lib/auth/oauth2";
import { resolveOAuthClientCredentials } from "@/lib/auth/oauth-credentials";
import { GMAIL_PROVIDER } from "@/lib/auth/oauth-providers/gmail";
import { readEnvVar, resolveLlmCredential, setEnvVar } from "@/lib/config/env-store";
import { type ConfigEdits, readRawConfig, saveConfig } from "@/lib/config/save";
import { deleteResume, getResumePath, saveResume } from "@/lib/documents/resume-store";
import { extractProfile } from "@/lib/profile-ingestion/extract";
import { customLlmSource } from "@/lib/sources/custom-llm-source";
import { resolveAllowedOrigins, resolveLoginUrl } from "@/lib/sources/origins";
import type { ActionResult } from "@/lib/actions/result";
import type { ExtractProfileInput } from "@/lib/profile-ingestion/extract";
import type { Config, Profile, SourceConfig, Tier } from "@/lib/types";

/**
 * Finds `sourceId`'s raw entry in `rawSources` and returns it as a
 * (partial-safety) `SourceConfig` — reused by both `startCaptureAction()`
 * (origins/login-URL fallback resolution) and `rawSessionBackendFor()`
 * below, rather than each re-implementing the same "find by id" scan.
 */
function rawSourceConfigFor(rawSources: unknown, sourceId: string): SourceConfig {
  const sources = Array.isArray(rawSources) ? rawSources : [];
  const entry = sources.find(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );
  return { id: sourceId, enabled: true, settings: (entry?.settings as Record<string, unknown> | undefined) ?? {} };
}

/**
 * Server Action wrapping `saveConfig()` (config-write-path) — the config
 * form's Save button calls this. Reuses the EXACT same convention
 * `updateGigStatusAction` (src/app/actions.ts) established: the shared
 * `ActionResult<T>` shape (src/lib/actions/result.ts) and an explicit
 * `revalidatePath()` call after every successful mutation, so a reload of
 * `/config` never serves a stale, pre-edit version from Next's Full Route
 * Cache under a production build (see that file's comment for the exact
 * failure mode this prevents — confirmed live under `next build && next
 * start` for the dashboard's own action; this route follows the same
 * discipline).
 *
 * Unlike `updateGigStatusAction`, there's no try/catch here: `saveConfig()`
 * already returns `ActionResult<Config>` itself (it never throws for an
 * expected failure — a `ConfigSchema` validation failure or a write error
 * both come back as `{ok:false,error}`), so this action is a thin pass-
 * through plus the revalidate call. `edits` rides through to `saveConfig()`
 * completely unexamined — in particular, any `"env:VAR_NAME"` string inside
 * it (e.g. a source's `settings.apiKey`) is never read, resolved, or
 * otherwise touched here; this file never imports `process.env` or
 * load.ts's resolving reader.
 */
export async function saveConfigAction(edits: ConfigEdits): Promise<ActionResult<Config>> {
  const result = saveConfig(edits);
  if (!result.ok) return result;
  revalidatePath("/config");
  return result;
}

// ---------------------------------------------------------------------------
// Session-capture actions (`session-capture-ui` story) — thin wrappers
// around `src/lib/auth/session-capture.ts`'s start/finish/cancel functions,
// reusing the exact same `ActionResult<T>` convention as `saveConfigAction`
// above. Per the config-client.tsx "Capture login" flow (see that file and
// docs/ARCHITECTURE.md's "Session-capture mechanism" section): click
// "Capture login" -> startCaptureAction() -> UI shows a waiting state with
// "I'm done"/Cancel, purely user-driven, NO polling -> either
// finishCaptureAction() or cancelCaptureAction().
// ---------------------------------------------------------------------------

/**
 * Wraps `startCapture()`: resolves `sourceId`'s login URL and origin
 * allowlist via `origins.ts`'s `resolveLoginUrl()`/`resolveAllowedOrigins()`
 * — the static `SOURCE_LOGIN_URLS`/`SOURCE_ORIGINS` registries first (every
 * existing browser-session-auth source, unchanged), a config-driven
 * fallback (`settings.loginUrl`/`settings.allowedOrigins`) second, for a
 * custom source with no static entry (llm-custom-sources epic,
 * custom-source-auth story). `startCapture()` itself never throws a generic
 * message — its errors already name the exact failure (missing Chromium
 * binary, launch failure, failed navigation) — so this action's `catch`
 * just carries that message through verbatim via `actionErr()`, never
 * replacing it with a generic "capture failed."
 *
 * No `revalidatePath()` call here: starting a capture only creates in-memory
 * Playwright state (a live `Browser`/`BrowserContext` held in
 * `session-capture.ts`'s `globalThis`-pinned map) — nothing on disk that
 * `/config`'s Server-Component render reads changes yet, so there is
 * nothing for Next's Full Route Cache to invalidate. Only
 * `finishCaptureAction()` below (which writes to `config.json`) needs it,
 * matching this app's documented "revalidate after every successful
 * *mutation*" rule (docs/ARCHITECTURE.md's "Server Actions" section) rather
 * than calling it unconditionally on every action regardless of whether
 * anything the page reads actually changed.
 */
export async function startCaptureAction(sourceId: string): Promise<ActionResult<{ captureId: string }>> {
  const raw = readRawConfig();
  const cfg = rawSourceConfigFor(raw.sources, sourceId);

  const loginUrl = resolveLoginUrl(sourceId, cfg);
  if (!loginUrl) {
    return actionErr(
      new Error(`gigradar config: no login URL registered for source "${sourceId}" (see src/lib/sources/origins.ts, or set settings.loginUrl).`),
    );
  }
  const allowedOrigins = resolveAllowedOrigins(sourceId, cfg);

  try {
    const { captureId } = await startCapture(sourceId, loginUrl, allowedOrigins);
    return actionOk({ captureId });
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Finds `sourceId`'s entry in the raw (not-yet-validated) `sources` array —
 * by id, matching however many/few fields it currently carries — and
 * returns a NEW array with that entry's `settings.sessionStatePath` set to
 * `sessionStatePath`, preserving every other field on that entry (including
 * any other `settings` keys) and every other source untouched. If no entry
 * for `sourceId` exists yet (e.g. the capture button was shown for a source
 * id typed into the form but never yet saved), a new minimal entry is
 * appended rather than the write being silently dropped — capture success
 * should never be lost just because the source row hadn't been saved yet.
 */
function withSessionStatePath(
  rawSources: unknown,
  sourceId: string,
  sessionStatePath: string,
): Record<string, unknown>[] {
  const sources = Array.isArray(rawSources) ? [...(rawSources as unknown[])] : [];
  const idx = sources.findIndex(
    (s) => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );

  const existing: Record<string, unknown> = idx >= 0 ? (sources[idx] as Record<string, unknown>) : { id: sourceId, enabled: true };
  const existingSettings =
    typeof existing.settings === "object" && existing.settings !== null
      ? (existing.settings as Record<string, unknown>)
      : {};

  const updated: Record<string, unknown> = {
    ...existing,
    settings: { ...existingSettings, sessionStatePath },
  };

  if (idx >= 0) {
    sources[idx] = updated;
  } else {
    sources.push(updated);
  }

  return sources as Record<string, unknown>[];
}

/**
 * Finds `sourceId`'s raw entry in `rawSources` and resolves which session
 * backend it's configured for via session-backend.ts's sessionBackendFrom()
 * — "local" (the default, when the source has no entry yet or no
 * settings.sessionBackend) or "portunus". This is deliberately a READ of
 * whatever's already configured (set via the /config Settings editor, same
 * convention as every other per-source setting) — Capture Login itself
 * never lets the user pick a backend ad hoc.
 */
function rawSessionBackendFor(rawSources: unknown, sourceId: string): "local" | "portunus" {
  return sessionBackendFrom(rawSourceConfigFor(rawSources, sourceId));
}

/**
 * Wraps `finishCapture(captureId, sessionBackend)`. `sourceId` is supplied
 * by the caller (the client already knows it — it's the same id
 * `startCaptureAction()` was called with for this row) rather than derived
 * from `captureId`, since `finishCapture()`'s return value doesn't expose
 * it. `sessionBackend` is resolved from `sourceId`'s EXISTING config
 * (`rawSessionBackendFor()` above) — set ahead of time via the /config
 * Settings editor, never chosen ad hoc in this flow.
 *
 * On a `"local"` result: AUTO-WRITES the returned path into that source's
 * `SourceConfig.settings.sessionStatePath` — reads the current raw document
 * fresh via `readRawConfig()`, merges the update in via
 * `withSessionStatePath()` above (preserving every other field/source), and
 * writes it back via `saveConfig()` (which itself re-reads config.json
 * fresh at write time — the same full-document-replace-on-save mechanism
 * every other write in this app uses, not a new risk class; see this
 * story's `risks` block). `revalidatePath("/config")` runs only after that
 * write actually succeeds, so a reload never serves a stale pre-capture
 * config.json from the Full Route Cache.
 *
 * On a `"portunus"` result: nothing to persist into config.json — the
 * session now lives in Portunus, keyed by `sourceId`, and
 * `settings.sessionBackend` was already `"portunus"` (that's how this
 * action knew to pass that backend to `finishCapture()` in the first
 * place). No `saveConfig()`/`revalidatePath()` call — nothing on disk that
 * `/config`'s render depends on changed.
 *
 * On failure — either `finishCapture()` itself throwing (e.g. the
 * zero-cookies sanity check, "capture not found or already expired", or a
 * Portunus write failure) or the subsequent `saveConfig()` call (local
 * backend only) failing validation — the SPECIFIC error message is
 * returned verbatim via `actionErr()`, never a generic "capture failed"
 * string. A `finishCapture()` failure writes nothing (that guarantee lives
 * in `session-capture.ts` itself); a `saveConfig()` failure after a
 * successful LOCAL `finishCapture()` leaves the just-captured session file
 * on disk (capture succeeded) but the config.json write did not go through
 * — surfaced as an explicit error rather than silently pretending the whole
 * operation succeeded.
 */
export async function finishCaptureAction(
  captureId: string,
  sourceId: string,
): Promise<ActionResult<{ backend: "local"; path: string } | { backend: "portunus" }>> {
  const raw = readRawConfig();
  const sessionBackend = rawSessionBackendFor(raw.sources, sourceId);

  let result: Awaited<ReturnType<typeof finishCapture>>;
  try {
    result = await finishCapture(captureId, sessionBackend);
  } catch (e) {
    return actionErr(e);
  }

  if (result.backend === "portunus") {
    return actionOk({ backend: "portunus" });
  }

  const sources = withSessionStatePath(raw.sources, sourceId, result.path);

  const saveResult = saveConfig({ sources });
  if (!saveResult.ok) return actionErr(new Error(saveResult.error));

  revalidatePath("/config");
  return actionOk({ backend: "local", path: result.path });
}

/**
 * Wraps `cancelCapture(captureId)`. `cancelCapture()` itself is documented
 * as idempotent and never-throwing (see `session-capture.ts`), but this
 * still goes through the same try/catch + `ActionResult` convention as the
 * other two actions here rather than assuming that guarantee holds forever
 * — a defensive, not redundant, choice.
 *
 * Writes nothing and calls no `revalidatePath()` — cancelling a capture
 * never touches `config.json` or anything else `/config`'s render depends
 * on, by design (see this story's acceptance criteria: "no file is written
 * anywhere").
 */
export async function cancelCaptureAction(captureId: string): Promise<ActionResult<null>> {
  try {
    await cancelCapture(captureId);
    return actionOk(null);
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Wraps `checkCaptureReadiness()` (`src/lib/auth/capture-guidance.ts`,
 * oauth-session-capture-v2 epic, llm-capture-readiness-check story) for the
 * Capture Login waiting screen's optional "Check if I'm ready" button.
 * ADVISORY ONLY: this action never calls `finishCapture()` and never
 * mutates anything — no `saveConfig()`/`revalidatePath()` call, same as
 * `cancelCaptureAction()` above. The "I'm done" button remains a fully
 * independent, always-available action regardless of what this returns
 * (see config-client.tsx's `CaptureLoginControl`).
 *
 * The LLM credential is resolved fresh, inside this handler, via
 * `resolveLlmCredential()` (llm-credential-modes epic — supports either a
 * raw Anthropic API key or a long-lived OAuth token, config-selectable).
 * A missing credential returns `MISSING_CREDENTIAL_ERROR` before
 * `getCapturePage()`/`checkCaptureReadiness()` ever run.
 */
export async function checkCaptureReadinessAction(captureId: string, sourceId: string): Promise<ActionResult<CaptureReadiness>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_CREDENTIAL_ERROR));
  }

  try {
    const page = getCapturePage(captureId);
    const readiness = await checkCaptureReadiness(page, sourceId, credential);
    return actionOk(readiness);
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Wraps `customLlmSource.fetch()` for the "Test extraction now" preview
 * button (llm-custom-sources epic, custom-source-pagination-and-ui story):
 * runs ONE real extraction against the entered URL/hint/auth settings and
 * returns a summary — count + titles — to display before the user commits
 * to saving. Writes NOTHING to `config.json` (same "preview, not a
 * mutation" discipline `extractProfileFromResumeAction()` below already
 * established) — no `saveConfig()`/`revalidatePath()` call of any kind.
 *
 * `sourceId` is threaded through so a successful extraction's derived
 * recipe (custom-source-recipe-caching story) gets cached under the SAME
 * id the user is about to save — the first real scheduled scan after
 * saving then hits the cache immediately, rather than re-deriving. This is
 * a real, intentional side effect (a recipe cache file, not config.json).
 *
 * The Anthropic API key is resolved fresh, inside this handler, via
 * `readEnvVar()` — same discipline every other LLM-calling action in this
 * file already follows.
 */
export async function testCustomSourceExtractionAction(
  sourceId: string,
  url: string,
  hint: string | undefined,
  customAuth: "none" | "browser-session",
  sessionStatePath: string | undefined,
): Promise<ActionResult<{ count: number; titles: string[] }>> {
  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }
  if (!sourceId) {
    return actionErr(new Error("gigradar config: give this custom source a name before testing extraction."));
  }
  if (!url) {
    return actionErr(new Error("gigradar config: enter a URL before testing extraction."));
  }

  const testProfile: Profile = { name: "", roles: [], skills: [], timezone: "UTC" };
  const cfg: SourceConfig = {
    id: sourceId,
    enabled: true,
    kind: "custom-llm",
    settings: {
      url,
      ...(hint && { hint }),
      ...(customAuth === "browser-session" && { customAuth, ...(sessionStatePath && { sessionStatePath }) }),
    },
  };

  try {
    const gigs = await customLlmSource.fetch(cfg, testProfile, apiKey);
    return actionOk({ count: gigs.length, titles: gigs.slice(0, 5).map((g) => g.title) });
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// Resume/link ingestion actions (`resume-link-ui` story) — the two new
// Server Actions wiring `env-store.ts` and `profile-ingestion/extract.ts`
// into `/config`'s Profile section. See
// .pHive/epics/profile-overview-ingestion/docs/design-discussion.md §3
// steps 1 and 4.
// ---------------------------------------------------------------------------

/** The one, dedicated .env var this feature reads/writes — never hardcoded inline at each call site. */
const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";

/**
 * Thin wrapper around `env-store.ts`'s `setEnvVar()` — the only Server
 * Action in this entire config UI that writes to `.env` instead of
 * `config.json` (called out as such in `config-client.tsx`'s UI copy). Reads
 * the submitted key as a required, non-blank string field named `apiKey`;
 * a blank/missing submission returns a specific error rather than silently
 * writing an empty value to `.env`.
 *
 * No `revalidatePath()` call: `/config`'s Server Component render
 * (`page.tsx`) never reads `.env` — only `readRawConfig()`'s `config.json`
 * read — so there is nothing on this page for Next's Full Route Cache to
 * invalidate as a result of this write (same "revalidate only when the
 * page's own read path changed" discipline as `startCaptureAction()` above).
 *
 * This write persists immediately, NOT gated behind the form's Save button
 * — a deliberate divergence from every other Profile field (see this
 * story's `design_decisions`): the API key is a discrete, single-purpose
 * credential-setup action, not part of the profile draft.
 */
export async function setAnthropicApiKeyAction(formData: FormData): Promise<ActionResult<void>> {
  const apiKey = formData.get("apiKey");
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return actionErr(new Error("gigradar config: Anthropic API key is required — enter a value before saving."));
  }
  return setEnvVar(ANTHROPIC_API_KEY_VAR, apiKey.trim());
}

/**
 * Specific, field-naming error returned when no Anthropic API key is set —
 * per this story's acceptance criteria, NEVER a generic SDK/auth error
 * bubbling up from `customLlmSource.fetch()`'s own `Anthropic` client
 * construction. Used ONLY by `testCustomSourceExtractionAction()` below —
 * that action stays on the raw-`apiKey`-only path (see its own doc
 * comment and `runner.ts`'s `Source.fetch()` interface boundary), so its
 * error message deliberately still names "Anthropic API key" specifically,
 * not the more general "Anthropic credential" wording `MISSING_CREDENTIAL_ERROR`
 * uses for the actions that DO support oauth-token mode.
 */
const MISSING_API_KEY_ERROR =
  'gigradar profile ingestion: no Anthropic API key is set. Enter one in the "Anthropic credential" field above and save it, then try again.';

/**
 * Specific error returned when no LLM credential (API key OR oauth token)
 * is set — llm-credential-modes epic. Used by actions that resolve via
 * `resolveLlmCredential()` (both credential kinds work): `checkCaptureReadinessAction()`
 * and `extractProfileFromResumeAction()` below.
 */
const MISSING_CREDENTIAL_ERROR =
  'gigradar profile ingestion: no Anthropic credential is set. Configure one in the "Anthropic credential" field above and save it, then try again.';

/**
 * Builds `extractProfile()`'s `ExtractProfileInput` from the raw `FormData`
 * the client submits: an optional `resumeFile` upload (native Next.js
 * Server Action file-upload support — no new persistence added here, the
 * uploaded bytes are read into memory for this one call and never written
 * to disk by this function) and an optional `links` textarea value (one URL
 * per line, blank lines dropped).
 *
 * A PDF upload (`type === "application/pdf"`) is passed through as
 * `resumeFile` — `extractProfile()` sends it to Claude as a native PDF
 * document block, never locally text-extracted (see extract.ts). Any other
 * uploaded file type (plain text, or a browser that didn't set a MIME type)
 * is read as UTF-8 text and passed as `resumeText` instead — this matches
 * the story's documented v1 scope (PDF and plain text only; .docx/.doc
 * explicitly not verified, per design-discussion.md §7).
 */
/**
 * `resumeUpload` rides alongside `input` (career-documents epic,
 * persist-resume-on-upload story) — the SAME raw bytes/mediaType
 * `extractProfile()` reads for its one-shot analysis, ALSO handed to
 * `saveResume()` below so a resume upload persists once, not twice.
 * `undefined` when no file was uploaded at all.
 */
async function buildExtractInput(
  formData: FormData,
): Promise<{ input: ExtractProfileInput; resumeUpload?: { data: Buffer; mediaType: string } }> {
  const input: ExtractProfileInput = {};
  let resumeUpload: { data: Buffer; mediaType: string } | undefined;

  const file = formData.get("resumeFile");
  if (file instanceof File && file.size > 0) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (file.type === "application/pdf") {
      input.resumeFile = { data: buffer, mediaType: "application/pdf" };
      resumeUpload = { data: buffer, mediaType: "application/pdf" };
    } else {
      input.resumeText = buffer.toString("utf8");
      resumeUpload = { data: buffer, mediaType: "text/plain" };
    }
  }

  const linksRaw = formData.get("links");
  if (typeof linksRaw === "string") {
    const links = linksRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (links.length > 0) input.links = links;
  }

  return { input, resumeUpload };
}

/** Reads `applyProfile` off the raw (not-yet-validated) config document, as a plain object -- same "tolerant read, empty object if absent/malformed" convention `rawSourceConfigFor()` above uses for `sources`. */
function rawApplyProfile(raw: Record<string, unknown>): Record<string, unknown> {
  return typeof raw.applyProfile === "object" && raw.applyProfile !== null ? { ...(raw.applyProfile as Record<string, unknown>) } : {};
}

/**
 * Wraps `extractProfile()` (`src/lib/profile-ingestion/extract.ts`) for the
 * "Extract from resume/link" button. Accepts a `FormData` file upload
 * (`resumeFile`, PDF or plain text) plus a `links` textarea value, and
 * returns `ActionResult<{roles, skills, warnings, resumeSaved, resumeSaveError?}>`.
 *
 * **The LLM credential is resolved fresh, INSIDE this handler, on every
 * call** — via `env-store.ts`'s `resolveLlmCredential()` (llm-credential-modes
 * epic — supports either a raw Anthropic API key or a long-lived OAuth
 * token, config-selectable), never `process.env` and never a module-scope
 * constant — per this story's non-negotiable requirement
 * (collaborative-review finding, design-discussion.md §3 step 4): the
 * Next.js app's Server Action request path never populates `process.env`
 * from `.env` (only the CLI/cron path, via `loadConfig()`, does that), and a
 * module-scope-resolved credential would go stale (or permanently capture
 * `undefined`) the moment it's set/changed without a server restart.
 * A missing credential short-circuits BEFORE `buildExtractInput()` or
 * `extractProfile()` run at all, returning `MISSING_CREDENTIAL_ERROR` — a
 * specific error naming the "Anthropic credential" field, never a generic
 * Anthropic SDK authentication failure.
 *
 * Per-link fetch/parse failures (including known login-walls) never fail
 * this action as a whole — `extractProfile()` itself collects those into
 * `warnings` and still returns a real (possibly partial) result; only a
 * fully unusable input or a genuine Anthropic API error reaches this
 * function's `catch` and comes back as `{ok:false}`.
 *
 * **career-documents epic, persist-resume-on-upload story**: when a resume
 * file was uploaded, it's now ALSO persisted — `saveResume()`
 * (`resume-store.ts`) writes the real bytes encrypted-at-rest, and (only
 * when `applyProfile.email` is already set, since `ApplyProfileConfigSchema`
 * requires it) `saveConfig()` records the resulting path as
 * `applyProfile.resumePath`. This is DELIBERATELY independent of the
 * extraction result: `resumeSaved`/`resumeSaveError` report persistence
 * status without ever downgrading a successful extraction to `{ok:false}` —
 * "fetch your stuff into gigradar" happens automatically on upload, but a
 * persistence hiccup (or an as-yet-unset email) never hides the
 * roles/skills the user came here for. When no `applyProfile.email` is set
 * yet, `resumeSaveError` names that specific, actionable fix rather than a
 * raw schema-validation error.
 */
export async function extractProfileFromResumeAction(formData: FormData): Promise<
  ActionResult<{
    roles: string[];
    skills: string[];
    warnings: string[];
    resumeSaved: boolean;
    resumePath?: string;
    resumeSaveError?: string;
  }>
> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_CREDENTIAL_ERROR));
  }

  try {
    const { input, resumeUpload } = await buildExtractInput(formData);
    const result = await extractProfile(input, credential);

    let resumeSaved = false;
    let resumePath: string | undefined;
    let resumeSaveError: string | undefined;
    if (resumeUpload) {
      try {
        const saved = saveResume(resumeUpload.data, resumeUpload.mediaType);
        const currentApplyProfile = rawApplyProfile(readRawConfig());
        if (typeof currentApplyProfile.email !== "string" || currentApplyProfile.email.trim() === "") {
          resumeSaveError =
            'The resume file was saved, but linking it to your profile needs an email set first — enter one in "Apply profile" and save, then re-upload to finish linking it.';
        } else {
          const saveResult = saveConfig({ applyProfile: { ...currentApplyProfile, resumePath: saved.path } });
          if (!saveResult.ok) throw new Error(saveResult.error);
          resumeSaved = true;
          resumePath = saved.path;
          revalidatePath("/config");
        }
      } catch (e) {
        resumeSaveError = e instanceof Error ? e.message : String(e);
      }
    }

    return actionOk({ ...result, resumeSaved, resumePath, resumeSaveError });
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Removes the persisted resume: deletes the on-disk file (via
 * `deleteResume()`, idempotent even if it's already gone) and clears
 * `applyProfile.resumePath` from `config.json`. Falls back to
 * `getResumePath()`'s well-known fixed path when `resumePath` isn't set in
 * config (e.g. a prior upload's file save succeeded but its config-link
 * step didn't, per `extractProfileFromResumeAction()`'s own
 * `resumeSaveError` case above) — this action still cleans it up.
 */
export async function removeResumeAction(): Promise<ActionResult<null>> {
  try {
    const currentApplyProfile = rawApplyProfile(readRawConfig());
    const resumePath = typeof currentApplyProfile.resumePath === "string" ? currentApplyProfile.resumePath : getResumePath();
    deleteResume(resumePath);

    if ("resumePath" in currentApplyProfile) {
      const { resumePath: _drop, ...rest } = currentApplyProfile;
      const saveResult = saveConfig({ applyProfile: rest });
      if (!saveResult.ok) return actionErr(new Error(saveResult.error));
    }
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/config");
  return actionOk(null);
}

/**
 * Read-only trust-status lookup for one `(sourceId, tier)` auto-fire pair
 * (graduated-auto-fire-trust epic) — the `/config` Auto-fire section's
 * "Check status" button calls this. Wraps `approvedCount()`
 * (`src/lib/apply/autofire.ts`) directly: a plain SQL read against the real
 * approval history, never mutates anything, no `revalidatePath()` call (the
 * pattern every OTHER action in this file follows after a write — this one
 * is deliberately not a write). `minApprovals`/graduated-or-not is computed
 * client-side against the CURRENT (possibly unsaved) draft form value, not
 * here — this action only reports the one real number it can answer:
 * how many approvals actually exist right now for this pair.
 */
export async function getAutoFireApprovedCountAction(sourceId: string, tier: Tier): Promise<ActionResult<number>> {
  try {
    return actionOk(approvedCount(sourceId, tier));
  } catch (e) {
    return actionErr(e);
  }
}

// ---------------------------------------------------------------------------
// Gmail OAuth connect/disconnect (email-digest-ingestion epic,
// gmail-connect-ui story) — thin wrappers around oauth2.ts/
// oauth-credentials.ts, same {ok,error} + revalidatePath() convention as
// every other write-action in this file.
// ---------------------------------------------------------------------------

/**
 * Resolves the Gmail source's client id via `resolveOAuthClientCredentials()`
 * (throws a specific "not configured yet, see docs/gmail-oauth-setup.md"
 * error, propagated as-is — never rephrased) and builds the real Google
 * authorization URL. Returns the URL for the CLIENT to navigate to via a
 * real top-level `window.location.href` assignment — Google's consent
 * screen can't render inside a Server Action's response, so this can never
 * be a redirect performed server-side.
 *
 * No `revalidatePath()`: building an authorization URL creates no
 * persisted state (the pending-authorization entry lives in oauth2.ts's
 * in-memory map) — same reasoning `startCaptureAction()` already
 * documents for its own identical case.
 */
export async function startGmailOAuthAction(sourceId: string): Promise<ActionResult<{ authorizationUrl: string }>> {
  try {
    const { clientId } = resolveOAuthClientCredentials(sourceId, GMAIL_PROVIDER);
    const { url } = buildAuthorizationUrl(GMAIL_PROVIDER, sourceId, clientId);
    return actionOk({ authorizationUrl: url });
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Deletes the source's stored Gmail token set via whichever backend its
 * `settings.sessionBackend` configures (`rawSourceConfigFor()` above,
 * reused — same "find by id" scan `startCaptureAction()`'s origins
 * fallback already uses). `deleteTokenSet()` is documented as idempotent/
 * never-throwing for an already-disconnected source, but the whole action
 * still follows this file's universal try/catch + `actionErr(e)` shape.
 */
export async function disconnectGmailAction(sourceId: string): Promise<ActionResult<null>> {
  try {
    const raw = readRawConfig();
    const sc = rawSourceConfigFor(raw.sources, sourceId);
    const backend = sessionBackendFrom(sc);
    await deleteTokenSet(GMAIL_PROVIDER, sourceId, backend);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/config");
  return actionOk(null);
}
