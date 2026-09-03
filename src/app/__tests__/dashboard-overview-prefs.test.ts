import { describe, expect, it } from "vitest";
import { ALL_TILE_IDS, deserializeVisibleTiles, serializeVisibleTiles } from "../dashboard-overview-prefs";

describe("serializeVisibleTiles / deserializeVisibleTiles", () => {
  it("round-trips a subset of tile ids unchanged", () => {
    const visible = ["readyToAct", "trackedTotal"] as const;

    const restored = deserializeVisibleTiles(serializeVisibleTiles(visible));

    expect(restored).toEqual(["readyToAct", "trackedTotal"]);
  });

  it("round-trips an empty selection (every tile hidden)", () => {
    expect(deserializeVisibleTiles(serializeVisibleTiles([]))).toEqual([]);
  });

  it("round-trips all tile ids", () => {
    expect(deserializeVisibleTiles(serializeVisibleTiles(ALL_TILE_IDS))).toEqual([...ALL_TILE_IDS]);
  });

  it("returns null (never throws) for malformed JSON", () => {
    expect(deserializeVisibleTiles("{not valid json")).toBeNull();
  });

  it("returns null for valid JSON that isn't an array", () => {
    expect(deserializeVisibleTiles(JSON.stringify({ readyToAct: true }))).toBeNull();
  });

  it("silently drops unknown tile ids (a stale value from a since-removed tile type) rather than failing", () => {
    expect(deserializeVisibleTiles(JSON.stringify(["readyToAct", "someRemovedTile", 42, null]))).toEqual(["readyToAct"]);
  });
});
