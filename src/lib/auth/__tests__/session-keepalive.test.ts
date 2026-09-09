// Tests for src/lib/auth/session-keepalive.ts (session-keepalive-refresh
// story, real-app-diagnosability epic follow-up). withBrowserSession() is
// fully mocked (no real Chromium launch, matching gofractional-status.
// test.ts's own convention) -- this file focuses on what's actually NEW
// here: the dwell + re-save-regardless-of-tier write-back logic, and the
// real per-source KEEPALIVE_TARGETS registry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";

const withBrowserSessionMock = vi.fn();
vi.mock("../browser-session.js", async () => {
  const actual = await vi.importActual<typeof import("../browser-session.js")>("../browser-session.js");
  return {
    ...actual,
    withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
  };
});

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
import { decrypt } from "../../security/vault.js";
import { KEEPALIVE_TARGETS, keepAliveSession, DEFAULT_KEEPALIVE_DWELL_MS } from "../session-keepalive.js";

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting?: string;
  sessionBackend?: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
  attended: boolean;
}

function fakePage(storageStateResult: { cookies: unknown[]; origins: unknown[] }) {
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const storageState = vi.fn().mockResolvedValue(storageStateResult);
  return { waitForTimeout, page: { waitForTimeout, context: () => ({ storageState }) } };
}

let tmpDir: string;
let tmpKeyDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-keepalive-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-keepalive-key-"));
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  withBrowserSessionMock.mockReset();
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
});

describe("KEEPALIVE_TARGETS", () => {
  it("has exactly the real browser-session-auth sources this codebase has today", () => {
    expect(KEEPALIVE_TARGETS.map((t) => t.sourceId).sort()).toEqual(["ateam", "gofractional", "wellfound"]);
  });

  it("every target has a non-empty url and a real isAuthenticated function", () => {
    for (const target of KEEPALIVE_TARGETS) {
      expect(target.url.length).toBeGreaterThan(0);
      expect(typeof target.isAuthenticated).toBe("function");
    }
  });
});

describe("keepAliveSession", () => {
  const gofractionalTarget = KEEPALIVE_TARGETS.find((t) => t.sourceId === "gofractional")!;

  it("dwells for DEFAULT_KEEPALIVE_DWELL_MS by default, unattended, against the target's own real url/isAuthenticated pairing", async () => {
    const sessionStatePath = path.join(tmpDir, "gofractional-session.json");
    const { waitForTimeout, page } = fakePage({ cookies: [], origins: [] });
    withBrowserSessionMock.mockImplementation(async (options: WithBrowserSessionOptions, run: (p: unknown) => Promise<void>) => {
      expect(options.sourceId).toBe("gofractional");
      expect(options.url).toBe(gofractionalTarget.url);
      expect(options.isAuthenticated).toBe(gofractionalTarget.isAuthenticated);
      expect(options.attended).toBe(false);
      expect(options.storageStatePathSetting).toBe(sessionStatePath);
      await run(page);
    });

    const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath } };
    await keepAliveSession(gofractionalTarget, cfg);

    expect(waitForTimeout).toHaveBeenCalledWith(DEFAULT_KEEPALIVE_DWELL_MS);
  });

  it("accepts a custom dwellMs override", async () => {
    const sessionStatePath = path.join(tmpDir, "gofractional-session.json");
    const { waitForTimeout, page } = fakePage({ cookies: [], origins: [] });
    withBrowserSessionMock.mockImplementation(async (_options: WithBrowserSessionOptions, run: (p: unknown) => Promise<void>) => {
      await run(page);
    });

    const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath } };
    await keepAliveSession(gofractionalTarget, cfg, 5_000);

    expect(waitForTimeout).toHaveBeenCalledWith(5_000);
  });

  it("re-saves the (possibly refreshed) storageState after dwelling, scoped to the source's own real allowlist -- the actual point of this mechanism", async () => {
    const sessionStatePath = path.join(tmpDir, "gofractional-session.json");
    const freshCookie = { name: "session", value: "refreshed-during-dwell", domain: "app.gofractional.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    const unrelatedCookie = { name: "sid", value: "must-be-filtered-out", domain: "accounts.google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    const { page } = fakePage({ cookies: [freshCookie, unrelatedCookie], origins: [] });
    withBrowserSessionMock.mockImplementation(async (_options: WithBrowserSessionOptions, run: (p: unknown) => Promise<void>) => {
      await run(page);
    });

    const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath } };
    await keepAliveSession(gofractionalTarget, cfg);

    const written = JSON.parse(decrypt(fs.readFileSync(sessionStatePath, "utf8")));
    expect(written.cookies).toHaveLength(1);
    expect(written.cookies[0]?.value).toBe("refreshed-during-dwell");
  });

  it("never writes an empty session over a good one -- if the dwell somehow lost all cookies, the last-known-good file is left alone", async () => {
    const sessionStatePath = path.join(tmpDir, "gofractional-session.json");
    fs.writeFileSync(sessionStatePath, "pre-existing-content-must-survive");
    const { page } = fakePage({ cookies: [], origins: [] });
    withBrowserSessionMock.mockImplementation(async (_options: WithBrowserSessionOptions, run: (p: unknown) => Promise<void>) => {
      await run(page);
    });

    const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath } };
    await keepAliveSession(gofractionalTarget, cfg);

    expect(fs.readFileSync(sessionStatePath, "utf8")).toBe("pre-existing-content-must-survive");
  });

  it("throws a specific, actionable error when the source has no sessionStatePath configured, before ever calling withBrowserSession()", async () => {
    const cfg: SourceConfig = { id: "gofractional", enabled: true };
    await expect(keepAliveSession(gofractionalTarget, cfg)).rejects.toThrow(/no settings.sessionStatePath configured/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });

  it("propagates a real session failure (e.g. a genuinely expired/invalid session) the exact same way withBrowserSession() itself throws it", async () => {
    withBrowserSessionMock.mockRejectedValue(new Error("gigradar browser-session: session expired/invalid for source \"gofractional\""));
    const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath: path.join(tmpDir, "gofractional-session.json") } };
    await expect(keepAliveSession(gofractionalTarget, cfg)).rejects.toThrow(/session expired\/invalid/);
  });
});
