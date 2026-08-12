import type { Source } from "./source.js";
import type { Gig } from "../types.js";

/**
 * Reference implementation showing the contract. Real sources
 * (fractional-jobs, go-fractional, braintrust, wellfound, a.team, ...) each
 * live in their own file and implement Source the same way.
 *
 * Ported note: the existing gig-radar scripts already drive a logged-in
 * browser for A.Team (see the private gig-radar repo's sources.mjs) and run a
 * heuristic gate. This is the clean, typed, per-source home for that logic.
 */
export const exampleSource: Source = {
  id: "example",
  label: "Example (contract demo)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    // A real source fetches + normalizes here. Returning static demo data so
    // the pipeline (gate -> rank -> report) is runnable end-to-end today.
    return [
      {
        sourceId: "example",
        externalId: "demo-1",
        title: "Fractional CTO — seed-stage AI SaaS",
        company: "Demo Co",
        url: "https://example.com/listings/demo-1",
        rate: { min: 250, max: 350, unit: "hour" },
        weeklyHours: 15,
        remote: true,
        contractToHire: false,
        stage: "fresh",
        postedAt: "2026-08-10",
        description: "Own architecture and AI adoption for a small team.",
      },
      {
        sourceId: "example",
        externalId: "demo-2",
        title: "Senior Engineer (contract-to-hire)",
        company: "Other Co",
        url: "https://example.com/listings/demo-2",
        rate: { min: 120, max: 140, unit: "hour" },
        weeklyHours: 40,
        remote: true,
        contractToHire: true,
        stage: "fresh",
        postedAt: "2026-08-09",
        description: "Full-time-ish backend role.",
      },
    ];
  },
};
