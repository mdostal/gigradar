"use server";

import { revalidatePath } from "next/cache";
import { actionErr, actionOk } from "@/lib/actions/result";
import { approvedCount } from "@/lib/apply/autofire";
import { cancelCapture, finishCapture, startCapture } from "@/lib/auth/session-capture";
import { readEnvVar, setEnvVar } from "@/lib/config/env-store";
import { type ConfigEdits, readRawConfig, saveConfig } from "@/lib/config/save";
import { extractProfile } from "@/lib/profile-ingestion/extract";
import { SOURCE_LOGIN_URLS } from "@/lib/sources/origins";
import type { ActionResult } from "@/lib/actions/result";
import type { ExtractProfileInput } from "@/lib/profile-ingestion/extract";
import type { Config, Tier } from "@/lib/types";

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
 * Wraps `startCapture()`: looks up `sourceId`'s login URL from the shared
 * `SOURCE_LOGIN_URLS` registry (`src/lib/sources/origins.ts`) and launches a
 * capture. `startCapture()` itself never throws a generic message — its
 * errors already name the exact failure (missing Chromium binary, launch
 * failure, failed navigation) — so this action's `catch` just carries that
 * message through verbatim via `actionErr()`, never replacing it with a
 * generic "capture failed."
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
  const loginUrl = SOURCE_LOGIN_URLS[sourceId];
  if (!loginUrl) {
    return actionErr(
      new Error(`gigradar config: no login URL registered for source "${sourceId}" (see src/lib/sources/origins.ts).`),
    );
  }

  try {
    const { captureId } = await startCapture(sourceId, loginUrl);
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
 * Wraps `finishCapture(captureId)`. `sourceId` is supplied by the caller
 * (the client already knows it — it's the same id `startCaptureAction()`
 * was called with for this row) rather than derived from `captureId`,
 * since `finishCapture()`'s return value (`{ path }`) doesn't expose it.
 *
 * On success: AUTO-WRITES the returned path into that source's
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
 * On failure — either `finishCapture()` itself throwing (e.g. the
 * zero-cookies sanity check, or "capture not found or already expired") or
 * the subsequent `saveConfig()` call failing validation — the SPECIFIC
 * error message is returned verbatim via `actionErr()`, never a generic
 * "capture failed" string. A `finishCapture()` failure writes nothing (that
 * guarantee lives in `session-capture.ts` itself); a `saveConfig()` failure
 * after a successful `finishCapture()` leaves the just-captured session
 * file on disk (capture succeeded) but the config.json write did not go
 * through — surfaced as an explicit error rather than silently pretending
 * the whole operation succeeded.
 */
export async function finishCaptureAction(captureId: string, sourceId: string): Promise<ActionResult<{ path: string }>> {
  let path: string;
  try {
    ({ path } = await finishCapture(captureId));
  } catch (e) {
    return actionErr(e);
  }

  const raw = readRawConfig();
  const sources = withSessionStatePath(raw.sources, sourceId, path);

  const saveResult = saveConfig({ sources });
  if (!saveResult.ok) return actionErr(new Error(saveResult.error));

  revalidatePath("/config");
  return actionOk({ path });
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
 * bubbling up from `extractProfile()`'s own `Anthropic` client construction.
 */
const MISSING_API_KEY_ERROR =
  'gigradar profile ingestion: no Anthropic API key is set. Enter one in the "Anthropic API key" field above and save it, then try again.';

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
async function buildExtractInput(formData: FormData): Promise<ExtractProfileInput> {
  const input: ExtractProfileInput = {};

  const file = formData.get("resumeFile");
  if (file instanceof File && file.size > 0) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (file.type === "application/pdf") {
      input.resumeFile = { data: buffer, mediaType: "application/pdf" };
    } else {
      input.resumeText = buffer.toString("utf8");
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

  return input;
}

/**
 * Wraps `extractProfile()` (`src/lib/profile-ingestion/extract.ts`) for the
 * "Extract from resume/link" button. Accepts a `FormData` file upload
 * (`resumeFile`, PDF or plain text) plus a `links` textarea value, and
 * returns `ActionResult<{roles, skills, warnings}>`.
 *
 * **The API key is resolved fresh, INSIDE this handler, on every call** —
 * via `env-store.ts`'s `readEnvVar()`, never `process.env` and never a
 * module-scope constant — per this story's non-negotiable requirement
 * (collaborative-review finding, design-discussion.md §3 step 4): the
 * Next.js app's Server Action request path never populates `process.env`
 * from `.env` (only the CLI/cron path, via `loadConfig()`, does that), and a
 * module-scope-resolved key would go stale (or permanently capture
 * `undefined`) the moment the key is set/changed without a server restart.
 * A missing key short-circuits BEFORE `buildExtractInput()` or
 * `extractProfile()` run at all, returning `MISSING_API_KEY_ERROR` — a
 * specific error naming the "Anthropic API key" field, never a generic
 * Anthropic SDK authentication failure.
 *
 * Per-link fetch/parse failures (including known login-walls) never fail
 * this action as a whole — `extractProfile()` itself collects those into
 * `warnings` and still returns a real (possibly partial) result; only a
 * fully unusable input or a genuine Anthropic API error reaches this
 * function's `catch` and comes back as `{ok:false}`.
 *
 * Writes nothing, ever: neither the uploaded resume bytes nor the extracted
 * result touch disk here. Nothing is persisted until the user's own,
 * separate, existing Save action folds the merged draft into `config.json`
 * via `saveConfigAction` above — this action has no `saveConfig()`/
 * `revalidatePath()` call of any kind.
 */
export async function extractProfileFromResumeAction(
  formData: FormData,
): Promise<ActionResult<{ roles: string[]; skills: string[]; warnings: string[] }>> {
  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  try {
    const input = await buildExtractInput(formData);
    const result = await extractProfile(input, apiKey);
    return actionOk(result);
  } catch (e) {
    return actionErr(e);
  }
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
