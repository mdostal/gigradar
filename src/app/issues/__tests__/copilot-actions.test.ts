// Tests for the three verification-copilot Server Actions added by the
// `verification-copilot-browser-action` story
// (`openCopilotSessionAction`/`checkCopilotReadinessAction`/
// `finishCopilotSessionAction`, all in `../actions.ts` alongside the
// pre-existing `resolveIssueAction`). Mirrors
// config/__tests__/capture-actions.test.ts's shape: mock
// verification-copilot-session.ts and capture-guidance.ts so these tests
// exercise ONLY these actions' own logic (raw-config lookup, the
// {ok,error}/revalidatePath convention, "close+resolve together"), never
// real Playwright/Chromium.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reasoning as actions.test.ts: revalidatePath() asserts a real
// Next.js request context that doesn't exist under vitest.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// raiseIssue()'s desktop notification is mocked so seeding an issue never
// actually shells out to osascript/notify-send.
vi.mock("@/lib/notify/desktop", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

const openCopilotSessionMock = vi.fn();
const getCopilotPageMock = vi.fn();
const closeCopilotSessionMock = vi.fn();
vi.mock("@/lib/auth/verification-copilot-session", () => ({
  openCopilotSession: (...args: unknown[]) => openCopilotSessionMock(...args),
  getCopilotPage: (...args: unknown[]) => getCopilotPageMock(...args),
  closeCopilotSession: (...args: unknown[]) => closeCopilotSessionMock(...args),
}));

const checkCaptureReadinessMock = vi.fn();
vi.mock("@/lib/auth/capture-guidance", () => ({
  checkCaptureReadiness: (...args: unknown[]) => checkCaptureReadinessMock(...args),
}));

import { revalidatePath } from "next/cache";
import { getConfigPath } from "@/lib/config/load";
import { setEnvVar } from "@/lib/config/env-store";
import { closeDb, getDb } from "@/lib/store/db";
import { listIssues, raiseIssue } from "@/lib/notify/issues";
import { checkCopilotReadinessAction, finishCopilotSessionAction, openCopilotSessionAction } from "../actions";

const SOURCE_ID = "gofractional";
const BLOCKED_URL = "https://gofractional.com/jobs?blocked=1";

let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-copilot-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-copilot-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  getDb();
  vi.mocked(revalidatePath).mockClear();
  openCopilotSessionMock.mockReset();
  getCopilotPageMock.mockReset();
  closeCopilotSessionMock.mockReset();
  checkCaptureReadinessMock.mockReset();
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

function writeConfig(doc: unknown): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2));
}

describe("openCopilotSessionAction", () => {
  it("resolves the source's raw sessionStatePath setting from config and opens a co-pilot session", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [{ id: SOURCE_ID, enabled: true, settings: { sessionStatePath: "storage-state.json" } }],
    });
    openCopilotSessionMock.mockResolvedValue({ sessionId: "session-1", sourceId: SOURCE_ID });

    const result = await openCopilotSessionAction(SOURCE_ID, BLOCKED_URL);

    expect(result).toEqual({ ok: true, data: { sessionId: "session-1" } });
    expect(openCopilotSessionMock).toHaveBeenCalledWith(SOURCE_ID, BLOCKED_URL, "storage-state.json");
  });

  it("returns a specific error, without ever calling openCopilotSession(), when the source has no sessionStatePath configured", async () => {
    writeConfig({ profile: {}, needs: {}, sources: [{ id: SOURCE_ID, enabled: true, settings: {} }] });

    const result = await openCopilotSessionAction(SOURCE_ID, BLOCKED_URL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/capture a login for it/);
    expect(openCopilotSessionMock).not.toHaveBeenCalled();
  });

  it("propagates openCopilotSession()'s own error message (e.g. already-active session)", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [{ id: SOURCE_ID, enabled: true, settings: { sessionStatePath: "storage-state.json" } }],
    });
    openCopilotSessionMock.mockRejectedValue(new Error("already active for source"));

    const result = await openCopilotSessionAction(SOURCE_ID, BLOCKED_URL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/already active for source/);
  });
});

describe("checkCopilotReadinessAction", () => {
  it("returns a specific error, without calling getCopilotPage(), when no Anthropic API key is configured", async () => {
    const result = await checkCopilotReadinessAction("session-1", SOURCE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/No Anthropic API key/);
    expect(getCopilotPageMock).not.toHaveBeenCalled();
  });

  it("wraps checkCaptureReadiness() against the co-pilot session's live page, never closing the session or resolving anything", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    const fakePage = { locator: vi.fn() };
    getCopilotPageMock.mockReturnValue(fakePage);
    checkCaptureReadinessMock.mockResolvedValue({ ready: false, note: "Still showing a challenge" });

    const result = await checkCopilotReadinessAction("session-1", SOURCE_ID);

    expect(result).toEqual({ ok: true, data: { ready: false, note: "Still showing a challenge" } });
    expect(getCopilotPageMock).toHaveBeenCalledWith("session-1");
    expect(checkCaptureReadinessMock).toHaveBeenCalledWith(fakePage, SOURCE_ID, "sk-ant-fake-test-key");
    expect(closeCopilotSessionMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("propagates a getCopilotPage() failure (unknown/expired session)", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    getCopilotPageMock.mockImplementation(() => {
      throw new Error("session not found or expired");
    });

    const result = await checkCopilotReadinessAction("not-a-real-session", SOURCE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/not found or expired/);
  });
});

describe("finishCopilotSessionAction", () => {
  it("closes the co-pilot session AND resolves the issue together, revalidating /issues and /", async () => {
    const issueId = await raiseIssue({ severity: "warning", source: SOURCE_ID, title: "Needs human verification", message: "m" });
    closeCopilotSessionMock.mockResolvedValue(undefined);

    const result = await finishCopilotSessionAction("session-1", issueId);

    expect(result).toEqual({ ok: true, data: null });
    expect(closeCopilotSessionMock).toHaveBeenCalledWith("session-1");
    expect(listIssues({ open: true })).toHaveLength(0);
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("still closes the session even when resolveIssue() fails for an unknown id, and surfaces that specific error", async () => {
    closeCopilotSessionMock.mockResolvedValue(undefined);

    const result = await finishCopilotSessionAction("session-1", "nonexistent-id");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/no issue with id/);
    expect(closeCopilotSessionMock).toHaveBeenCalledWith("session-1");
  });
});
