import { describe, expect, it } from "vitest";
import { extractGroupSummaries } from "../layout";

// layout.tsx is a Server Component -- extractGroupSummaries() is the one
// pure, exported piece of it worth unit-testing directly (this repo has
// no React Testing Library dependency, see nav-header.test.ts's own
// convention: assert on extracted pure data, not rendered DOM).
describe("extractGroupSummaries (multi-group-architecture epic, Slice 3)", () => {
  it("extracts {id, label} for every configured group", () => {
    const raw = { groups: [{ id: "a", label: "Group A" }, { id: "b", label: "Group B" }] };
    expect(extractGroupSummaries(raw)).toEqual([{ id: "a", label: "Group A" }, { id: "b", label: "Group B" }]);
  });

  it("returns [] when groups is missing (first-run, no config yet) rather than throwing", () => {
    expect(extractGroupSummaries({})).toEqual([]);
  });

  it("returns [] when groups is present but not an array (malformed/unexpected shape)", () => {
    expect(extractGroupSummaries({ groups: "not an array" })).toEqual([]);
  });

  it("skips a malformed group entry (missing id/label) without throwing, keeping the well-formed ones", () => {
    const raw = { groups: [{ id: "a", label: "Group A" }, { id: "b" }, "not an object", { id: "c", label: "Group C" }] };
    expect(extractGroupSummaries(raw)).toEqual([{ id: "a", label: "Group A" }, { id: "c", label: "Group C" }]);
  });

  it("a single-group install (the common, pre-multi-group case) still extracts correctly -- NavHeader's own '2+ groups' gate is what suppresses the switcher, not this function", () => {
    const raw = { groups: [{ id: "default-search-1", label: "Default Search 1" }] };
    expect(extractGroupSummaries(raw)).toEqual([{ id: "default-search-1", label: "Default Search 1" }]);
  });
});
