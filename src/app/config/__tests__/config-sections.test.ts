import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS } from "../config-sections";
import type { ConfigPageData } from "../config-data";
import type { EngagementProfile, GroupConfig } from "@/lib/types";

// group-feature-hardening-and-coverage epic, config-sections-test-coverage
// story: config-sections.ts computes every Config Dashboard card's content
// and had zero test coverage despite already shipping one real bug this
// session (duplicate React keys when two groups share a label, caught only
// by a manual grill pass, not by any test). No React Testing Library in
// this repo -- test the exported details()/status() functions directly
// against hand-built ConfigPageData fixtures, same convention as
// describe-cron.test.ts and nav-header.test.ts.

function profile(overrides: Partial<EngagementProfile> = {}): EngagementProfile {
  return {
    id: "p1",
    label: "Hourly",
    types: ["contract"],
    minRate: 150,
    highRate: 150,
    rateUnit: "hour",
    maxHours: 20,
    maxHoursAtHighRate: 40,
    ...overrides,
  };
}

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    id: "g1",
    label: "Group 1",
    needs: { engagementProfiles: [profile()], freshStageOnly: false, remoteOnly: false },
    ...overrides,
  };
}

function baseData(overrides: Partial<ConfigPageData> = {}): ConfigPageData {
  return {
    initial: {
      profile: { name: "Test User", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [group()],
      sources: [],
      ...(overrides.initial ?? {}),
    },
    configExists: true,
    parsedSuccessfully: true,
    portunusAvailable: false,
    sessionReadiness: {},
    sourcesWithOpenIssues: [],
    subtitle: "Editing your existing config.json.",
    ...overrides,
  };
}

function section(id: string) {
  const found = CONFIG_SECTIONS.find((s) => s.id === id);
  if (!found) throw new Error(`no such section: ${id}`);
  return found;
}

describe("profile section", () => {
  it("falls back to 'Not filled in yet' when name is empty", () => {
    const data = baseData({ initial: { ...baseData().initial, profile: { name: "", roles: [], skills: [], timezone: "" } } });
    expect(section("profile").details(data)).toEqual([{ label: "Name", value: "Not filled in yet" }]);
  });

  it("includes rate anchor/home base/timezone rows only when each is actually present", () => {
    const withNothingExtra = baseData({
      initial: { ...baseData().initial, profile: { name: "Test User", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "" } },
    });
    const rows = section("profile").details(withNothingExtra);
    expect(rows.map((r) => r.label)).toEqual(["Name", "Roles"]);

    const withExtras = baseData({
      initial: {
        ...withNothingExtra.initial,
        profile: { ...withNothingExtra.initial.profile, timezone: "America/Chicago", homeBase: { city: "Chicago", lat: 0, lng: 0 } },
        applyProfile: { email: "a@b.com", rateAnchor: 275 },
      },
    });
    const richRows = section("profile").details(withExtras);
    expect(richRows).toContainEqual({ label: "Rate anchor", value: "$275/hr" });
    expect(richRows).toContainEqual({ label: "Home base", value: "Chicago" });
    expect(richRows).toContainEqual({ label: "Timezone", value: "America/Chicago" });
  });

  it("shows at most the first two roles", () => {
    const data = baseData({
      initial: { ...baseData().initial, profile: { name: "Test", roles: ["A", "B", "C"], skills: [], timezone: "" } },
    });
    const rolesRow = section("profile").details(data).find((r) => r.label === "Roles");
    expect(rolesRow?.value).toBe("A, B");
  });
});

describe("sources section", () => {
  it("counts healthy (connected + no-login-needed) vs needs-login, omitting the needs-login row when it's 0", () => {
    const data = baseData({
      initial: {
        ...baseData().initial,
        sources: [
          { id: "s1", enabled: true },
          { id: "s2", enabled: true },
        ],
      },
      sessionReadiness: { s1: "connected", s2: "no-login-needed" },
    });
    const rows = section("sources").details(data);
    expect(rows).toEqual([
      { label: "Configured", value: "2" },
      { label: "Healthy", value: "2" },
    ]);
  });

  it("shows a Needs login row when at least one source needs it", () => {
    const data = baseData({
      initial: { ...baseData().initial, sources: [{ id: "s1", enabled: true }] },
      sessionReadiness: { s1: "needs-login" },
    });
    const rows = section("sources").details(data);
    expect(rows).toEqual([
      { label: "Configured", value: "1" },
      { label: "Healthy", value: "0" },
      { label: "Needs login", value: "1" },
    ]);
  });

  it("omits Healthy/Needs login rows entirely when there's no sessionReadiness data yet", () => {
    const data = baseData({ initial: { ...baseData().initial, sources: [] } });
    expect(section("sources").details(data)).toEqual([{ label: "Configured", value: "0" }]);
  });
});

describe("groups section", () => {
  it("renders one row per group even when two groups share the same label", () => {
    const data = baseData({
      initial: {
        ...baseData().initial,
        groups: [
          group({ id: "g1", label: "Same Label", aiVerify: true }),
          group({ id: "g2", label: "Same Label", aiVerify: false, needs: { engagementProfiles: [profile({ minRate: 90, highRate: 200 })], freshStageOnly: false, remoteOnly: false } }),
        ],
      },
    });
    const rows = section("groups").details(data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ label: "Same Label", value: "$150+/hr · AI-verify on" });
    expect(rows[1]).toEqual({ label: "Same Label", value: "$90-200/hr · AI-verify off" });
  });

  it("formats an hourly profile as $X+/hr or $X-Y/hr", () => {
    const flat = baseData({ initial: { ...baseData().initial, groups: [group({ needs: { engagementProfiles: [profile({ minRate: 150, highRate: 150 })], freshStageOnly: false, remoteOnly: false } })] } });
    expect(section("groups").details(flat)[0]?.value).toBe("$150+/hr · AI-verify off");

    const ranged = baseData({ initial: { ...baseData().initial, groups: [group({ needs: { engagementProfiles: [profile({ minRate: 90, highRate: 200 })], freshStageOnly: false, remoteOnly: false } })] } });
    expect(ranged ? section("groups").details(ranged)[0]?.value : undefined).toBe("$90-200/hr · AI-verify off");
  });

  it("formats a salaried profile as $Xk+ TC or $Xk-Yk TC", () => {
    const flat = baseData({
      initial: {
        ...baseData().initial,
        groups: [group({ needs: { engagementProfiles: [profile({ rateUnit: "year", minRate: 250000, highRate: 250000, maxHours: undefined, maxHoursAtHighRate: undefined })], freshStageOnly: false, remoteOnly: false } })],
      },
    });
    expect(section("groups").details(flat)[0]?.value).toBe("$250k+ TC · AI-verify off");

    const ranged = baseData({
      initial: {
        ...baseData().initial,
        groups: [group({ needs: { engagementProfiles: [profile({ rateUnit: "year", minRate: 250000, highRate: 400000, maxHours: undefined, maxHoursAtHighRate: undefined })], freshStageOnly: false, remoteOnly: false } })],
      },
    });
    expect(section("groups").details(ranged)[0]?.value).toBe("$250k-$400k TC · AI-verify off");
  });

  it("joins multiple profiles on one group with ' / '", () => {
    const data = baseData({
      initial: {
        ...baseData().initial,
        groups: [
          group({
            needs: {
              engagementProfiles: [profile({ minRate: 150, highRate: 150 }), profile({ id: "p2", rateUnit: "year", minRate: 250000, highRate: 250000, maxHours: undefined, maxHoursAtHighRate: undefined })],
              freshStageOnly: false,
              remoteOnly: false,
            },
          }),
        ],
      },
    });
    expect(section("groups").details(data)[0]?.value).toBe("$150+/hr / $250k+ TC · AI-verify off");
  });

  it("falls back to a 'no rate profile configured' message and 'None configured' when there are zero groups/profiles", () => {
    const noProfiles = baseData({ initial: { ...baseData().initial, groups: [group({ needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false } })] } });
    expect(section("groups").details(noProfiles)[0]?.value).toBe("no rate profile configured · AI-verify off");

    const noGroups = baseData({ initial: { ...baseData().initial, groups: [] } });
    expect(section("groups").details(noGroups)).toEqual([{ label: "Groups", value: "None configured" }]);
  });
});

describe("schedule section", () => {
  it("prefers describeCron()'s human string when the cron shape is describable", () => {
    const data = baseData({ initial: { ...baseData().initial, schedule: "0 9 * * 1-5" } });
    expect(section("schedule").details(data)).toEqual([{ label: "Runs", value: "Runs at 09:00, weekdays" }]);
  });

  it("falls back to the raw cron string when describeCron() returns null", () => {
    const data = baseData({ initial: { ...baseData().initial, schedule: "15 9 1 * *" } });
    expect(section("schedule").details(data)).toEqual([{ label: "Cron", value: "15 9 1 * *" }]);
  });

  it("shows a neutral on-demand-only message when no schedule is set", () => {
    const data = baseData({ initial: { ...baseData().initial, schedule: undefined } });
    expect(section("schedule").details(data)).toEqual([{ label: "Schedule", value: "Not set — runs on-demand only" }]);
    expect(section("schedule").status(data)).toBe("neutral");
  });
});

describe("automation section", () => {
  it("reports kill-switch state and 'N of M armed'", () => {
    const data = baseData({
      initial: {
        ...baseData().initial,
        autoFire: { killSwitch: false, rules: [{ sourceId: "s1", tier: "green", enabled: true, minApprovals: 3, dailyCap: 5 }, { sourceId: "s2", tier: "green", enabled: false, minApprovals: 3, dailyCap: 5 }] },
      },
    });
    expect(section("automation").details(data)).toEqual([
      { label: "Kill switch", value: "Off" },
      { label: "Rules", value: "1 of 2 armed" },
    ]);
  });

  it("reports the kill switch engaged message when true", () => {
    const data = baseData({ initial: { ...baseData().initial, autoFire: { killSwitch: true, rules: [] } } });
    expect(section("automation").details(data)[0]).toEqual({ label: "Kill switch", value: "Engaged — nothing can fire" });
  });

  it("status() is 'danger' only when a rule is enabled AND the kill switch is off", () => {
    const armedAndLive = baseData({ initial: { ...baseData().initial, autoFire: { killSwitch: false, rules: [{ sourceId: "s1", tier: "green", enabled: true, minApprovals: 3, dailyCap: 5 }] } } });
    expect(section("automation").status(armedAndLive)).toBe("danger");

    const armedButKilled = baseData({ initial: { ...baseData().initial, autoFire: { killSwitch: true, rules: [{ sourceId: "s1", tier: "green", enabled: true, minApprovals: 3, dailyCap: 5 }] } } });
    expect(section("automation").status(armedButKilled)).toBe("neutral");

    const noRulesAtAll = baseData({ initial: { ...baseData().initial, autoFire: undefined } });
    expect(section("automation").status(noRulesAtAll)).toBe("neutral");
  });
});
