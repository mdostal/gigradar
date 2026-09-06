# Grill pass (post-merge, pre-release)

Owner's explicit directive: "keep going, once backlog is full done, verify and
release." Ran `/code-review high` against the full epic diff (`9efa7f0..dev`,
PRs #148-#151). 10 findings; 8 fixed here, 2 knowingly deferred with reasoning
below.

## Fixed

1. **gigs.ts `upsertOne()` silently discarded manual bucket confirms on every
   rescan.** The rescan write path unconditionally overwrote
   `matched_rank_buckets` with the fresh rule/AI result, even for a group where
   the owner had already manually confirmed/overridden a bucket. Fixed: reads
   the existing row first, preserves any `source: "manual"` entries across the
   merge.
2. **rank-bucket.ts `ruleMatches()` dropped accumulated reasons on a keyword
   mismatch.** A rule that passed its rate check but failed its keyword check
   returned a fresh `reasons: []` array, silently under-reporting why a rule
   almost matched — contrary to this module's own "explanatory reasons for
   every rule tried" contract. Fixed: keeps the accumulated reasons.
3. **gigs.ts `setRankBucket()` had a real read-modify-write race.** Two
   concurrent confirm/override writes (or a confirm racing a rescan) could
   silently drop one write. Fixed: wrapped in `withTransaction()`.
4. **schema.ts had no "all" collision guard.** dashboard-client.tsx's shared
   "select" filterKind uses the literal string `"all"` as its reserved
   "no filter" sentinel — an owner-named bucket literally called "All" would
   have been unselectable/misinterpreted as "clear filter." Fixed: added a
   `.refine()` on `RankBucketRuleSchema.label` rejecting "all" (case-
   insensitive), plus a matching client-side check in rank-bucket-client.tsx.
5. **schema.ts had no duplicate-label guard.** Two buckets with the same name
   in one group produce a duplicate React key and an ambiguous `<select>`
   value. Fixed: added an array-level `.refine()` on `GroupConfigSchema.
   rankBuckets` plus a matching client-side check in rank-bucket-client.tsx's
   `handleSave()`.
6. **rank-bucket-client.tsx's numeric validation was weaker than the schema.**
   `Number.isFinite()` alone lets a negative rate through, but
   `RankBucketRuleSchema` requires `.min(0)` — a save that passed client
   validation could still fail server-side with a confusing generic error.
   Fixed: client check now also rejects negative min/max rate.
7. **dashboard-client.tsx's Rank Bucket column `onChange` was a bare `void`
   call.** No `startTransition`/`isPending`/error surfacing, unlike the
   adjacent `handleStatusChange` convention — a failed confirm/override write
   (e.g. a stale bucket name after a concurrent config edit) failed silently.
   Fixed: added `handleRankBucketChange()` mirroring `handleStatusChange()`
   exactly (pending-disabled select, inline error row).
8. **Primary-group resolution was a client-side, per-gig guess.**
   `resolvePrimaryRankBucketGroupId()` picked `Object.keys(gig.
   matchedRankBuckets)[0]` — wrong if the primary group has no rankBuckets
   configured but a secondary one does, and JS object key enumeration for
   integer-like keys doesn't reliably reflect insertion order anyway. Fixed:
   added `dashboard-data.ts`'s `resolvePrimaryGroupId(rawConfig)` (same
   `groups[0].id` convention every other unscoped-route extractor already
   uses), resolved server-side and threaded down as an explicit
   `rankBucketGroupId` prop into `TodayClient`/`DashboardClient`. Removed
   `resolvePrimaryRankBucketGroupId()` entirely; `resolveDisplayRankBucket()`
   no longer guesses when no groupId is given — it just returns `undefined`.

## Deferred (real, but knowingly out of scope tonight)

9. **`confirmRankBucketAction()` has no server-side validation that
   `bucket`/`groupId` match the current config.** A stale client (config
   edited in another tab, or the label renamed/removed between page load and
   the confirm click) could write a bucket name no longer in
   `GroupConfig.rankBuckets`, or a groupId that no longer exists. Deferred:
   gigradar is a single-user, local-only app with no adversarial multi-tenant
   threat model here — the worst case is a stale label sitting in
   `matched_rank_buckets` until the next rescan or manual re-confirm
   overwrites it, never a security or data-integrity issue. Real gap, low
   priority.
10. **The Rank Bucket column's `accessorFn` collapses "no assignment yet"
    (`undefined`) and "explicitly unassigned" (`bucket: null`) into the same
    empty string / "Unassigned" option.** Deferred as a non-issue: no UI
    anywhere in this feature currently distinguishes those two states (the
    `<select>`'s own "Unassigned" option already means both), so collapsing
    them isn't a regression against any existing behavior — just a
    conceivable future distinction nobody has asked for.

All fixes verified: full suite (1562 tests) + typecheck clean, isolated
dev-server curl regression pass across key routes.
