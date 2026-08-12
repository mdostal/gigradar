// Tests for src/lib/sources/origins.ts — the shared per-source origin
// allowlist registry extracted from gofractional.ts's/ateam.ts's own
// previously-inline `ALLOWED_ORIGINS` constants (see the
// origin-registry-extraction story). This asserts two things:
//   1. the extracted values are byte-identical to a hardcoded snapshot of
//      what was inline in each adapter BEFORE this extraction — same
//      domains, same order, same casing, no incidental correction;
//   2. `SOURCE_ORIGINS`'s type is `readonly string[]`-valued, enforced at
//      the type level (a mutation attempt must fail to compile), not just a
//      naming convention.
import { describe, expect, it } from "vitest";
import { SOURCE_LOGIN_URLS, SOURCE_ORIGINS } from "../origins.js";

// Hardcoded snapshot of the exact values that were inline in
// gofractional.ts's/ateam.ts's own `const ALLOWED_ORIGINS = [...]` before
// this extraction — see this story's acceptance criteria. Do NOT "fix" this
// snapshot to match origins.ts if they ever diverge; a divergence here means
// the extraction (or a later edit) silently changed a working adapter's
// origin scope, which is exactly the regression this test exists to catch.
const PRE_EXTRACTION_SNAPSHOT: Record<string, readonly string[]> = {
  gofractional: ["gofractional.com"],
  ateam: ["a.team", "platform.a.team"],
};

describe("SOURCE_ORIGINS", () => {
  it("matches the hardcoded pre-extraction snapshot exactly (byte-identical values, same order, same casing)", () => {
    expect(SOURCE_ORIGINS).toEqual(PRE_EXTRACTION_SNAPSHOT);
  });

  it("has exactly the keys gofractional.ts and ateam.ts registered before this extraction — no silently added/removed source", () => {
    expect(Object.keys(SOURCE_ORIGINS).sort()).toEqual(["ateam", "gofractional"]);
  });

  it("gofractional: is scoped to gofractional.com only", () => {
    expect(SOURCE_ORIGINS["gofractional"]).toEqual(["gofractional.com"]);
  });

  it("ateam: is scoped to a.team and platform.a.team, in that order", () => {
    expect(SOURCE_ORIGINS["ateam"]).toEqual(["a.team", "platform.a.team"]);
  });

  it("enforces readonly at the type level — a mutation call must fail to compile", () => {
    // Deliberately NEVER CALLED — this function exists purely so `tsc`
    // (via `npm run typecheck`, which type-checks all of src/**/*.ts,
    // including test files) type-checks its body. Calling it at runtime
    // would actually mutate SOURCE_ORIGINS's shared underlying array
    // (readonly is a TS-only, compile-time-only guarantee — plain arrays
    // are always mutable at runtime), polluting every other test/module
    // sharing this singleton for the rest of the process. If a future
    // change to origins.ts's declared type (e.g. widening SOURCE_ORIGINS's
    // values back to plain `string[]`) makes the line below compile,
    // `@ts-expect-error` itself starts erroring ("Unused '@ts-expect-error'
    // directive"), which fails `npm run typecheck` — that's this test's
    // actual readonly-enforcement check.
    function assertReadonlyAtTypeLevel(origins: (typeof SOURCE_ORIGINS)["gofractional"]): void {
      // @ts-expect-error — readonly string[] has no push().
      origins.push("evil.example.com");
    }
    void assertReadonlyAtTypeLevel;

    // Runtime companion check: SOURCE_ORIGINS's declared TS type is
    // `Record<string, readonly string[]>` — this asserts the array itself
    // was never mutated by anything else, i.e. still exactly the
    // pre-extraction value.
    expect(SOURCE_ORIGINS["gofractional"]).toEqual(["gofractional.com"]);
  });
});

// Added by the session-capture-ui story — the per-source login URL registry
// the capture UI's startCaptureAction() reads (src/app/config/actions.ts).
describe("SOURCE_LOGIN_URLS", () => {
  it("has an entry for every SOURCE_ORIGINS key — a capture button is only ever shown for a source with BOTH", () => {
    expect(Object.keys(SOURCE_LOGIN_URLS).sort()).toEqual(Object.keys(SOURCE_ORIGINS).sort());
  });

  it("gofractional: GoFractional's own dedicated login route", () => {
    expect(SOURCE_LOGIN_URLS["gofractional"]).toBe("https://www.gofractional.com/login");
  });

  it("ateam: the real, live-confirmed URL (Mission Control itself, which redirects to Sign In when unauthenticated) — not an unverified /login guess", () => {
    expect(SOURCE_LOGIN_URLS["ateam"]).toBe("https://platform.a.team/mission-control");
  });

  it("every URL is a real https:// URL (sanity check against an accidental empty string/typo)", () => {
    for (const url of Object.values(SOURCE_LOGIN_URLS)) {
      expect(url).toMatch(/^https:\/\/.+/);
    }
  });
});
