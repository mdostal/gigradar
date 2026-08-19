// Tests for the three session-capture Server Actions added by the
// `session-capture-ui` story (`startCaptureAction`/`finishCaptureAction`/
// `cancelCaptureAction`, all in `../actions.ts` alongside the pre-existing
// `saveConfigAction`). Per this story's `steps.test` description: "mocking
// session-capture.ts's functions" — `src/lib/auth/session-capture.ts`'s
// `startCapture`/`finishCapture`/`cancelCapture` are mocked here so these
// tests exercise ONLY these actions' own logic (URL lookup, the
// {ok,error}/revalidatePath convention, and the auto-write-to-config.json
// merge), never real Playwright/Chromium. A SEPARATE integration test file
// (`capture-actions.integration.test.ts`, opt-in only — see its own header)
// exercises the real, unmocked session-capture.ts functions end to end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reasoning as actions.test.ts: revalidatePath() asserts a real
// Next.js request context that doesn't exist under vitest.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const startCaptureMock = vi.fn();
const finishCaptureMock = vi.fn();
const cancelCaptureMock = vi.fn();
const getCapturePageMock = vi.fn();

vi.mock("@/lib/auth/session-capture", () => ({
  startCapture: (...args: unknown[]) => startCaptureMock(...args),
  finishCapture: (...args: unknown[]) => finishCaptureMock(...args),
  cancelCapture: (...args: unknown[]) => cancelCaptureMock(...args),
  getCapturePage: (...args: unknown[]) => getCapturePageMock(...args),
}));

const checkCaptureReadinessMock = vi.fn();
vi.mock("@/lib/auth/capture-guidance", () => ({
  checkCaptureReadiness: (...args: unknown[]) => checkCaptureReadinessMock(...args),
}));

import { revalidatePath } from "next/cache";
import { getConfigPath } from "@/lib/config/load";
import { setEnvVar } from "@/lib/config/env-store";
import { decrypt } from "@/lib/security/vault";
import { SOURCE_LOGIN_URLS } from "@/lib/sources/origins";
import { cancelCaptureAction, checkCaptureReadinessAction, finishCaptureAction, startCaptureAction } from "../actions";

// Same isolation pattern as actions.test.ts / save.test.ts: every test
// points XDG_DATA_HOME (config.json) AND XDG_CONFIG_HOME (the vault key —
// config.json is encrypted at rest, see the config-json-encryption story)
// at fresh temp dirs so this suite never touches a real user's actual
// config.json or ~/.config/gigradar/key.
let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-capture-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-capture-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  vi.mocked(revalidatePath).mockClear();
  startCaptureMock.mockReset();
  finishCaptureMock.mockReset();
  cancelCaptureMock.mockReset();
  getCapturePageMock.mockReset();
  checkCaptureReadinessMock.mockReset();
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

// Legacy-plaintext fixture writer — finishCaptureAction() ultimately calls
// saveConfig(), whose internal raw-read gracefully accepts legacy plaintext
// input (decrypt-if-needed), so seeding tests with plain JSON here still
// works exactly as before; only the ON-DISK RESULT after a save is now
// encrypted (see readOnDiskConfig() below).
function writeConfig(doc: unknown): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2));
}

/**
 * Reads config.json's raw bytes off disk and decrypts them — config.json is
 * encrypted at rest after any successful save. Returns `any`, same as a
 * plain `JSON.parse()` result (what every call site here used before this
 * story), so existing loose property-access assertions below don't need
 * per-call-site casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above
function readOnDiskConfig(): any {
  return JSON.parse(decrypt(fs.readFileSync(getConfigPath(), "utf8")));
}

const validConfigBase = {
  profile: { name: "Ada", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
  needs: {
    minRate: 150,
    highRate: 250,
    maxHours: 20,
    maxHoursAtHighRate: 40,
    allowContractToHire: false,
    freshStageOnly: true,
    remoteOnly: true,
  },
};

describe("startCaptureAction", () => {
  it("calls startCapture(sourceId, loginUrl) using SOURCE_LOGIN_URLS and returns {ok:true, data:{captureId}}", async () => {
    startCaptureMock.mockResolvedValue({ captureId: "capture-123" });

    const result = await startCaptureAction("gofractional");

    expect(startCaptureMock).toHaveBeenCalledTimes(1);
    expect(startCaptureMock).toHaveBeenCalledWith("gofractional", SOURCE_LOGIN_URLS["gofractional"], ["gofractional.com"]);
    expect(result).toEqual({ ok: true, data: { captureId: "capture-123" } });
    // Starting a capture never mutates config.json — nothing to revalidate.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("works for ateam too, using its own registered login URL", async () => {
    startCaptureMock.mockResolvedValue({ captureId: "capture-456" });

    const result = await startCaptureAction("ateam");

    expect(startCaptureMock).toHaveBeenCalledWith("ateam", SOURCE_LOGIN_URLS["ateam"], ["a.team", "platform.a.team"]);
    expect(result).toEqual({ ok: true, data: { captureId: "capture-456" } });
  });

  it("returns {ok:false,error} without calling startCapture() for a source id with no registered login URL", async () => {
    const result = await startCaptureAction("some-unregistered-source");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("some-unregistered-source");
    expect(startCaptureMock).not.toHaveBeenCalled();
  });

  it("surfaces startCapture()'s SPECIFIC thrown error message, not a generic failure", async () => {
    startCaptureMock.mockRejectedValue(
      new Error('gigradar session-capture: failed to launch Chromium for source "gofractional": some real reason'),
    );

    const result = await startCaptureAction("gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("failed to launch Chromium");
    expect(result.error).toContain("gofractional");
  });
});

describe("finishCaptureAction: success", () => {
  it("auto-writes the captured path into that source's settings.sessionStatePath (existing config.json, no sources yet)", async () => {
    // Capturing a login only makes sense once profile/needs already exist —
    // ConfigSchema requires both, and a capture button is only ever shown
    // next to an already-rendered SourceConfig row in the form, which
    // implies the page loaded an existing (or in-progress-but-unsaved)
    // config. This seeds the realistic "config exists, this particular
    // source has never been saved before" starting state.
    writeConfig({ ...validConfigBase, sources: [] });
    finishCaptureMock.mockResolvedValue({ path: "/data/gofractional-session.json" });

    const result = await finishCaptureAction("capture-123", "gofractional");

    // "local" -- resolved from this source's config, which has no
    // settings.sessionBackend set (defaults to "local").
    expect(finishCaptureMock).toHaveBeenCalledWith("capture-123", "local");
    expect(result).toEqual({ ok: true, data: { backend: "local", path: "/data/gofractional-session.json" } });

    const onDisk = readOnDiskConfig();
    const savedSource = onDisk.sources.find((s: { id: string }) => s.id === "gofractional");
    expect(savedSource.settings.sessionStatePath).toBe("/data/gofractional-session.json");

    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/config");
  });

  it("preserves the source's OTHER settings and every unrelated source/profile/needs field (full-document, not a blind overwrite)", async () => {
    writeConfig({
      ...validConfigBase,
      sources: [
        { id: "gofractional", enabled: true, settings: { someOtherKey: "keep-me" } },
        { id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } },
      ],
      roleArea: { coreTitles: ["CTO"], keywords: [], redKeywords: [] },
    });
    finishCaptureMock.mockResolvedValue({ path: "/data/gofractional-session.json" });

    const result = await finishCaptureAction("capture-123", "gofractional");

    expect(result.ok).toBe(true);

    const onDisk = readOnDiskConfig();
    const gofractional = onDisk.sources.find((s: { id: string }) => s.id === "gofractional");
    expect(gofractional.settings.someOtherKey).toBe("keep-me");
    expect(gofractional.settings.sessionStatePath).toBe("/data/gofractional-session.json");

    const braintrust = onDisk.sources.find((s: { id: string }) => s.id === "braintrust");
    expect(braintrust.settings.apiKey).toBe("env:BRAINTRUST_API_KEY");

    expect(onDisk.profile.name).toBe("Ada");
    expect(onDisk.roleArea.coreTitles).toEqual(["CTO"]);
  });

  it("appends a new minimal source entry when the source doesn't exist yet in the saved config (capture success is never lost)", async () => {
    writeConfig({ ...validConfigBase, sources: [{ id: "braintrust", enabled: true }] });
    finishCaptureMock.mockResolvedValue({ path: "/data/ateam-session.json" });

    const result = await finishCaptureAction("capture-999", "ateam");

    expect(result.ok).toBe(true);
    const onDisk = readOnDiskConfig();
    expect(onDisk.sources).toHaveLength(2);
    const ateam = onDisk.sources.find((s: { id: string }) => s.id === "ateam");
    expect(ateam.enabled).toBe(true);
    expect(ateam.settings.sessionStatePath).toBe("/data/ateam-session.json");
  });
});

describe("finishCaptureAction: failure", () => {
  it("surfaces finishCapture()'s SPECIFIC error (e.g. the zero-cookies sanity check) verbatim, not a generic message, and writes nothing", async () => {
    finishCaptureMock.mockRejectedValue(
      new Error(
        'gigradar session-capture: capture produced no usable session for "gofractional" — login may not have completed.',
      ),
    );

    const result = await finishCaptureAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("capture produced no usable session");
    expect(result.error).toContain("login may not have completed");
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces a 'capture not found or already expired' error verbatim and writes nothing", async () => {
    finishCaptureMock.mockRejectedValue(
      new Error('gigradar session-capture: capture not found or already expired (id "stale-id").'),
    );

    const result = await finishCaptureAction("stale-id", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("capture not found or already expired");
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("returns saveConfig()'s specific validation error (not swallowed as a generic message) when no config.json exists yet to hold the source", async () => {
    // No profile/needs on disk yet — ConfigSchema legitimately rejects a
    // sources-only document. finishCapture() itself already succeeded (the
    // session file WAS written to disk by session-capture.ts, outside this
    // action's control), but the config.json auto-write on top of it fails,
    // and that failure surfaces specifically rather than reporting a false
    // "success".
    finishCaptureMock.mockResolvedValue({ path: "/data/gofractional-session.json" });

    const result = await finishCaptureAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("profile");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("leaves an existing config.json's CONTENT untouched when finishCapture() fails", async () => {
    // Content, not raw bytes: finishCaptureAction() now reads config.json
    // BEFORE calling finishCapture() (to resolve which session backend the
    // source is configured for), and readRawConfig() migrate-writes a
    // legacy plaintext file to an encrypted envelope on read (same
    // migrate-on-read behavior every other raw config read already has) --
    // a content-preserving encoding change, not data loss. The invariant
    // this test actually cares about is that the DATA is unchanged, so it
    // compares decrypted content rather than raw on-disk bytes.
    const seeded = { ...validConfigBase, sources: [{ id: "gofractional", enabled: true }] };
    writeConfig(seeded);
    finishCaptureMock.mockRejectedValue(new Error("gigradar session-capture: capture produced no usable session"));

    const result = await finishCaptureAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    expect(readOnDiskConfig()).toEqual(seeded);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("cancelCaptureAction", () => {
  it("calls cancelCapture(captureId) and returns {ok:true}, writing nothing and never revalidating", async () => {
    cancelCaptureMock.mockResolvedValue(undefined);

    const result = await cancelCaptureAction("capture-123");

    expect(cancelCaptureMock).toHaveBeenCalledWith("capture-123");
    expect(result).toEqual({ ok: true, data: null });
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns {ok:false,error} if cancelCapture() were ever to throw (defensive — documented as never-throwing today)", async () => {
    cancelCaptureMock.mockRejectedValue(new Error("some unexpected cancel failure"));

    const result = await cancelCaptureAction("capture-123");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("some unexpected cancel failure");
  });
});

describe("checkCaptureReadinessAction (oauth-session-capture-v2 epic, llm-capture-readiness-check story)", () => {
  it("returns {ok:true, data:{ready, note}} from checkCaptureReadiness(), and writes nothing / never revalidates", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    getCapturePageMock.mockReturnValue({ fake: "page" });
    checkCaptureReadinessMock.mockResolvedValue({ ready: true, note: "Looks like a signed-in dashboard." });

    const result = await checkCaptureReadinessAction("capture-123", "gofractional");

    expect(getCapturePageMock).toHaveBeenCalledWith("capture-123");
    expect(checkCaptureReadinessMock).toHaveBeenCalledWith({ fake: "page" }, "gofractional", {
      kind: "api-key",
      provider: "anthropic",
      value: "sk-ant-fake-test-key",
    });
    expect(result).toEqual({ ok: true, data: { ready: true, note: "Looks like a signed-in dashboard." } });
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a specific error and never calls checkCaptureReadiness() when no Anthropic credential is set", async () => {
    const result = await checkCaptureReadinessAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no Anthropic credential is set");
    expect(getCapturePageMock).not.toHaveBeenCalled();
    expect(checkCaptureReadinessMock).not.toHaveBeenCalled();
  });

  it("surfaces getCapturePage()'s SPECIFIC error (e.g. an expired capture) verbatim, never calling checkCaptureReadiness()", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    getCapturePageMock.mockImplementation(() => {
      throw new Error('gigradar session-capture: capture not found or already expired (id "capture-123").');
    });

    const result = await checkCaptureReadinessAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("not found or already expired");
    expect(checkCaptureReadinessMock).not.toHaveBeenCalled();
  });

  it("surfaces checkCaptureReadiness()'s SPECIFIC error verbatim, never a generic message", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    getCapturePageMock.mockReturnValue({ fake: "page" });
    checkCaptureReadinessMock.mockRejectedValue(
      new Error("gigradar capture-guidance: the Anthropic API response did not include the expected structured readiness result."),
    );

    const result = await checkCaptureReadinessAction("capture-123", "gofractional");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("did not include the expected structured readiness result");
  });
});
