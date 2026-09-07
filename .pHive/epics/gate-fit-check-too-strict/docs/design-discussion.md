# Design discussion: gate-fit-check-too-strict

## 0. Trigger

Direct, live owner report (2026-09-07): "why am i going from my email
list rather than gig radar? ... there literally aren't jobs on gig
radar that I see everywhere," with a concrete example URL
(`fractionaljobs.io/jobs/chief-technology-officer-at-a-healthtech-hardware-brand`).

## 1. Root-cause diagnosis (real data, read-only, via `readRawConfig()` +
the real `gate()` function — never the owner's real encrypted secrets,
never written or logged)

The linked gig IS in the owner's real database: tiered **GREEN**
(`matching/tiering.ts` correctly matched his `fractional-hourly`
group's own configured `roleArea.coreTitles` against the literal title
"Chief Technology Officer"), but `matched_group_ids: []` — it never
actually became a real, passed match for any group.

Running the real `gate()` function (`src/lib/matching/gate.ts`) against
this exact gig and the owner's real config reproduces it directly:

```
✗ no role/skill keyword match
```

**Root cause:** `gate()` runs its OWN, separate "role fit" check
(`fitScore()`) against `Profile.roles`/`Profile.skills` — free text the
owner wrote for his own reference ("Fractional CTO", "Principal
Architect", "Strategic CTO") — using literal, whole-phrase
`.includes()` substring matching against the gig's title+description.
"chief technology officer" does not literally contain "fractional cto"
as a substring (different phrasing of the same role), so the check
fails, `gate()` hard-rejects the gig for every group, and it never
enters `matchedGroupIds` — even though the SAME gig was independently,
correctly identified as GREEN by the group's own, far more
sophisticated, per-group-configurable `roleArea` tiering.

**Scope, measured directly against the owner's real (backed-up before
any change) database:** of 74 real GREEN-tier, non-archived gigs, 69
have empty `matchedGroupIds`. Of those 69: **24 fail specifically on
this "no role/skill keyword match" reason** (the real bug this epic
fixes) and 29 correctly, legitimately fail on rate (full-time roles
genuinely below his $250k floor — working as designed, not a bug). The
remaining ~16 are a mix of other legitimate rejects (not remote, etc.).
24 real, correctly-tiered matches silently thrown away is a severe,
confirmed, high-impact bug — not a coverage/source problem.

## 2. Why this is a real architectural inconsistency, not just a fluke

`matching/tiering.ts`'s own header comment states its philosophy
explicitly: "never a hard reject — 'no match' is YELLOW ('surface it,
worth a look'), not dropped." `gate()`'s `fitScore()` check violates
that exact philosophy for the SAME question ("is this a relevant
role") using a cruder, un-normalized, whole-phrase-only keyword set
(the owner's own free-text `profile.roles`/`skills`) that was never
designed to be the sole source of truth for role relevance — each
GROUP's own `roleArea` (coreTitles/keywords/redKeywords) is that
source of truth, and it already works correctly. `gate()` and
`tiering.ts` currently disagree with each other on the exact same
question because they use two disconnected keyword sets with two
different matching semantics (phrase-substring vs. whole-word,
case-sensitive-to-spacing vs. not) and two different reject
philosophies (hard-reject vs. never-reject).

## 3. The fix (conservative, additive, reuses proven code)

`gate()` gains an optional `roleArea?: RoleAreaConfig` parameter. When
provided, the "role/skill fit" check becomes: **pass if EITHER the
existing `profile.roles`/`skills` phrase-overlap succeeds (byte-identical,
unchanged) OR `tier(gig, roleArea).tier !== "red"`** — reusing
`matching/tiering.ts`'s own exported `tier()` function directly, never
reimplementing its whole-word-matching semantics a third time. This is
purely additive (an OR against the existing check): nothing that passes
today can newly fail; gigs the group's own tiering already correctly
recognizes as GREEN/YELLOW can now also correctly clear the gate,
closing exactly the class of bug found above without weakening any
existing, working filter (rate, hours, remote, freshness all stay
completely untouched).

`matchGroups()` (`src/lib/matching/group-match.ts`) already calls
`gate()` once per group internally — it needs to pass that group's own
`roleArea` through. `apply/runner.ts`'s own separate, primary-group-only
`gate()` call (used for the flat `MatchResult.reasons`/`matchedProfileIds`
surfaced in the UI) needs the same treatment for consistency, so the
flat/legacy reasons never contradict the per-group result.

## 4. Explicitly out of scope

- Removing or replacing `profile.roles`/`skills`-based fit scoring —
  it stays exactly as-is for groups/setups that rely on it; this is
  additive, not a replacement.
- Any change to rate/hours/remote/freshness gating — untouched.
- The rate-floor rejections found in the same diagnostic pass (the 29
  full-time-under-$250k gigs) — those are correct, working as designed,
  not part of this bug.
- fractionaljobs.io's own deliberate choice not to scrape rate/hours
  (documented in that adapter's own header comment, and correctly
  handled permissively by `gate()`'s existing "rate not published —
  passing" path) — not a bug, not touched here.

## 5. Verification requirements (high-stakes: this is the core matching
gate, called for every gig from every source, every scan)

- Every existing `gate.test.ts` case must still pass unchanged — this
  proves nothing that used to fail now incorrectly passes, and nothing
  that used to pass now fails.
- A new, direct regression test reproducing the exact real-world
  scenario found above: a gig titled "Chief Technology Officer" (no
  literal profile.roles/skills overlap) with a `roleArea` whose
  `coreTitles` includes "Chief Technology Officer" must now PASS gate()
  where it previously failed.
- A test proving a gig that is genuinely irrelevant (RED-tiered by
  `roleArea`, AND no profile.roles/skills overlap) still correctly
  FAILS gate() — the fix must not make gate() pass everything.
- A test proving `matchGroups()`'s real, end-to-end behavior changes
  correctly for a multi-group config (mirrors this session's own
  established "construct a real Config, run the real pipeline" testing
  convention).
