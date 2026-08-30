import { describe, expect, it } from "vitest";
import { deserializeDashboardPrefs, serializeDashboardPrefs } from "../dashboard-prefs";

describe("serializeDashboardPrefs / deserializeDashboardPrefs", () => {
  it("round-trips plain-value filters and sorting unchanged", () => {
    const prefs = {
      sorting: [{ id: "postedAt", desc: true }],
      columnFilters: [
        { id: "source", value: "gofractional" },
        { id: "tier", value: "green" },
      ],
    };

    const restored = deserializeDashboardPrefs(serializeDashboardPrefs(prefs));

    expect(restored).toEqual(prefs);
  });

  it("round-trips a Set-valued filter (the status column) as a real Set, not a plain object", () => {
    const prefs = { sorting: [], columnFilters: [{ id: "status", value: new Set(["new", "applied"]) }] };

    const restored = deserializeDashboardPrefs(serializeDashboardPrefs(prefs));

    expect(restored?.columnFilters[0]?.value).toBeInstanceOf(Set);
    expect(restored?.columnFilters[0]?.value).toEqual(new Set(["new", "applied"]));
  });

  it("returns null (never throws) for malformed JSON", () => {
    expect(deserializeDashboardPrefs("{not valid json")).toBeNull();
  });

  it("returns null for a value that parses but isn't the expected shape (e.g. a foreign/future localStorage value)", () => {
    expect(deserializeDashboardPrefs(JSON.stringify({ somethingElse: true }))).toBeNull();
    expect(deserializeDashboardPrefs(JSON.stringify({ sorting: "not-an-array", columnFilters: [] }))).toBeNull();
    expect(deserializeDashboardPrefs(JSON.stringify({ sorting: [], columnFilters: "not-an-array" }))).toBeNull();
  });

  it("returns null when a columnFilters entry is missing a string id", () => {
    expect(deserializeDashboardPrefs(JSON.stringify({ sorting: [], columnFilters: [{ value: "x" }] }))).toBeNull();
  });
});
