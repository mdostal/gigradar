import { describe, expect, it } from "vitest";
import type { Config, Gig } from "../../types.js";
import { resolveApplicationFormat } from "../draft.js";
import { getSource } from "../../sources/source.js";
import { sourceConfigFromPreset, SOURCE_PRESETS } from "../../sources/source-presets.js";

// application-format-coverage-per-source story. Real research findings (see
// each adapter's own header/inline comment for the full citation) for the 8
// previously-uncovered sources this story audits:
//   - builtin, wellfound, braintrust: a real, researched non-default format.
//   - fractionus, fractionaljobs, ateam, fractionalfinders: deliberately
//     left at the "cover-letter" fallback -- documented, not silently
//     skipped -- because each one's real application mechanism genuinely
//     varies (aggregators/syndicators) or is genuinely undeterminable
//     without a login this environment can't perform.
//   - gun-io (a SourcePreset, not a hand-written Source adapter -- see
//     source-presets.ts) DOES have a real researched value ("why-fit").
//
// Side-effect imports below register each real Source adapter (see
// source.ts's registry / register-all.ts's own doc comment on why these are
// dynamic imports there but plain static imports are fine in an isolated
// test file that never imports register-all.ts itself).
import { builtinSource } from "../../sources/builtin.js";
import { wellfoundSource } from "../../sources/wellfound.js";
import { braintrustSource } from "../../sources/braintrust.js";
import { fractionusSource } from "../../sources/fractionus.js";
import { fractionalJobsSource } from "../../sources/fractionaljobs.js";
import { ateamSource } from "../../sources/ateam.js";
import { fractionalFindersSource } from "../../sources/fractionalfinders.js";

function makeConfig(sources: Config["sources"] = []): Config {
  return {
    profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            {
              id: "any-hourly",
              label: "Any (hourly)",
              types: ["contract", "fractional", "contract-to-hire"],
              minRate: 0,
              highRate: 999_999,
              maxHours: 999,
              maxHoursAtHighRate: 999,
              rateUnit: "hour",
            },
          ],
          freshStageOnly: false,
          remoteOnly: false,
        },
      },
    ],
    sources,
  };
}

function makeGig(sourceId: string): Gig {
  return { sourceId, externalId: "1", title: "A real gig", url: `https://example.test/${sourceId}/1` };
}

describe("application-format-coverage-per-source: researched non-default formats", () => {
  it.each([
    ["builtin", builtinSource, "form-fields"],
    ["wellfound", wellfoundSource, "why-fit"],
    ["braintrust", braintrustSource, "form-fields"],
  ] as const)("%s's Source.applicationFormat is the researched %s value, and resolveApplicationFormat() surfaces it for a real gig", (sourceId, source, expected) => {
    expect(getSource(sourceId)).toBe(source);
    expect(source.applicationFormat).toBe(expected);

    const config = makeConfig([{ id: sourceId, enabled: true }]);
    expect(resolveApplicationFormat(makeGig(sourceId), config)).toBe(expected);
  });
});

describe("application-format-coverage-per-source: deliberate, documented cover-letter fallbacks", () => {
  it.each([
    ["fractionus", fractionusSource],
    ["fractionaljobs", fractionalJobsSource],
    ["ateam", ateamSource],
    ["fractionalfinders", fractionalFindersSource],
  ] as const)("%s has no static applicationFormat set (deliberate -- see its own header comment) and resolveApplicationFormat() falls through to \"cover-letter\"", (sourceId, source) => {
    expect(getSource(sourceId)).toBe(source);
    expect(source.applicationFormat).toBeUndefined();

    const config = makeConfig([{ id: sourceId, enabled: true }]);
    expect(resolveApplicationFormat(makeGig(sourceId), config)).toBe("cover-letter");
  });
});

describe("application-format-coverage-per-source: gun-io custom-recipe preset", () => {
  it("has a real researched applicationFormat (\"why-fit\") and resolveApplicationFormat() surfaces it end-to-end via the SourceConfig override path", () => {
    const gunIo = SOURCE_PRESETS.find((p) => p.id === "gun-io");
    expect(gunIo?.applicationFormat).toBe("why-fit");

    const sourceConfig = sourceConfigFromPreset(gunIo!, []);
    expect(sourceConfig.applicationFormat).toBe("why-fit");

    const config = makeConfig([sourceConfig]);
    expect(resolveApplicationFormat(makeGig(sourceConfig.id), config)).toBe("why-fit");
  });
});
