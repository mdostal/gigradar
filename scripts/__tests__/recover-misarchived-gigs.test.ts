// deep-dive-audit-and-testing-framework epic, recover-misarchived-applied-gigs
// story. Tests the pure findCandidates() logic in isolation -- no DB, no
// filesystem. See recover-misarchived-gigs.ts's own header comment for the
// full source-specific heuristic this proves.
import { describe, expect, it } from "vitest";
import { findCandidates, type WithdrawnRow } from "../recover-misarchived-gigs.js";

function row(overrides: Partial<WithdrawnRow> & { key: string; source_id: string }): WithdrawnRow {
  return {
    external_id: "x",
    status: "archived",
    outcome_reason: "withdrawn",
    first_seen: "2026-01-01T00:00:00.000Z",
    unavailable_since: "2026-01-01T00:00:00.000Z",
    title: "Some Gig",
    ...overrides,
  };
}

describe("findCandidates", () => {
  it("flags EVERY gofractional withdrawn gig as recoverable -- outcome_reason='withdrawn' is structurally impossible from a real platform label for this source", () => {
    const rows = [row({ key: "gofractional:1", source_id: "gofractional", first_seen: "2026-08-13T00:00:00.000Z", unavailable_since: "2026-08-13T00:00:00.000Z" })];

    const { candidates, excluded, reportedOnly } = findCandidates(rows);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.key).toBe("gofractional:1");
    expect(candidates[0]?.restoreToStatus).toBe("applied");
    expect(excluded).toHaveLength(0);
    expect(reportedOnly).toHaveLength(0);
  });

  it("NEVER flags a wellfound gig scraped from the /archived/ applications page, regardless of timestamp coincidence", () => {
    const rows = [
      row({ key: "wellfound:jobs/applications/archived/1", source_id: "wellfound", external_id: "jobs/applications/archived/1", first_seen: "2026-09-01T14:48:43.145Z", unavailable_since: "2026-09-01T14:48:43.146Z" }),
      row({ key: "wellfound:jobs/applications/archived/2", source_id: "wellfound", external_id: "jobs/applications/archived/2", first_seen: "2026-09-01T14:48:43.146Z", unavailable_since: "2026-09-01T14:48:43.146Z" }),
    ];

    const { candidates, excluded } = findCandidates(rows);

    expect(candidates).toHaveLength(0);
    expect(excluded).toHaveLength(2);
    expect(excluded.every((e) => e.reason.includes("archived"))).toBe(true);
  });

  it("flags a NON-archived-page wellfound gig only when its unavailableSince exactly coincides with a same-source sibling write (the collateral-damage fingerprint)", () => {
    const rows = [
      row({ key: "wellfound:jobs/applications/1", source_id: "wellfound", external_id: "jobs/applications/1", first_seen: "2026-09-01T10:00:00.000Z", unavailable_since: "2026-09-01T14:48:43.146Z" }),
      row({ key: "wellfound:jobs/applications/2", source_id: "wellfound", external_id: "jobs/applications/2", first_seen: "2026-09-01T14:48:43.146Z", unavailable_since: "2026-09-01T14:48:43.146Z" }),
    ];

    const { candidates } = findCandidates(rows);

    expect(candidates.map((c) => c.key)).toEqual(["wellfound:jobs/applications/1"]);
  });

  it("does not flag a wellfound gig with no coincident sibling -- reported as ambiguous instead of guessed", () => {
    const rows = [row({ key: "wellfound:jobs/applications/1", source_id: "wellfound", external_id: "jobs/applications/1", first_seen: "2026-08-01T00:00:00.000Z", unavailable_since: "2026-09-01T00:00:00.000Z" })];

    const { candidates, excluded, reportedOnly } = findCandidates(rows);

    expect(candidates).toHaveLength(0);
    expect(excluded).toHaveLength(0);
    expect(reportedOnly).toHaveLength(1);
  });

  it("does not flag a wellfound gig flagged in the SAME write as its own insert (unavailableSince === firstSeen) -- the normal shape for a real backfilled-terminal record, not collateral damage", () => {
    const rows = [row({ key: "wellfound:jobs/applications/1", source_id: "wellfound", external_id: "jobs/applications/1", first_seen: "2026-09-01T00:00:00.000Z", unavailable_since: "2026-09-01T00:00:00.000Z" })];

    const { candidates, reportedOnly } = findCandidates(rows);

    expect(candidates).toHaveLength(0);
    expect(reportedOnly).toHaveLength(1);
  });

  it("accounting reconciles: every input row lands in exactly one of candidates/excluded/reportedOnly", () => {
    const rows = [
      row({ key: "gofractional:1", source_id: "gofractional" }),
      row({ key: "wellfound:jobs/applications/archived/1", source_id: "wellfound", external_id: "jobs/applications/archived/1" }),
      row({ key: "wellfound:jobs/applications/2", source_id: "wellfound", external_id: "jobs/applications/2", first_seen: "2026-08-01T00:00:00.000Z", unavailable_since: "2026-09-01T00:00:00.000Z" }),
    ];

    const { candidates, excluded, reportedOnly } = findCandidates(rows);

    expect(candidates.length + excluded.length + reportedOnly.length).toBe(rows.length);
  });
});
