import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reasoning as src/app/config/__tests__/actions.test.ts: revalidatePath()
// asserts a real Next.js request context that doesn't exist under vitest.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// raiseIssue()'s desktop notification is mocked so seeding an issue never
// actually shells out to osascript/notify-send.
vi.mock("@/lib/notify/desktop", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

// retrySourceAction() genuinely calls loadConfig()/runRadar() (see its own
// doc comment -- "resolving is the exception" case) -- mocked here the same
// way agent-chat-loop.test.ts mocks runRadar for its own run_scan tool test.
const runRadarMock = vi.fn();
vi.mock("@/lib/apply/runner", () => ({ runRadar: (...args: unknown[]) => runRadarMock(...args) }));
const loadConfigMock = vi.fn();
vi.mock("@/lib/config/load", () => ({ loadConfig: () => loadConfigMock() }));
vi.mock("@/lib/config/env-store", () => ({ resolveLlmCredential: () => undefined }));

import { revalidatePath } from "next/cache";
import { closeDb, getDb } from "@/lib/store/db";
import { listIssues, raiseIssue } from "@/lib/notify/issues";
import { resolveIssueAction, retrySourceAction } from "../actions";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-issues-action-test-"));
  // resolveIssueAction() -> resolveIssue() calls getDb() with NO explicit
  // path override, so GIGRADAR_DB_PATH is what makes it (and raiseIssue()
  // below) resolve to THIS test's temp file instead of the real default --
  // same reasoning as src/scheduler/__tests__/auto-fire.test.ts's own setup.
  vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  getDb();
  vi.mocked(revalidatePath).mockClear();
  runRadarMock.mockReset();
  loadConfigMock.mockReset();
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveIssueAction", () => {
  it("resolves a real open issue and revalidates both /issues and / (nav badge)", async () => {
    const id = await raiseIssue({ severity: "warning", source: "a", title: "X", message: "m" });

    const result = await resolveIssueAction(id);

    expect(result).toEqual({ ok: true, data: null });
    expect(listIssues({ open: true })).toHaveLength(0);
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns {ok:false} for a nonexistent id, without calling revalidatePath", async () => {
    const result = await resolveIssueAction("nonexistent-id");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/no issue with id/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

function stubbedConfig() {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
    sources: [{ id: "braintrust", enabled: true }],
  };
}

describe("retrySourceAction", () => {
  it("re-runs just this source, resolves its open issue on success, and revalidates both routes", async () => {
    loadConfigMock.mockReturnValue(stubbedConfig());
    runRadarMock.mockResolvedValue({ results: [{}, {}], passed: [], errors: [], newlyInsertedKeys: [] });
    await raiseIssue(
      { severity: "warning", source: "runRadar:braintrust", title: "Source fetch failed", message: "timeout", context: { sourceId: "braintrust" } },
    );

    const result = await retrySourceAction("braintrust");

    expect(result).toEqual({ ok: true, data: { ok: true, foundCount: 2 } });
    expect(listIssues({ open: true })).toHaveLength(0);
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    // Only the ONE targeted source was passed through, regardless of what else config.sources holds.
    expect(runRadarMock).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [{ id: "braintrust", enabled: true }] }),
      {},
      expect.anything(),
    );
  });

  it("returns {ok:false} with the real failure message and leaves the issue open when the retry itself still fails", async () => {
    loadConfigMock.mockReturnValue(stubbedConfig());
    runRadarMock.mockResolvedValue({ results: [], passed: [], errors: [{ sourceId: "braintrust", message: "still down" }], newlyInsertedKeys: [] });
    await raiseIssue(
      { severity: "warning", source: "runRadar:braintrust", title: "Source fetch failed", message: "timeout", context: { sourceId: "braintrust" } },
    );

    const result = await retrySourceAction("braintrust");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("still down");
    expect(listIssues({ open: true })).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns {ok:false} for a source id not present in config, without ever calling runRadar", async () => {
    loadConfigMock.mockReturnValue(stubbedConfig());

    const result = await retrySourceAction("never-configured");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/no source configured/);
    expect(runRadarMock).not.toHaveBeenCalled();
  });
});
