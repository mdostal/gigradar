// Tests for generatePrepPacketAction (../actions.ts) — the "Generate prep
// packet" dashboard button's Server Action (career-crm epic,
// prep-packet-ui story). Mirrors generate-draft-action.test.ts's exact
// isolation shape: real store (GIGRADAR_DB_PATH-pointed temp DB), real
// env-store/config.json read/write against isolated temp XDG dirs — only
// generatePrepPacket() itself (src/lib/apply/prep.ts) is mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockGeneratePrepPacket = vi.fn();
vi.mock("@/lib/apply/prep", () => ({ generatePrepPacket: (...args: unknown[]) => mockGeneratePrepPacket(...args) }));

import { revalidatePath } from "next/cache";
import { closeDb, getInterviewPrep, recordScan } from "@/lib/store";
import { setEnvVar } from "@/lib/config/env-store";
import { saveConfig, type ConfigEdits } from "@/lib/config/save";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { generatePrepPacketAction } from "../actions";

let dbTmpDir: string;
let dataTmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

function baseConfigEdits(applyProfile?: Record<string, unknown>): ConfigEdits {
  return {
    profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    needs: {
      engagementProfiles: [
        {
          id: "any-hourly",
          label: "Any (hourly)",
          types: ["contract", "fractional", "contract-to-hire"],
          minRate: 0,
          highRate: 999_999,
          maxHours: 999,
          maxHoursAtHighRate: 999,
          rateUnit: "hour",
        },
      ],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [{ id: "braintrust", enabled: true }],
    applyProfile,
  };
}

beforeEach(() => {
  dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-prep-action-db-"));
  dataTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-prep-action-data-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-prep-action-key-"));
  process.env.GIGRADAR_DB_PATH = path.join(dbTmpDir, "gigs.db");
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = dataTmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  mockGeneratePrepPacket.mockReset();
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(dbTmpDir, { recursive: true, force: true });
  fs.rmSync(dataTmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

function seedGig(overrides: { sourceId: string; externalId: string; tier?: "green" | "yellow" | "red" }): void {
  recordScan([
    {
      sourceId: overrides.sourceId,
      gigs: [
        {
          sourceId: overrides.sourceId,
          externalId: overrides.externalId,
          title: "Fractional CTO",
          company: "Acme",
          url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
          tier: overrides.tier,
        },
      ],
    },
  ]);
}

const PACKET: PrepPacketContent = {
  score: 82,
  rationale: "Strong overlap.",
  topStrengths: ["Backend leadership"],
  keyGaps: ["No Kubernetes listed"],
  recommendation: "Pursue.",
  predictedQuestions: ["How have you scaled a team?"],
  starlaStories: ["S: ... T: ... A: ... R: ... L: ... A: ..."],
  atsScore: { keywordOverlapScore: 70, matchedKeywords: ["Backend"], missingKeywords: ["Kubernetes"], resumeTweaks: ["Add 'Kubernetes' to your skills."], parseabilityIssues: [], resumeChecked: false },
};

describe("generatePrepPacketAction: missing API key", () => {
  it("returns a specific error naming the Anthropic API key, never calls generatePrepPacket", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveConfig(baseConfigEdits());

    const result = await generatePrepPacketAction("src-a:1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Anthropic API key");
    expect(mockGeneratePrepPacket).not.toHaveBeenCalled();
  });
});

describe("generatePrepPacketAction: unknown gig key", () => {
  it("returns {ok:false} for a key with no stored gig", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    const result = await generatePrepPacketAction("does-not:exist");
    expect(result.ok).toBe(false);
    expect(mockGeneratePrepPacket).not.toHaveBeenCalled();
  });
});

describe("generatePrepPacketAction: no tier restriction (unlike generateDraftAction)", () => {
  it("succeeds for a red-tier gig -- a prep packet is read-only analysis, not a real application artifact", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "red" });
    saveConfig(baseConfigEdits());
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    mockGeneratePrepPacket.mockResolvedValueOnce(PACKET);

    const result = await generatePrepPacketAction("src-a:1");

    expect(result).toEqual({ ok: true, data: PACKET });
  });
});

describe("generatePrepPacketAction: works without an applyProfile configured (unlike generateDraftAction)", () => {
  it("succeeds with applyProfile undefined -- fit/gap analysis is still meaningful from Profile alone", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits(undefined));
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    mockGeneratePrepPacket.mockResolvedValueOnce(PACKET);

    const result = await generatePrepPacketAction("src-a:1");

    expect(result).toEqual({ ok: true, data: PACKET });
    expect(mockGeneratePrepPacket).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined, "fake-key");
  });
});

describe("generatePrepPacketAction: successful generation", () => {
  it("calls generatePrepPacket(), persists via saveInterviewPrep(), and revalidates /", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits({ email: "jane@example.com" }));
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    mockGeneratePrepPacket.mockResolvedValueOnce(PACKET);

    const result = await generatePrepPacketAction("src-a:1");

    expect(result).toEqual({ ok: true, data: PACKET });
    expect(getInterviewPrep("src-a:1")?.content).toEqual(PACKET);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("regenerating REPLACES the persisted content, not appends", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits({ email: "jane@example.com" }));
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    mockGeneratePrepPacket.mockResolvedValueOnce(PACKET);
    await generatePrepPacketAction("src-a:1");

    const regenerated: PrepPacketContent = { ...PACKET, score: 91 };
    mockGeneratePrepPacket.mockResolvedValueOnce(regenerated);
    await generatePrepPacketAction("src-a:1");

    expect(getInterviewPrep("src-a:1")?.content).toEqual(regenerated);
  });

  it("resolves the API key fresh via readEnvVar(), not process.env", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits({ email: "jane@example.com" }));
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "process-env-value-should-be-ignored";
    try {
      const result = await generatePrepPacketAction("src-a:1");
      expect(result.ok).toBe(false); // no .env-backed key was ever set via setEnvVar()
      expect(mockGeneratePrepPacket).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
