import { describe, expect, it, vi } from "vitest";

// gigradar-command-center epic: layout.tsx now calls next/font/google at
// module scope (Signal Deck's own fonts) -- a real SWC build-time
// transform in Next's own pipeline, not a real runtime function outside
// it, so it throws under plain vitest unless mocked. Returns the same
// shape real next/font does (an object with a `.variable` class name)
// since layout.tsx reads `.variable` off each font -- this test only
// cares about extractGroupSummaries() below, never these fonts, but the
// whole module still has to evaluate cleanly to import that function.
vi.mock("next/font/google", () => ({
  Oxanium: () => ({ variable: "mock-oxanium" }),
  IBM_Plex_Sans: () => ({ variable: "mock-ibm-plex-sans" }),
  IBM_Plex_Mono: () => ({ variable: "mock-ibm-plex-mono" }),
  Public_Sans: () => ({ variable: "mock-public-sans" }),
}));

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
