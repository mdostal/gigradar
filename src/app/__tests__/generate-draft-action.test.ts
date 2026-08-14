// Tests for generateDraftAction (../actions.ts) — the "Generate draft"
// dashboard button's Server Action (`draft-review-ui` story,
// `assisted-apply-drafting` epic). Real store (GIGRADAR_DB_PATH-pointed temp
// DB, same as ../__tests__/actions.test.ts), real env-store/config.json
// read/write against isolated temp XDG dirs (same pattern as
// config/__tests__/resume-link-actions.test.ts) — only the actual
// Anthropic-calling `generateDraft()` (src/lib/apply/draft.ts) is mocked, so
// this suite genuinely exercises the real `stageApplication()` guardrails
// (AC5/AC6/AC7) rather than re-mocking them away.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockGenerateDraft = vi.fn();
vi.mock("@/lib/apply/draft", () => ({ generateDraft: (...args: unknown[]) => mockGenerateDraft(...args) }));

import { revalidatePath } from "next/cache";
import { closeDb, getDraft, recordScan } from "@/lib/store";
import { setEnvVar } from "@/lib/config/env-store";
import { saveConfig, type ConfigEdits } from "@/lib/config/save";
import type { DraftContent } from "@/lib/types";
import { generateDraftAction } from "../actions";

let dbTmpDir: string;
let dataTmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

const REAL_APPLY_PROFILE = { email: "jane@example.com" };

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
  dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-draft-action-db-"));
  dataTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-draft-action-data-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-generate-draft-action-key-"));
  process.env.GIGRADAR_DB_PATH = path.join(dbTmpDir, "gigs.db");
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = dataTmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  mockGenerateDraft.mockReset();
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

describe("generateDraftAction: missing API key", () => {
  it("returns a specific error naming the Anthropic API key, never calls stageApplication/generateDraft", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    const saved = saveConfig(baseConfigEdits(REAL_APPLY_PROFILE));
    expect(saved.ok).toBe(true);

    const result = await generateDraftAction("src-a:1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Anthropic API key");
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });
});

describe("generateDraftAction: unknown gig key", () => {
  it("returns {ok:false} for a key with no stored gig", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    const result = await generateDraftAction("does-not:exist");
    expect(result.ok).toBe(false);
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });
});

describe("generateDraftAction: red-tier guardrail surfaces stageApplication()'s real error (AC5)", () => {
  it("returns stageApplication()'s specific red-tier error, not a generic failure, and never calls generateDraft", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "red" });
    saveConfig(baseConfigEdits(REAL_APPLY_PROFILE));
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");

    const result = await generateDraftAction("src-a:1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/tier is "red"/);
    expect(mockGenerateDraft).not.toHaveBeenCalled();
    expect(getDraft("src-a:1")).toBeUndefined();
  });
});

describe("generateDraftAction: missing applyProfile surfaces stageApplication()'s specific, actionable error (AC7)", () => {
  it("returns the real /config-pointing error, not a generic Server Action failure, and never calls generateDraft", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits(undefined)); // no applyProfile
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");

    const result = await generateDraftAction("src-a:1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("/config");
    expect(result.error).toContain("apply profile");
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });
});

describe("generateDraftAction: successful generation for a green/yellow-tier gig (AC6)", () => {
  it.each(["green", "yellow"] as const)(
    "tier=%s: calls stageApplication(), persists the draft, and revalidates /drafts",
    async (tier) => {
      seedGig({ sourceId: "src-a", externalId: "1", tier });
      saveConfig(baseConfigEdits(REAL_APPLY_PROFILE));
      setEnvVar("ANTHROPIC_API_KEY", "fake-key");
      const content: DraftContent = { coverText: "Dear Acme team...", answers: {} };
      mockGenerateDraft.mockResolvedValueOnce(content);

      const result = await generateDraftAction("src-a:1");

      expect(result).toEqual({ ok: true, data: { gigKey: "src-a:1" } });
      expect(getDraft("src-a:1")?.content).toEqual(content);
      expect(getDraft("src-a:1")?.status).toBe("draft");
      expect(revalidatePath).toHaveBeenCalledWith("/drafts");
    },
  );

  it("resolves the API key fresh via readEnvVar(), not process.env", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    saveConfig(baseConfigEdits(REAL_APPLY_PROFILE));
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "process-env-value-should-be-ignored";
    try {
      const result = await generateDraftAction("src-a:1");
      expect(result.ok).toBe(false); // no .env-backed key was ever set via setEnvVar()
      expect(mockGenerateDraft).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
