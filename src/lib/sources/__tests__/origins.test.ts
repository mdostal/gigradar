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
import {
  KNOWN_SOURCES,
  resolveAllowedOrigins,
  resolveLoginUrl,
  resolveProfileUrl,
  SOURCE_LOGIN_URLS,
  SOURCE_ORIGINS,
  SOURCE_PROFILE_URLS,
} from "../origins.js";
import type { SourceConfig } from "../../types.js";

// Hardcoded snapshot of the exact values that were inline in
// gofractional.ts's/ateam.ts's own `const ALLOWED_ORIGINS = [...]` before
// this extraction — see this story's acceptance criteria. Do NOT "fix" this
// snapshot to match origins.ts if gofractional's/ateam's OWN entries ever
// diverge from it; a divergence there means a later edit silently changed a
// working adapter's origin scope, which is exactly the regression this test
// exists to catch. New keys for NEW sources (e.g. `wellfound`, added by the
// adapter-batch-public-boards epic's wellfound-adapter story) are legitimate
// registry growth, not a regression — asserted as a SUBSET below (same
// `expect.arrayContaining`/subset pattern KNOWN_SOURCES already uses further
// down this file), never a closed, exact-key-set snapshot that would have to
// be hand-edited every time this project ships one more adapter.
const PRE_EXTRACTION_SNAPSHOT: Record<string, readonly string[]> = {
  gofractional: ["gofractional.com"],
  ateam: ["a.team", "platform.a.team"],
};

describe("SOURCE_ORIGINS", () => {
  it("still contains the hardcoded pre-extraction snapshot's values, byte-identical (same order, same casing) — new keys for other sources may coexist", () => {
    expect(SOURCE_ORIGINS).toMatchObject(PRE_EXTRACTION_SNAPSHOT);
  });

  it("still has the keys gofractional.ts and ateam.ts registered before this extraction — no silent removal (additions are fine)", () => {
    expect(Object.keys(SOURCE_ORIGINS)).toEqual(expect.arrayContaining(["ateam", "gofractional"]));
  });

  it("gofractional: is scoped to gofractional.com only", () => {
    expect(SOURCE_ORIGINS["gofractional"]).toEqual(["gofractional.com"]);
  });

  it("ateam: is scoped to a.team and platform.a.team, in that order", () => {
    expect(SOURCE_ORIGINS["ateam"]).toEqual(["a.team", "platform.a.team"]);
  });

  it("wellfound: is scoped to wellfound.com only — adapter-batch-public-boards epic, wellfound-adapter story", () => {
    expect(SOURCE_ORIGINS["wellfound"]).toEqual(["wellfound.com"]);
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
    expect(SOURCE_LOGIN_URLS["ateam"]).toBe("https://platform.a.team/mission-control/all");
  });

  it("wellfound: Wellfound's own real, live-confirmed dedicated login route — a dedicated session, never gofractional's or ateam's URL", () => {
    expect(SOURCE_LOGIN_URLS["wellfound"]).toBe("https://wellfound.com/login");
    expect(SOURCE_LOGIN_URLS["wellfound"]).not.toBe(SOURCE_LOGIN_URLS["gofractional"]);
    expect(SOURCE_LOGIN_URLS["wellfound"]).not.toBe(SOURCE_LOGIN_URLS["ateam"]);
  });

  it("every URL is a real https:// URL (sanity check against an accidental empty string/typo)", () => {
    for (const url of Object.values(SOURCE_LOGIN_URLS)) {
      expect(url).toMatch(/^https:\/\/.+/);
    }
  });
});

// profile-assist epic, profile-assist-persistent-session-manual-mode
// story — the per-source profile-edit URL registry assist-session.ts reads.
// None of these three values are live-confirmed (see origins.ts's own
// comment) — this test only asserts the registry's SHAPE (an entry per
// browser-session source, real https:// URLs), never the specific path,
// since those paths are expected to be corrected by the owner's own
// standing follow-up without needing a test update every time.
describe("SOURCE_PROFILE_URLS", () => {
  it("has an entry for every browser-session-auth source (SOURCE_LOGIN_URLS' key set)", () => {
    expect(Object.keys(SOURCE_PROFILE_URLS).sort()).toEqual(Object.keys(SOURCE_LOGIN_URLS).sort());
  });

  it("every URL is a real https:// URL (sanity check against an accidental empty string/typo)", () => {
    for (const url of Object.values(SOURCE_PROFILE_URLS)) {
      expect(url).toMatch(/^https:\/\/.+/);
    }
  });
});

// adapter-batch-public-boards epic, public-fetch-adapters story — this
// story's own acceptance criterion: KNOWN_SOURCES must include all four new
// sources from this epic (the three fetch-based adapters this story ships,
// PLUS wellfound for its sibling story — see origins.ts's own comment on
// why wellfound is listed here even though wellfound.ts doesn't exist yet
// from this story's perspective).
describe("KNOWN_SOURCES", () => {
  it("includes fractionaljobs, fractionus, fractionalfinders, and wellfound (all four new sources from adapter-batch-public-boards)", () => {
    const ids = KNOWN_SOURCES.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["fractionaljobs", "fractionus", "fractionalfinders", "wellfound"]),
    );
  });

  it("still includes every pre-existing source — no silent removal", () => {
    const ids = KNOWN_SOURCES.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["braintrust", "builtin", "gofractional", "ateam"]));
  });

  it("has no duplicate ids", () => {
    const ids = KNOWN_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// resolveAllowedOrigins()/resolveLoginUrl()/resolveProfileUrl(): static
// registry first, cfg.settings.* config-driven fallback second — the
// mechanism a custom-llm-source preset (e.g. Catalant, Indeed) with no
// registry entry relies on for Capture Login and profile-assist alike.
describe("resolveAllowedOrigins/resolveLoginUrl/resolveProfileUrl fallback", () => {
  const REGISTERED_ID = "gofractional";
  const CUSTOM_ID = "some-custom-source";

  it("prefers the static registry over cfg.settings for a registered source id", () => {
    const cfg: SourceConfig = { id: REGISTERED_ID, enabled: true, settings: { allowedOrigins: ["evil.example.com"] } };
    expect(resolveAllowedOrigins(REGISTERED_ID, cfg)).toEqual([...SOURCE_ORIGINS[REGISTERED_ID]!]);
    expect(resolveLoginUrl(REGISTERED_ID, cfg)).toBe(SOURCE_LOGIN_URLS[REGISTERED_ID]);
    expect(resolveProfileUrl(REGISTERED_ID, cfg)).toBe(SOURCE_PROFILE_URLS[REGISTERED_ID]);
  });

  it("falls back to cfg.settings.* for an id with no registry entry", () => {
    const cfg: SourceConfig = {
      id: CUSTOM_ID,
      enabled: true,
      kind: "custom-llm",
      settings: { allowedOrigins: ["example.com"], loginUrl: "https://example.com/login", profileUrl: "https://example.com/profile" },
    };
    expect(resolveAllowedOrigins(CUSTOM_ID, cfg)).toEqual(["example.com"]);
    expect(resolveLoginUrl(CUSTOM_ID, cfg)).toBe("https://example.com/login");
    expect(resolveProfileUrl(CUSTOM_ID, cfg)).toBe("https://example.com/profile");
  });

  it("returns undefined (never throws) when neither the registry nor cfg.settings has an answer", () => {
    const cfg: SourceConfig = { id: CUSTOM_ID, enabled: true, kind: "custom-llm", settings: {} };
    expect(resolveAllowedOrigins(CUSTOM_ID, cfg)).toBeUndefined();
    expect(resolveLoginUrl(CUSTOM_ID, cfg)).toBeUndefined();
    expect(resolveProfileUrl(CUSTOM_ID, cfg)).toBeUndefined();
  });
});
