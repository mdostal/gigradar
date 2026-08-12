# Grill Record — encrypted-local-storage

**Source draft:** .pHive/epics/encrypted-local-storage/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 4

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: 1 finding
- Posture mismatches: clean

## Vocabulary mismatches

No findings. "Vault," "envelope," and "migrate" are new terms introduced by this
draft but used consistently within it and don't contradict any CONTEXT.md
definition or existing codebase terminology.

## Hidden assumptions

- **H1** — The draft never addresses what happens if the encryption key file
  itself is lost, deleted, or corrupted. Under the proposed design, the key is
  the ONLY thing that makes `config.json`/`.env`/session files readable again —
  losing it is total, permanent, unrecoverable data loss for the user's real
  config and captured GoFractional session (an asset the project owner has
  already invested manual login effort into), which is a materially WORSE
  failure mode than today's plaintext-but-always-readable files.
  - Draft location: §3 step 1 (`getOrCreateKey()`), §7 (verification plan —
    covers key persistence across calls, not key loss)
  - Why this matters: a single accidental `rm ~/.config/gigradar/key` (or a
    key-directory wipe during some unrelated cleanup) silently destroys every
    protected file at once, with no error until the next read attempt, and no
    stated recovery path.
  - Question for planner: does this design need an explicit "key loss" story
    (e.g., a clear, actionable error naming exactly what's unrecoverable and
    what to do next — re-run config setup, re-capture sessions), or is silent
    total loss an accepted risk for a single-user local tool? Either answer is
    fine, but the draft currently doesn't acknowledge the tradeoff exists.

- **H2** — The draft's Scale Assessment estimates "~10-12 files affected" but
  doesn't account for existing test suites that directly read/write plaintext
  file content as part of their assertions. Confirmed by direct inspection:
  `save.test.ts` (8 `readFileSync`/`writeFileSync` call sites),
  `load.test.ts` (3), `browser-session.test.ts` (3), `session-capture.test.ts`
  (2) — 16 total touchpoints across 4 files that construct plaintext fixtures
  on disk and/or assert plaintext content was written, all of which will need
  rewriting once the on-disk format becomes an encrypted envelope.
  - Draft location: §8 Scale Assessment ("Files affected: ~10-12")
  - Why this matters: this isn't optional cleanup — these tests will FAIL
    against the new format as written today, and the true "files affected"
    count for a Medium-scope estimate is meaningfully higher than stated.
  - Question for planner: should the scale estimate be revised to explicitly
    include these 4 existing test files (raising the count to ~14-16), so H/V
    planning sizes stories correctly rather than discovering this mid-execution?

## Unresolved tensions

- **U1** — The draft states the non-interactive-key requirement (§5, "the key
  must be retrievable without a passphrase prompt") and separately frames the
  epic as meaningfully hardening security (§1, "Making encryption-at-rest the
  DEFAULT," §4 "High" risk on key placement) — but never states what threat
  model this actually defends against. A key generated automatically and
  stored `0600` in a file the same OS user can always read is retrievable by
  exactly the same access level that could already read today's `0600`
  plaintext files. The two constraints aren't logically contradictory, but the
  draft doesn't reconcile "meaningfully more secure" with "trivially,
  automatically decryptable by anything running as this user" — without a
  stated threat model, a reader can't tell what attack this actually stops
  (e.g., protects backups/git-add accidents and casual directory browsing;
  does NOT protect against anything with the user's own account access).
  - Draft location: §1 ("Making encryption-at-rest the DEFAULT"), §4 (High risk
    item on key placement), §5 (non-interactive requirement)
  - Tension: "real security hardening" vs. "key must be trivially,
    non-interactively retrievable by the same principal that could already
    read the plaintext."
  - Question for planner: should the design-discussion state an explicit,
    one-line threat model (what this protects against, what it explicitly does
    NOT protect against) so the epic's value proposition is honest and
    reviewable, rather than implying broader protection than a
    same-user-retrievable key can actually provide?

## Convention violations

- **C1** — `src/lib/config/load.ts`'s own file-level header comment states, as
  a deliberate and explicit design choice: "This module deliberately does NOT
  create config.json (or .env) if they're missing... **loadConfig() only ever
  reads**." The draft's migration design (§3 step 2 and step 3: "if legacy
  plaintext, parse directly AND immediately re-write encrypted") has
  `loadConfig()`'s read path perform a disk WRITE as a side effect — directly
  contradicting this already-documented, deliberate invariant, without
  acknowledging the conflict anywhere in the draft.
  - Draft location: §3 steps 2 and 3 ("immediately re-write encrypted... no
    separate migration step or user action")
  - Convention: `src/lib/config/load.ts` lines 10-18 (file header comment,
    "loadConfig() only ever reads")
  - Question for planner: is this an intentional, justified departure (the
    draft's own rationale — "no separate migration step" — is reasonable and
    could stand as the justification), in which case it should be stated
    explicitly and the `load.ts` header comment updated in the same story to
    stop asserting a now-false invariant? Or should migration instead be
    triggered only from the write paths (`save.ts`, `session-capture.ts`),
    leaving `loadConfig()`/`readStorageStateFile()` read-only as documented,
    with plaintext files staying plaintext until the user's next save/capture?

## Posture mismatches

No findings. This is an application-code design (not a Hive skill/workflow
change), so Hive's composable-substrate/atomic-skill posture doesn't directly
apply; the design's own module boundaries (new `security/vault.ts` +
`security/key-path.ts`, mirroring the existing `store/path.ts` pattern) are
consistent with this codebase's established single-purpose-module convention.

## Notes

None beyond the findings above — the draft is otherwise internally consistent
and its three previously-open questions (key location, DB scope, corrupted-file
handling) are genuinely resolved with stated rationale, not just asserted.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
