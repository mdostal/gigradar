# Structured Outline: Multi-Group Architecture

Builds on `design-discussion.md` (revised) and `horizontal-plan.md`/`vertical-plan.md`. This outline focuses detail where it's actionable now (Slice 1, the foundation) and stays lighter on Slices 2-4, which build on code that doesn't exist yet — over-specifying their file-level detail today would just be guessing.

## Part 1 — Detailed approach, Slice 1 (data + migration + matching)

### 1a. Types (`src/lib/types.ts`)

```ts
export interface GroupConfig {
  id: string;                 // stable slug, e.g. "fractional-search" — never re-derived from label
  label: string;               // user-facing name, e.g. "Fractional/Job Search"
  needs: Needs;                 // moved from Config.needs
  roleArea?: RoleAreaConfig;    // moved from Config.roleArea
}
```

`Config` changes: `needs: Needs` and `roleArea?: RoleAreaConfig` (today's flat fields) are REPLACED by `groups: GroupConfig[]`. `Profile`, `applyProfile`, `schedule`, `sources[]`, and every other top-level `Config` field are UNCHANGED. `SourceConfig` gains `groupIds?: string[]` (absent = evaluate against every group).

### 1b. Schema validation (`src/lib/config/schema.ts`)

New `GroupConfigSchema` (zod), `Config.groups: z.array(GroupConfigSchema).min(1)` (at least one group always required — there's no valid "zero groups" state, matching today's "at least one EngagementProfile required" precedent in `Needs`).

### 1c. Store schema (`src/lib/store/schema.ts`, `db.ts`)

```sql
matched_group_ids TEXT   -- JSON-stringified string[], nullable
```
via `ensureColumn(db, "gigs", "matched_group_ids", "TEXT")` — mirrors the existing `matched_profile_ids` column exactly (same nullable JSON-array pattern, same migration mechanism).

### 1d. Store read/write (`src/lib/store/gigs.ts`, `types.ts`)

- `GigRow.matched_group_ids: string | null`, `StoredGig.matchedGroupIds?: string[]` — same mapping shape as `matchedProfileIds` (`toStoredGig()`, `upsertOne()`).
- `GigFilter` gains `groupId?: string` — `listGigs({groupId})` filters where `matched_group_ids` JSON-array contains that id (SQLite `json_each`/`LIKE` on the serialized array, consistent with how this store already avoids a separate join table for `matchedProfileIds`).

### 1e. Config migration (`src/lib/config/load.ts`)

A new `migrateFlatNeedsRoleAreaToGroups()` function, called the same way `migrateNeedsEngagementProfiles()` already is: if a loaded raw config has `needs`/`roleArea` at the top level but no `groups[]`, wrap them into one `GroupConfig` (id: `"default"`, label: `"My Search"` as a placeholder — see decision point 3) and set `config.groups = [thatGroup]`, deleting the flat fields from the in-memory result. Runs on every `loadConfig()`/`readRawConfig()` call, transparent to every existing caller.

### 1f. Matching pipeline (`src/lib/apply/runner.ts`, new `src/lib/matching/group-match.ts`)

New pure function:
```ts
export function matchGroups(gig: Gig, groups: GroupConfig[], profile: Profile): string[] {
  const matched: string[] = [];
  for (const group of groups) {
    const gateResult = gate(gig, group.needs, profile);
    if (gateResult.pass) matched.push(group.id);
  }
  return matched;
}
```
`runRadar()`'s loop (`runner.ts:73-111`) changes from one `gate()`/`tier()` call per gig to: resolve which groups are in scope for this gig's source (`sourceConfig.groupIds ?? config.groups.map(g => g.id)`), call `matchGroups()` restricted to that scope, and — separately — `tier()` still needs exactly one `RoleAreaConfig` per gig for the existing Tier column; **decision point 1 below** covers how tier resolves across multiple matched groups with potentially different `roleArea`s.

## Part 2 — File manifest (Slice 1 only)

| File | Change |
|---|---|
| `src/lib/types.ts` | Add `GroupConfig`; replace `Config.needs`/`Config.roleArea` with `Config.groups: GroupConfig[]`; add `SourceConfig.groupIds?` |
| `src/lib/config/schema.ts` | Add `GroupConfigSchema`, update `ConfigSchema` |
| `src/lib/config/load.ts` | Add `migrateFlatNeedsRoleAreaToGroups()`, wire into existing migration call site |
| `src/lib/config/example-config.test.ts` (and `config.example.json`) | Update the shipped example to the new `groups[]` shape — this test already guards schema drift |
| `src/lib/store/schema.ts` | Add `matched_group_ids` column |
| `src/lib/store/db.ts` | Add `ensureColumn()` call |
| `src/lib/store/types.ts`, `gigs.ts` | `StoredGig.matchedGroupIds`, row mapping, `GigFilter.groupId` |
| `src/lib/matching/group-match.ts` (new) | `matchGroups()` pure function + its own test file |
| `src/lib/apply/runner.ts` | Rewire `runRadar()`'s loop to call `matchGroups()`, persist `matched_group_ids` |
| `src/lib/apply/__tests__/runner*.test.ts` | Update fixtures for the new `Config.groups` shape |
| `src/scheduler/__tests__/index.test.ts` | Update fixtures; confirm no scheduler-level logic actually changes |
| Every existing test fixture across `src/**/__tests__/` that constructs a `Config` literal with flat `needs`/`roleArea` | Update to the new `groups[]` shape — this is the single largest mechanical cost of Slice 1, not new logic |

## Part 3 — Risk registry

| # | Risk | Severity | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Migration silently loses or mis-tags real gig data | High | Additive-only, nullable column; no destructive rewrite; live-verify against the real DB after Slice 1 ships, same discipline as every PR this session | developer |
| R2 | `saveConfig()`'s shallow-merge lets a partial `groups[]` edit accidentally drop other groups | Medium | Config UI (Slice 2) must always resend the full `groups[]` array; add a dedicated test asserting this before Slice 2 ships | developer |
| R3 | Tier resolution ambiguity when a gig matches 2 groups with different `roleArea`s | Medium | See Decision Point 1 — must be resolved before Part 1f's code is written, not discovered mid-implementation | owner (decision), developer (implement) |
| R4 | Mechanical fixture-update cost across many test files could hide a real regression in the noise | Medium | Run the full suite after every fixture batch, not just at the end; typecheck catches most shape mismatches before tests even run | developer |
| R5 | Re-evaluating 1674 real gigs against the new scheme (on first post-migration scan) could be slow | Low | `gate()`/`tier()` are pure, no I/O — should be fast even N-groups × N-gigs; time it for real before assuming it's fine | developer |
| R6 | A not-yet-multi-group install (1 group) must look/behave byte-identical to today after Slice 1 | High | Explicit test: single-group config produces identical `matched_group_ids` semantics to not having the concept at all; dashboard shows zero visible change | developer |

## Part 4 — Elicitation (adversarial stress-test)

**Q: What happens to a gig's existing `tier` (green/yellow/red) when it now potentially clears multiple groups with different `RoleAreaConfig`s?**
A: This is Decision Point 1, genuinely unresolved by the design doc. Two real options: (a) tier becomes per-group too (`matched_group_tiers: {groupId: tier}` instead of one flat `tier` column), which is the "more correct" but larger change; (b) keep one flat `tier` column computed from whichever group the gig FIRST matched, which is simpler but semantically muddies what "tier" even means once groups diverge. Needs the owner's call before Part 1f is implemented for real.

**Q: Does `matchGroups()` really need to be a new file, or could it live inside `gate.ts`?**
A: New file is correct — `gate.ts`'s own `gate()` stays a pure single-`Needs` function (unchanged signature, unchanged tests); `matchGroups()` is a new, separate orchestration layer that calls `gate()` N times. Keeping them separate means Slice 1 never risks breaking `gate.ts`'s own already-proven, already-tested behavior.

**Q: Is the "at least one group always required" schema constraint (Part 1b) actually necessary, or could zero groups be a valid state (e.g. "still setting up")?**
A: Necessary — mirrors existing `Needs.engagementProfiles` precedent (`.min(1)` already enforced there), and a gig that can never match anything (zero groups to evaluate against) is a worse silent-failure mode than requiring at least a placeholder group to exist.

**Q: Could Slice 1 ship without the config migration (1e), just requiring the owner to manually re-enter their Needs/RoleArea into a new `groups[]` block?**
A: No — this session's own established discipline (every prior fix this session preserved real production data without requiring manual re-entry) rules this out. The migration is not optional scope; it's the same bar every other change tonight was held to.

**Q: What's the actual blast radius of "every existing test fixture" in the file manifest — is this bigger than it looks?**
A: Likely yes — the research found 42 files with explicit `Config` type imports; a meaningful fraction of those are test files constructing `Config` literals. This is real, mechanical, low-risk-but-nonzero-effort work, not a rounding error. Flagged honestly rather than hidden in "and update tests" hand-waving.

## Part 5 — Decision points (owner sign-off needed before Slice 1 implementation starts)

1. **Tier semantics across multiple matched groups** — per-group tier (larger, more correct) vs. one flat tier from the first match (smaller, simpler, semantically fuzzier). **Needs your call.**
2. **Default group's placeholder label** on migration — "My Search" as a generic placeholder (renamed by the owner post-migration, per design-discussion open question 3) vs. attempting to derive a real name from existing `RoleAreaConfig.coreTitles` (e.g. "Fractional CTO Search" if that's what the keywords say). Recommend the generic placeholder — deriving a name risks guessing wrong on real data.
3. **Should Slice 1 ship to `dev` and get live-verified against the real DB before Slice 2 (Config UI) even starts**, or should slices 1+2 be planned/built together and verified as one unit? Recommend shipping Slice 1 alone first — it's the highest-risk (real data migration), lowest-visibility slice, and isolating it means any real-data surprise gets caught before any UI work is invested on top of it.
