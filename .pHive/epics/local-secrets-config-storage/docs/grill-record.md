# Grill Record — local-secrets-config-storage

**Source draft:** .pHive/epics/local-secrets-config-storage/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 3
**Generated:** 2026-08-11

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: clean
- Convention violations: 1 finding
- Posture mismatches: 1 finding

## Vocabulary mismatches

No terminology contradictions found against `.pHive/CONTEXT.md` or within
the draft itself. Note (not a finding): this epic introduces new
vocabulary (local settings file, env-var-reference resolution) that
CONTEXT.md's maintenance contract says should be added once this epic
lands — flagged in Notes below, not a grill finding.

## Hidden assumptions

- **H1** — The env-var-reference resolution mechanism is specified by a
  single example, not a general convention.
  - Draft location: §3 step 2 ("`SourceConfig.settings` values that need a
    secret store the env VAR NAME (e.g. `{"apiKeyEnvVar":
    "BRAINTRUST_API_KEY"}`)")
  - Why this matters: the loader (§3 step 3) needs a deterministic way to
    know WHICH keys in an arbitrary `settings: Record<string, unknown>`
    object are env-var references vs. plain values. One example key name
    (`apiKeyEnvVar`) doesn't specify the general rule — is it any key
    ending in `EnvVar`? A separate explicit map? Without a stated
    convention, two different sources' settings could each invent their
    own ad-hoc reference key, defeating the point of a uniform loader.
  - Question for planner: define the general convention explicitly (e.g. a
    naming suffix rule checked at load time, or a dedicated
    `secretEnvVars: Record<string,string>` field alongside `settings`) —
    not just one example.

## Unresolved tensions

Clean — no competing requirements found that the draft leaves
unreconciled.

## Convention violations

- **C1** — Storing local state inside the repo tree (relying on gitignore
  alone) contradicts the precedent this same codebase just set for exactly
  this threat model.
  - Draft location: §3 step 1 (`.local/config.json`, inside the repo,
    "the repo already has `.local/` gitignored from scaffold — reuse it")
    and §3 step 2 (`.env` at the repo root).
  - Convention: the merged `find-pipeline-foundation` epic's persistence
    story explicitly rejected an in-repo-tree default for exactly this
    reason — its design-discussion states the DB path "must default to a
    user-data directory outside the repo tree... never `./data/`... one
    `git add .` from committing gig/status history," with gitignore
    patterns added only as "belt-and-suspenders," not the primary
    defense. This draft applies the weaker (gitignore-only) pattern to
    data that is, if anything, MORE sensitive (API keys, not just scanned
    job listings).
  - Question for planner: apply the same standard — default the settings
    file and secrets file to a location outside the repo tree (matching
    `src/lib/store/path.ts`'s existing XDG-style resolution), with
    `.gitignore` patterns as defense-in-depth only, not the sole
    safeguard.

## Posture mismatches

- **P1** — The literal architectural posture is "never in the repo," which
  a gitignored-but-still-inside-the-working-tree path arguably violates.
  - Draft location: §3 step 1, choosing `.local/config.json`.
  - Posture reference: `src/lib/types.ts`'s `Config` doc comment ("Lives in
    the user's own storage, never in the repo") and `docs/ARCHITECTURE.md`
    ("the user's own storage (`.local/`, env, private repo)") — note
    `docs/ARCHITECTURE.md` itself already names `.local/` as the example
    "user's own storage" location, which is in tension with the stricter
    reading of `types.ts`'s "never in the repo." This is a pre-existing
    ambiguity in the project's own docs, not one this draft invented — but
    the draft should resolve it explicitly rather than silently picking
    the more permissive reading.
  - Question for planner: given `docs/ARCHITECTURE.md` already treats
    `.local/` as acceptable "user's own storage," is the intent "inside
    the repo's working tree but gitignored" (current draft) or "outside
    the repo entirely" (matching the persistence epic's stricter
    standard, and C1 above)? Pick one and state it explicitly — this
    also resolves C1.

## Notes

- CONTEXT.md should gain entries for the new vocabulary this epic
  introduces (local settings file, `.env` secrets, env-var-reference
  resolution) once the design settles — not blocking for this pass.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; the
planner's job is to revise the draft (or document accepted deviations)
before stories are written.
