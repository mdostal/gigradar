import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/store";
import { getConfigPath } from "@/lib/config/load";
import { saveConfig } from "@/lib/config/save";
import { raiseIssue } from "@/lib/notify/issues";
import { blankConfig, loadConfigPageData } from "../config-data";

// group-feature-hardening-and-coverage epic, config-data-test-coverage
// story: loadConfigPageData() decides whether the owner sees their real
// groups or the single-group blankConfig() placeholder -- the literal
// mechanism that would produce a "my groups disappeared" symptom if
// config.json ever failed ConfigSchema validation. Same isolated-tmpDir
// pattern as dashboard-data.test.ts -- never touches the real
// ~/.local/share/gigradar data dir.
let tmpDir: string;

function realGroupsConfig() {
  return {
    profile: { name: "Test User", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    groups: [
      { id: "g1", label: "Group One", needs: { engagementProfiles: [{ id: "p1", label: "Hourly", types: ["contract"], minRate: 150, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false } },
      { id: "g2", label: "Group Two", needs: { engagementProfiles: [{ id: "p2", label: "Salaried", types: ["full-time"], minRate: 250000, highRate: 250000, rateUnit: "year" }], freshStageOnly: false, remoteOnly: false } },
    ],
    sources: [],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-data-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  process.env.XDG_DATA_HOME = tmpDir;
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("blankConfig", () => {
  it("is the single-group first-run placeholder shape", () => {
    const cfg = blankConfig();
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.groups[0]?.id).toBe("default-search-1");
    expect(cfg.profile.name).toBe("");
  });
});

describe("loadConfigPageData", () => {
  it("returns the real parsed config (both real groups) when config.json is valid", async () => {
    saveConfig(realGroupsConfig());

    const data = await loadConfigPageData();

    expect(data.configExists).toBe(true);
    expect(data.parsedSuccessfully).toBe(true);
    expect(data.initial.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(data.subtitle).toBe("Editing your existing config.json.");
  });

  it("falls back to blankConfig() when config.json fails ConfigSchema validation, and says so in the subtitle", async () => {
    const dir = path.dirname(getConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    // Valid JSON, but violates the schema: groups requires at least one
    // entry (see Config.groups' own .min(1) doc comment in types.ts).
    fs.writeFileSync(getConfigPath(), JSON.stringify({ profile: { name: "X", roles: [], skills: [], timezone: "" }, groups: [], sources: [] }));

    const data = await loadConfigPageData();

    expect(data.configExists).toBe(true);
    expect(data.parsedSuccessfully).toBe(false);
    expect(data.initial.groups).toEqual(blankConfig().groups);
    expect(data.subtitle).toMatch(/failed validation/);
  });

  it("falls back to blankConfig() with a first-run subtitle when no config.json exists yet", async () => {
    const data = await loadConfigPageData();

    expect(data.configExists).toBe(false);
    expect(data.parsedSuccessfully).toBe(false);
    expect(data.initial.groups).toEqual(blankConfig().groups);
    expect(data.subtitle).toMatch(/No config\.json found yet/);
  });

  it("only includes source ids with a structured, OPEN issue context.sourceId match", async () => {
    saveConfig(realGroupsConfig());
    await raiseIssue({ severity: "error", source: "runRadar:src-a", title: "Failed", message: "boom", context: { sourceId: "src-a" } });
    const resolvedId = await raiseIssue({ severity: "error", source: "runRadar:src-b", title: "Failed", message: "boom", context: { sourceId: "src-b" } });
    // Resolve src-b's issue directly against the same DB the store module uses.
    const { getDb } = await import("@/lib/store/index");
    getDb().prepare("UPDATE issues SET resolved_at = :now WHERE id = :id").run({ now: new Date().toISOString(), id: resolvedId });
    await raiseIssue({ severity: "warning", source: "runRadar:no-source-id", title: "No source id", message: "n/a" });

    const data = await loadConfigPageData();

    expect(data.sourcesWithOpenIssues).toEqual(["src-a"]);
  });
});
