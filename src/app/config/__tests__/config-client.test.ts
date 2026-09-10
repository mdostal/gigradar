// Tests for src/app/config/config-client.tsx's isSourceSaved() -- real bug,
// live-reproduced 2026-09-10 (owner's own BTG dogfood session): every
// Capture Login Server Action reads the SAVED config.json, never this
// page's in-memory draft -- a source added via "Add from a preset" but not
// yet persisted via "Save config" produced a confusing, developer-aimed
// error ("no login URL registered... see src/lib/sources/origins.ts")
// instead of a clear "save first" message. ConfigClient itself is a Client
// Component with hooks and this repo has no React Testing Library/jsdom
// setup (see today-client.test.ts's own header comment for this project's
// established convention) -- isSourceSaved() is exported specifically so
// this exact condition is testable without rendering the component.
import { describe, expect, it } from "vitest";
import { isSourceSaved } from "../config-client.js";
import type { SourceConfig } from "@/lib/types";

describe("isSourceSaved", () => {
  const savedSources: SourceConfig[] = [
    { id: "builtin", enabled: true },
    { id: "gofractional", enabled: true, settings: { sessionStatePath: "/fake/gf.json" } },
  ];

  it("returns true for a source that exists in the server-loaded, persisted config", () => {
    expect(isSourceSaved(savedSources, "gofractional")).toBe(true);
  });

  it("returns false for a source only in the draft -- e.g. just added from a preset, not yet saved (the real BTG bug)", () => {
    expect(isSourceSaved(savedSources, "btg")).toBe(false);
  });

  it("returns false against an empty persisted config (a brand-new source added before ever saving anything)", () => {
    expect(isSourceSaved([], "btg")).toBe(false);
  });
});
