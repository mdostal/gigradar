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

// dashboard-redesign story: updateGigStatusAction() now ALSO best-effort
// reads Config (readRawConfig() -> getConfigPath() -> XDG_DATA_HOME, a
// SEPARATE resolution path from the DB's own GIGRADAR_DB_PATH override
// below) when marking a gig "applied" -- mock both LLM-call surfaces it
// can reach through that path so a test run never makes a real network
// call, and so the autoPrepOnApply branch is independently controllable.
vi.mock("@/lib/config/env-store", () => ({ resolveLlmCredential: vi.fn() }));
vi.mock("@/lib/apply/prep", () => ({ generatePrepPacket: vi.fn() }));

import { revalidatePath } from "next/cache";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { generatePrepPacket } from "@/lib/apply/prep";
import { closeDb, getInterviewPrep, getGig, recordScan } from "@/lib/store";
import { saveConfig } from "@/lib/config/save";
import { updateGigStatusAction } from "../actions";

// A fresh temp-file DB per test, pointed at via GIGRADAR_DB_PATH — the same
// env var src/lib/store/db.ts's getDb() resolves by default, since the
// action under test calls setStatus() with no explicit `db` option (exactly
// how the real Server Action call site works). XDG_DATA_HOME is set
// alongside it (a SEPARATE resolution path — see the mock comment above)
// so the new autoPrepOnApply config read can never fall through to this
// machine's real config.json.
let tmpDir: string;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    profile: { name: "Test", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            { id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" },
          ],
          freshStageOnly: false,
          remoteOnly: true,
        },
      },
    ],
    sources: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-actions-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  process.env.XDG_DATA_HOME = tmpDir;
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(resolveLlmCredential).mockReset();
  vi.mocked(generatePrepPacket).mockReset();
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  delete process.env.XDG_DATA_HOME;
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

  describe("autoPrepOnApply (dashboard-redesign story)", () => {
    it("auto-generates and persists a prep packet when marking a gig Applied, autoPrepOnApply is on, and none exists yet", async () => {
      saveConfig(baseConfig({ autoPrepOnApply: true }));
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);
      vi.mocked(resolveLlmCredential).mockReturnValue({ apiKey: "test-key" } as never);
      const content = { score: 90, rationale: "r", topStrengths: [], keyGaps: [], recommendation: "go", predictedQuestions: [], starlaStories: [], atsScore: { keywordOverlapScore: 0, matchedKeywords: [], missingKeywords: [], resumeTweaks: [], resumeChecked: false, parseabilityIssues: [] } };
      vi.mocked(generatePrepPacket).mockResolvedValue(content);

      const result = await updateGigStatusAction("src-a:1", "applied");

      expect(result).toEqual({ ok: true, data: { key: "src-a:1", status: "applied" } });
      expect(generatePrepPacket).toHaveBeenCalledTimes(1);
      expect(getInterviewPrep("src-a:1")?.content).toEqual(content);
    });

    it("does not attempt prep generation when autoPrepOnApply is off (the default)", async () => {
      saveConfig(baseConfig());
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);

      const result = await updateGigStatusAction("src-a:1", "applied");

      expect(result.ok).toBe(true);
      expect(generatePrepPacket).not.toHaveBeenCalled();
      expect(getInterviewPrep("src-a:1")).toBeUndefined();
    });

    it("does not attempt prep generation for a status other than applied", async () => {
      saveConfig(baseConfig({ autoPrepOnApply: true }));
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);

      const result = await updateGigStatusAction("src-a:1", "interview");

      expect(result.ok).toBe(true);
      expect(generatePrepPacket).not.toHaveBeenCalled();
    });

    it("skips generation (never overwrites) when a prep packet already exists for this gig", async () => {
      saveConfig(baseConfig({ autoPrepOnApply: true }));
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);
      const { saveInterviewPrep } = await import("@/lib/store");
      const existing = { score: 50, rationale: "existing", topStrengths: [], keyGaps: [], recommendation: "existing", predictedQuestions: [], starlaStories: [], atsScore: { keywordOverlapScore: 0, matchedKeywords: [], missingKeywords: [], resumeTweaks: [], resumeChecked: false, parseabilityIssues: [] } };
      saveInterviewPrep("src-a:1", existing);

      const result = await updateGigStatusAction("src-a:1", "applied");

      expect(result.ok).toBe(true);
      expect(generatePrepPacket).not.toHaveBeenCalled();
      expect(getInterviewPrep("src-a:1")?.content).toEqual(existing);
    });

    it("still succeeds the status change when prep generation fails (missing credential, best-effort swallow)", async () => {
      saveConfig(baseConfig({ autoPrepOnApply: true }));
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);
      vi.mocked(resolveLlmCredential).mockReturnValue(undefined);

      const result = await updateGigStatusAction("src-a:1", "applied");

      expect(result).toEqual({ ok: true, data: { key: "src-a:1", status: "applied" } });
      expect(generatePrepPacket).not.toHaveBeenCalled();
      expect(getInterviewPrep("src-a:1")).toBeUndefined();
    });

    it("still succeeds the status change when generatePrepPacket() itself throws (best-effort swallow)", async () => {
      saveConfig(baseConfig({ autoPrepOnApply: true }));
      recordScan([
        { sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] },
      ]);
      vi.mocked(resolveLlmCredential).mockReturnValue({ apiKey: "test-key" } as never);
      vi.mocked(generatePrepPacket).mockRejectedValue(new Error("LLM call failed"));

      const result = await updateGigStatusAction("src-a:1", "applied");

      expect(result).toEqual({ ok: true, data: { key: "src-a:1", status: "applied" } });
      expect(getInterviewPrep("src-a:1")).toBeUndefined();
    });
  });
});
