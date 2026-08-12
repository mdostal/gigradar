import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/cache's revalidatePath() asserts it's running inside a real Next.js
// request context (it isn't, under vitest) — mock the whole module so this
// test exercises this file's own logic (the {ok,error} convention, and that
// revalidatePath is actually called on success / not called on failure)
// without needing a real Next server. See src/app/actions.ts's file comment
// for why the call itself is load-bearing (verified for real separately,
// against `next build && next start` — see this story's report).
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { closeDb, getGig, recordScan } from "@/lib/store";
import { updateGigStatusAction } from "../actions";

// A fresh temp-file DB per test, pointed at via GIGRADAR_DB_PATH — the same
// env var src/lib/store/db.ts's getDb() resolves by default, since the
// action under test calls setStatus() with no explicit `db` option (exactly
// how the real Server Action call site works).
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-actions-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("updateGigStatusAction", () => {
  it("updates the gig's status, returns {ok:true,data}, and calls revalidatePath('/')", async () => {
    recordScan([
      { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
    ]);

    const result = await updateGigStatusAction("src-a:1", "applied");

    expect(result).toEqual({ ok: true, data: { key: "src-a:1", status: "applied" } });
    expect(getGig("src-a:1")?.status).toBe("applied");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns {ok:false,error} for an unknown key instead of throwing, and never calls revalidatePath", async () => {
    const result = await updateGigStatusAction("does-not:exist", "applied");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does-not:exist");
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
