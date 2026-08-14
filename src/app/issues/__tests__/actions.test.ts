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

import { revalidatePath } from "next/cache";
import { closeDb, getDb } from "@/lib/store/db";
import { listIssues, raiseIssue } from "@/lib/notify/issues";
import { resolveIssueAction } from "../actions";

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
