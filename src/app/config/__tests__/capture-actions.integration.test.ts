// A REAL-BROWSER integration test for the session-capture Server Actions,
// deliberately SEPARATE from capture-actions.test.ts (which mocks
// `session-capture.ts` entirely). This file exercises the actual,
// UNMOCKED `startCapture`/`finishCapture`/`cancelCapture` functions —
// real `chromium.launch({ headless: false })`, a real `BrowserContext`,
// real `storageState()`/atomic file write — through the real
// `startCaptureAction`/`finishCaptureAction`/`cancelCaptureAction` Server
// Actions, proving the actual plumbing (not just each layer's own mocked
// unit tests) genuinely connects end to end.
//
// NEVER TOUCHES A REAL LOGIN SITE. `SOURCE_LOGIN_URLS` (the only thing this
// file mocks — `SOURCE_ORIGINS` stays real/unmocked) is overridden to point
// both `gofractional` and `ateam` at local `data:` URLs instead of the real
// `gofractional.com`/`a.team` sites — this is the "point startCapture at a
// simple local/data URL instead of a real site's login page" approach
// named in this story's verification plan, so this test can prove the real
// mechanism works without any real login, any real account, or any network
// call to an external site at all. The "user logs in" step a real capture
// would wait on is simulated here by reaching into session-capture.ts's own
// `globalThis`-pinned capture map (the SAME map `session-capture.test.ts`
// already reaches into to prove the HMR-survival claim — see that file) to
// call the real, live `BrowserContext.addCookies()` directly, exactly as if
// a real login had just set a session cookie.
//
// OPT-IN ONLY — SKIPPED BY DEFAULT, not part of the default `npm test` run.
// Every other Playwright-touching test in this repo (session-capture.test.ts
// itself, gofractional.test.ts, ateam.test.ts) fully mocks `chromium` —
// "Chromium launch is fully mocked throughout — no real browser, no live
// network" is this repo's own stated convention for the AUTOMATED suite.
// This file breaks that convention deliberately (to genuinely prove the
// plumbing, per this story's explicit ask), so it opts ITSELF back out of
// the default run rather than making that choice for every future
// `npm test` invocation (CI, other contributors' machines, sandboxed agents
// without a display) that didn't ask for a real headed Chromium window to
// open. Run it explicitly with:
//
//   GIGRADAR_TEST_REAL_BROWSER=1 npx vitest run src/app/config/__tests__/capture-actions.integration.test.ts
//
// Requires `npx playwright install chromium` to have been run once (same
// requirement as any other real use of session-capture.ts) and a real
// display the headed browser can open on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt } from "@/lib/security/vault";

const RUN_REAL_BROWSER = process.env.GIGRADAR_TEST_REAL_BROWSER === "1";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The ONLY mock in this file besides next/cache: override just
// SOURCE_LOGIN_URLS to local data: URLs, keeping SOURCE_ORIGINS (spread
// from the real module) completely real/unmodified — session-capture.ts's
// own real finishCapture() still filters against the REAL gofractional.com
// / a.team,platform.a.team allowlists, proving that part of the mechanism
// for real too.
vi.mock("@/lib/sources/origins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/origins")>();
  return {
    ...actual,
    SOURCE_LOGIN_URLS: {
      gofractional: "data:text/html,<h1>Fake local login page for integration test (gofractional) - not a real site</h1>",
      ateam: "data:text/html,<h1>Fake local login page for integration test (ateam) - not a real site</h1>",
    },
  };
});

describe.skipIf(!RUN_REAL_BROWSER)("session-capture Server Actions: REAL browser integration (opt-in)", () => {
  let tmpDir: string;
  let keyTmpDir: string;
  let originalXdgDataHome: string | undefined;
  let originalXdgConfigHome: string | undefined;
  let liveCaptureIds: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-capture-integration-test-"));
    // config.json is encrypted at rest (config-json-encryption story) — the
    // vault key lives under a SEPARATE XDG_CONFIG_HOME tree (key-path.ts),
    // isolated here too so this opt-in real-browser suite never touches a
    // real developer's actual ~/.config/gigradar/key.
    keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-capture-integration-test-key-"));
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = keyTmpDir;
    liveCaptureIds = [];
  });

  afterEach(async () => {
    // Safety net: if a test fails partway through (before its own cancel/
    // finish call), don't leave a real Chromium window open for the full
    // 10-minute idle timeout — cancelCapture() is documented idempotent, so
    // calling it for an id that's already finished/cancelled is a safe
    // no-op.
    const { cancelCapture } = await import("@/lib/auth/session-capture");
    await Promise.all(liveCaptureIds.map((id) => cancelCapture(id).catch(() => {})));

    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(keyTmpDir, { recursive: true, force: true });
  });

  /** Reads config.json's raw bytes off disk and decrypts them — config.json is encrypted at rest after any successful save. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches this test file's existing JSON.parse()-derived any typing
  function readOnDiskConfig(): any {
    return JSON.parse(decrypt(fs.readFileSync(path.join(tmpDir, "gigradar", "config.json"), "utf8")));
  }

  function writeConfig(doc: unknown): void {
    fs.mkdirSync(path.dirname(path.join(tmpDir, "gigradar", "config.json")), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "gigradar", "config.json"), JSON.stringify(doc, null, 2));
  }

  const baseConfig = {
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
    sources: [] as unknown[],
  };

  /**
   * Reaches into session-capture.ts's own `globalThis`-pinned in-flight
   * capture map to get the REAL live `BrowserContext` for `captureId` — the
   * same `(globalThis as any).__gigradarCaptures` map that module itself
   * documents and that `session-capture.test.ts` already reaches into for
   * its own HMR-survival proof. Used here purely for test setup: simulating
   * "the user just logged in and the site set a session cookie" without
   * actually driving a real login form.
   */
  function getLiveContext(captureId: string): BrowserContext {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into the same globalThis-pinned map session-capture.ts itself uses; see this function's doc comment.
    const captures: Map<string, { context: BrowserContext; browser: Browser }> = (globalThis as any)
      .__gigradarCaptures;
    const entry = captures?.get(captureId);
    if (!entry) throw new Error(`test setup: no live capture entry found for id "${captureId}"`);
    return entry.context;
  }

  it(
    "real startCaptureAction -> real Chromium window + cookie -> real finishCaptureAction auto-writes config.json",
    async () => {
      writeConfig(baseConfig);
      const { startCaptureAction, finishCaptureAction } = await import("../actions");

      const startResult = await startCaptureAction("gofractional");
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) throw new Error(`expected ok, got: ${startResult.error}`);
      const { captureId } = startResult.data;
      liveCaptureIds.push(captureId);

      // Simulate "the user just logged in": set a real cookie, scoped to
      // gofractional.com, on the real live BrowserContext startCapture()
      // opened — via the real Playwright API, not a mock.
      await getLiveContext(captureId).addCookies([
        { name: "session_id", value: "fake-integration-test-session-value", url: "https://gofractional.com/" },
      ]);

      const finishResult = await finishCaptureAction(captureId, "gofractional");
      expect(finishResult.ok).toBe(true);
      if (!finishResult.ok) throw new Error(`expected ok, got: ${finishResult.error}`);
      liveCaptureIds = liveCaptureIds.filter((id) => id !== captureId); // finishCapture() already closed it

      // 1. The real session-capture.ts wrote a real storageState file, with
      //    the real cookie we set, filtered to the gofractional.com origin.
      expect(finishResult.data.path).toContain("gofractional-session.json");
      expect(fs.existsSync(finishResult.data.path)).toBe(true);
      const writtenState = JSON.parse(fs.readFileSync(finishResult.data.path, "utf8"));
      expect(writtenState.cookies.length).toBeGreaterThan(0);
      expect(writtenState.cookies.some((c: { name: string }) => c.name === "session_id")).toBe(true);
      expect(fs.statSync(finishResult.data.path).mode & 0o777).toBe(0o600);

      // 2. finishCaptureAction's own auto-write really landed in config.json.
      const onDisk = readOnDiskConfig();
      const savedSource = onDisk.sources.find((s: { id: string }) => s.id === "gofractional");
      expect(savedSource.settings.sessionStatePath).toBe(finishResult.data.path);
    },
    30000,
  );

  it(
    "real cancelCaptureAction genuinely closes the browser and removes the capture — a subsequent finish fails with 'not found'",
    async () => {
      const { startCaptureAction, cancelCaptureAction, finishCaptureAction } = await import("../actions");

      const startResult = await startCaptureAction("ateam");
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) throw new Error(`expected ok, got: ${startResult.error}`);
      const { captureId } = startResult.data;
      liveCaptureIds.push(captureId);

      const cancelResult = await cancelCaptureAction(captureId);
      expect(cancelResult).toEqual({ ok: true, data: null });
      liveCaptureIds = liveCaptureIds.filter((id) => id !== captureId);

      // Proves cancellation was REAL (not just "returned ok"): the capture
      // entry is genuinely gone, so finishing the same id now fails.
      const finishResult = await finishCaptureAction(captureId, "ateam");
      expect(finishResult.ok).toBe(false);
      if (finishResult.ok) throw new Error("expected failure");
      expect(finishResult.error).toContain("not found or already expired");

      // No config.json was ever written — cancel wrote nothing, and the
      // subsequent finish failed before any write too.
      expect(fs.existsSync(path.join(tmpDir, "gigradar", "config.json"))).toBe(false);
    },
    30000,
  );

  it(
    "real finishCaptureAction on a captureId with no cookies set surfaces the SPECIFIC 'no usable session' error, writing nothing",
    async () => {
      writeConfig(baseConfig);
      const { startCaptureAction, finishCaptureAction } = await import("../actions");

      const startResult = await startCaptureAction("gofractional");
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) throw new Error(`expected ok, got: ${startResult.error}`);
      const { captureId } = startResult.data;
      liveCaptureIds.push(captureId);

      // Deliberately no addCookies() call this time — a genuinely empty,
      // freshly-opened context, the real "login never completed" case.
      const finishResult = await finishCaptureAction(captureId, "gofractional");
      liveCaptureIds = liveCaptureIds.filter((id) => id !== captureId); // finishCapture() closes on every exit path, success or failure

      expect(finishResult.ok).toBe(false);
      if (finishResult.ok) throw new Error("expected failure");
      expect(finishResult.error).toContain("capture produced no usable session");
      expect(finishResult.error).toContain("gofractional");

      const onDisk = readOnDiskConfig();
      expect(onDisk.sources).toEqual([]); // unchanged from what writeConfig() set — no partial/failed write landed
    },
    30000,
  );
});
