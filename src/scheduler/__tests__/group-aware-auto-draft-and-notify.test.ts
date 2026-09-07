// group-aware-auto-draft-and-notify story (group-scoped-automation-fixes
// epic): end-to-end proof that runAutoDraft()/runNotifyOnGreenMatch() now
// react to a real GREEN+in-band match on ANY of the owner's configured
// groups, not just the PRIMARY (first-in-scope) one -- mirrors
// auto-draft-tier-scoring.test.ts's own pattern (a REAL Config, a REAL
// runRadar() pass, matching functions never mocked) rather than
// hand-constructing MatchResult.matchedGroupTiers/matchedGroupBands
// literally, so this proves the real matchGroups()/runner.ts stamping
// AND the scheduler's new eligibility checks agree end to end.
//
// Before this story: runAutoDraft()/runNotifyOnGreenMatch() read the flat,
// primary-group-only MatchResult.tier/Gig.matchBand -- a gig that's a real
// green, in-band match for a NON-primary group (its primary group's own
// tier being red or yellow) never got auto-drafted and never notified,
// silently. See src/scheduler/index.ts's isGreenInBandForAnyGroup()/
// isGreenForAnyGroup() for the fix.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../lib/config/env-store.js";
import { registerSource } from "../../lib/sources/source.js";
import { closeDb, getDb, getDraft } from "../../lib/store/index.js";
import type { ApplicationDraft } from "../../lib/apply/runner.js";
import { runRadar } from "../../lib/apply/runner.js";
import type { ApplyProfileConfig, Config, EngagementProfile, Gig, MatchResult } from "../../lib/types.js";
import { runAutoDraft, runNotifyOnGreenMatch } from "../index.js";

let nextGigs: Gig[] = [];
registerSource({
  id: "multi-group-src",
  label: "Multi-group source (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

let tmpDir: string;
let keyTmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-multigroup-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-multigroup-test-key-"));
  vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  vi.stubEnv("XDG_DATA_HOME", tmpDir);
  vi.stubEnv("XDG_CONFIG_HOME", keyTmpDir);
  setEnvVar("ANTHROPIC_API_KEY", "test-key");
  db = getDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

const APPLY_PROFILE: ApplyProfileConfig = { email: "me@example.test" };
const PASSING_PROFILE: EngagementProfile = {
  id: "any-hourly",
  label: "Any (hourly)",
  types: ["contract", "fractional", "contract-to-hire"],
  minRate: 0,
  highRate: 999_999,
  maxHours: 999,
  maxHoursAtHighRate: 999,
  rateUnit: "hour",
};

function makeGig(externalId: string, title: string): Gig {
  return { sourceId: "multi-group-src", externalId, title, url: `https://example.test/${externalId}` };
}

/**
 * Two groups: "g1-primary" is FIRST in Config.groups (so it's the one
 * runner.ts anchors the flat Gig.tier/matchBand to) and its own roleArea
 * REJECTS this test's gig title (redKeywords match -> RED). "g2-drone" is
 * second (non-primary) and its own roleArea MATCHES the same title
 * (coreTitles match -> GREEN). Both share the same needs (an unpriced gig
 * auto-passes any hourly profile's rate check -- see match-band.ts's own
 * header comment), so g2's own band is "in-band".
 */
function multiGroupConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1-primary",
        label: "Primary Group (Fractional Work)",
        needs: { engagementProfiles: [PASSING_PROFILE], freshStageOnly: false, remoteOnly: false },
        roleArea: { coreTitles: [], keywords: [], redKeywords: ["Drone Pilot"] },
      },
      {
        id: "g2-drone",
        label: "Drone Services (non-primary)",
        needs: { engagementProfiles: [PASSING_PROFILE], freshStageOnly: false, remoteOnly: false },
        roleArea: { coreTitles: ["Drone Pilot"], keywords: [], redKeywords: [] },
      },
    ],
    sources: [{ id: "multi-group-src", enabled: true }],
    schedule: "*/1 * * * * *",
    autoDraftOnScan: true,
    notifyOnGreenMatch: true,
    applyProfile: APPLY_PROFILE,
  };
}

function fakeStageApplicationFn() {
  return vi.fn(async (r: MatchResult): Promise<ApplicationDraft> => ({
    gig: r.gig,
    content: { coverText: "Dear team...", answers: {} },
    status: "draft",
  }));
}

describe("runAutoDraft/runNotifyOnGreenMatch consider ANY in-scope group, not just the primary one (group-aware-auto-draft-and-notify story)", () => {
  it("auto-drafts a gig that's green+in-band for a NON-primary group even though its primary group's own tier is red", async () => {
    nextGigs = [makeGig("1", "Drone Pilot for a Delivery Startup")];
    const config = multiGroupConfig();

    const { passed } = await runRadar(config, { db });

    // Sanity: the real pipeline actually produced the scenario this story
    // exists to fix -- primary group RED, non-primary group GREEN+in-band.
    expect(passed[0]?.tier).toBe("red"); // flat/primary-group tier
    expect(passed[0]?.gig.matchedGroupTiers?.["g1-primary"]).toBe("red");
    expect(passed[0]?.gig.matchedGroupTiers?.["g2-drone"]).toBe("green");
    expect(passed[0]?.gig.matchedGroupBands?.["g2-drone"]).toBe("in-band");

    const stageApplicationFn = fakeStageApplicationFn();
    await runAutoDraft(config, passed, stageApplicationFn, (key) => getDraft(key, { db }));

    expect(stageApplicationFn).toHaveBeenCalledTimes(1);
    expect(stageApplicationFn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ tier: "red" }));
  });

  it("fires a notify-on-green-match notification for the same non-primary-group-only match", async () => {
    nextGigs = [makeGig("2", "Drone Pilot for a Delivery Startup")];
    const config = multiGroupConfig();

    const { passed, newlyInsertedKeys } = await runRadar(config, { db });
    expect(passed[0]?.tier).toBe("red"); // sanity, same as above

    const notifyFn = vi.fn(async (_n: { title: string; body: string }) => undefined);
    await runNotifyOnGreenMatch(config, passed, newlyInsertedKeys, notifyFn);

    expect(notifyFn).toHaveBeenCalledTimes(1);
    const [notification] = notifyFn.mock.calls[0] as [{ title: string; body: string }];
    expect(notification.body).toContain("Drone Pilot for a Delivery Startup");
  });

  it("does NOT auto-draft or notify a gig that is green+in-band for NO group at all (primary or otherwise) -- no regression on the reject path", async () => {
    // Matches neither group's roleArea at all -- both groups fall back to
    // the tiering.ts default (YELLOW), never green.
    nextGigs = [makeGig("3", "Generic Widget Assembler")];
    const config = multiGroupConfig();

    const { passed, newlyInsertedKeys } = await runRadar(config, { db });
    expect(passed[0]?.gig.matchedGroupTiers?.["g1-primary"]).not.toBe("green");
    expect(passed[0]?.gig.matchedGroupTiers?.["g2-drone"]).not.toBe("green");

    const stageApplicationFn = fakeStageApplicationFn();
    await runAutoDraft(config, passed, stageApplicationFn, (key) => getDraft(key, { db }));
    expect(stageApplicationFn).not.toHaveBeenCalled();

    const notifyFn = vi.fn(async (_n: { title: string; body: string }) => undefined);
    await runNotifyOnGreenMatch(config, passed, newlyInsertedKeys, notifyFn);
    expect(notifyFn).not.toHaveBeenCalled();
  });
});
