import { describe, expect, it } from "vitest";
import { issuesBadgeInfo } from "../issues-badge.js";

describe("issuesBadgeInfo", () => {
  it("returns null (no badge) when there are zero open issues", () => {
    expect(issuesBadgeInfo([])).toBeNull();
  });

  it("amber, with the count, when every open issue is a warning", () => {
    expect(issuesBadgeInfo([{ severity: "warning" }, { severity: "warning" }])).toEqual({ count: 2, color: "amber" });
  });

  it("red, with the TOTAL open count, when at least one open issue is an error", () => {
    expect(issuesBadgeInfo([{ severity: "warning" }, { severity: "error" }, { severity: "warning" }])).toEqual({
      count: 3,
      color: "red",
    });
  });

  it("red for a single open error with no warnings at all", () => {
    expect(issuesBadgeInfo([{ severity: "error" }])).toEqual({ count: 1, color: "red" });
  });
});
