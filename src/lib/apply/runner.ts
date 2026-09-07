import type { Config, DraftContent, Gig, MatchResult, RankBucketAssignment, SourceConfig } from "../types.js";
import { resolveLlmCredential, type LlmCredential } from "../config/env-store.js";
import { getSource, type Source } from "../sources/source.js";
import { VerificationChallengeError } from "../sources/verification-challenge.js";
import { customLlmSource } from "../sources/custom-llm-source.js";
import { gmailDigestSource } from "../sources/gmail-digest-source.js";
import { registerAllSources } from "../sources/register-all.js";
import { gate } from "../matching/gate.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "../matching/tiering.js";
import { matchGroups } from "../matching/group-match.js";
import { computeTier } from "../matching/score-tiering.js";
import { applyAiVerification } from "../matching/ai-verify.js";
import { assignRankBucket } from "../matching/rank-bucket.js";
import { applyRankBucketAiOverlay, ruleOnlyRankBucketAssignment } from "../matching/rank-bucket-ai-overlay.js";
import { gigKey, listGroupScores, recordScan, saveDraft } from "../store/index.js";
import type { DbOption, RecordScanOptions, SourceScanBatch } from "../store/index.js";
import { loadConfig } from "../config/load.js";
import { generateDraft, resolveApplicationFormat } from "./draft.js";

/**
 * scan-pipeline-per-source-timeout story (usability-and-completeness-audit
 * epic, triage t-001, p0/critical): the per-source budget every
 * `src.fetch()` call in the loop below is raced against. Live-confirmed
 * root cause (see this story's progress_note): NONE of the plain-`fetch()`
 * sources (`builtin`, `linkedin`, `fractionus`, `fractionaljobs`,
 * `fractionalfinders`, `braintrust`) pass an `AbortSignal` to `fetch()` —
 * a controlled local reproduction (a TCP server that accepts the
 * connection and never responds) proved a bare Node `fetch()` with no
 * signal simply never settles, matching the real 60+ minute production
 * hangs exactly (no child Chrome process was ever spawned during either
 * hang, ruling out the browser-automation sources).
 *
 * 60s: long enough that a genuinely slow browser-automation source
 * (wellfound/gofractional/ateam — real page loads, login flows, bot-
 * detection waits) isn't false-positive-killed on an ordinary slow cycle,
 * short enough that one hung source costs at most 60s of one scan cycle
 * instead of blocking every source after it forever. Deliberately a
 * `Promise.race` at THIS call site (not threaded into every adapter's own
 * `fetch()` via `AbortSignal`) per this story's own design_decisions: one
 * shared boundary fix across all 10 registered sources, zero changes to
 * any individual adapter.
 */
const SOURCE_FETCH_TIMEOUT_MS = 60_000;

/**
 * rank-bucket-ai-overlay-timeout-and-cap story (triage t-002, p1/major):
 * even with RANK_BUCKET_AI_OVERLAY_TIMEOUT_MS bounding each individual
 * `applyRankBucketAiOverlay()` call (rank-bucket-ai-overlay.ts), the
 * per-gig loop below calls it once per (gig, rankBuckets-configured,
 * opted-in group) pair for EVERY gig a source returns this cycle -- live
 * process inspection found this is what actually ran a real cycle 12+
 * minutes past its cron tick (a fresh `claude` CLI subprocess roughly
 * every 10-15s, one after another, with no cap at all). A per-call
 * timeout alone still lets the AGGREGATE cost scale unboundedly with
 * however many green/yellow gigs a cycle happens to see.
 *
 * Mirrors this codebase's existing `AUTO_DRAFT_CAP` precedent
 * (scheduler/index.ts) -- a fixed, non-configurable, exported per-cycle
 * ceiling on how many real LLM calls one stage of the pipeline can make,
 * with the SAME "gigs beyond the cap just don't get this stage this
 * cycle, and self-heal on a later scan once still green/yellow" posture
 * (see `runAutoDraft()`'s own doc comment in scheduler/index.ts).
 *
 * 10, not AUTO_DRAFT_CAP's 5: this cap only ever counts a call that would
 * ACTUALLY invoke the AI (`group.rankBucketAiOverlay === true` AND a
 * credential resolved this cycle -- see the call site below), and each
 * call is a single small structured-output classification, cheaper than
 * `stageApplication()`'s full draft-generation LLM call that
 * AUTO_DRAFT_CAP bounds. Worst case (every one of the 10 calls actually
 * hits RANK_BUCKET_AI_OVERLAY_TIMEOUT_MS's 20s deadline rather than
 * completing normally): 10 * 20s = 200s (~3.3min) added to a cycle --
 * still a small, BOUNDED addition instead of the unbounded tens-of-
 * minutes this story exists to fix. Normal case, going by this story's
 * own live-observed ~10-15s per real call: roughly 100-150s added, well
 * under the deliberately-shorter-than-a-typical-cron-tick budget this
 * fix targets.
 */
export const RANK_BUCKET_AI_OVERLAY_CAP = 10;

/**
 * ai-verify-timeout-and-cap story (triage t-003, p1/major): the IDENTICAL
 * unbounded-aggregate-cost risk `RANK_BUCKET_AI_OVERLAY_CAP` above exists
 * to bound, for `matching/ai-verify.ts`'s `applyAiVerification()` call
 * below -- a real claude-CLI/LLM call made per (gig, aiVerify-opted-in
 * group) pair, from the SAME per-gig loop, with `AI_VERIFY_TIMEOUT_MS`
 * (ai-verify.ts) bounding each individual call but not the aggregate.
 * Flagged by the developer who fixed t-002 and confirmed live/active:
 * BOTH of the owner's real groups (`fractional-hourly`, `full-time`) have
 * `aiVerify: true` today.
 *
 * Same value as `RANK_BUCKET_AI_OVERLAY_CAP` (10), for the same reasons:
 * this cap only ever counts a call that would ACTUALLY invoke the AI
 * (`group.aiVerify === true` AND a credential resolved this cycle -- the
 * same condition `applyAiVerification()` itself checks before calling
 * out), each call is a single small structured-output classification (the
 * same shape of call `RANK_BUCKET_AI_OVERLAY_CAP`'s own calls are, per
 * `AI_VERIFY_TIMEOUT_MS`'s own doc comment in ai-verify.ts), and the two
 * caps bound two independently-configured, potentially-simultaneously-hit
 * pipeline stages -- there's no shared reasoning for picking a different
 * number for one over the other absent a distinct observed cost profile,
 * which doesn't exist here (same call shape, same 20s per-call timeout).
 * Worst case (all 10 calls hit the 20s timeout): the same 200s (~3.3min)
 * addition `RANK_BUCKET_AI_OVERLAY_CAP`'s own doc comment above computes.
 *
 * The counter this cap bounds (`aiVerifyCallsThisCycle`, declared below)
 * is passed into `applyAiVerification()` as a remaining-budget number
 * rather than checked inline in this loop like `RANK_BUCKET_AI_OVERLAY_CAP`
 * is -- see `applyAiVerification()`'s own doc comment in ai-verify.ts for
 * why (that function's per-gig call internally loops over every matched,
 * opted-in group itself, unlike the rank-bucket overlay's per-(gig,group)
 * call site directly in this loop).
 */
export const AI_VERIFY_CAP = 10;

/** Thrown by {@link fetchWithTimeout} when `SOURCE_FETCH_TIMEOUT_MS` elapses before `src.fetch()` settles — distinguishable from a real thrown error (never confused with e.g. a bad-login `Error` in the catch block below) by its own `name` and a message that always contains "timed out after". */
export class SourceFetchTimeoutError extends Error {
  constructor(sourceId: string, timeoutMs: number) {
    super(`source "${sourceId}" timed out after ${timeoutMs}ms`);
    this.name = "SourceFetchTimeoutError";
  }
}

/**
 * Races `src.fetch()` against a deadline so a source whose promise never
 * settles (never resolves, never rejects) can't block the sequential loop
 * in `runRadar()` forever. The timeout's own `setTimeout` handle is always
 * cleared in `finally` — including on the timeout-wins branch, where the
 * still-pending `src.fetch()` promise is simply abandoned (never awaited
 * again) rather than cancelled; nothing here assumes adapters support
 * cancellation. Exported for this story's own regression test.
 */
export async function fetchWithTimeout(
  src: Pick<Source, "id" | "fetch">,
  cfg: SourceConfig,
  profile: Config["profile"],
  credential: LlmCredential | undefined,
  timeoutMs: number = SOURCE_FETCH_TIMEOUT_MS,
): Promise<Gig[]> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceFetchTimeoutError(src.id, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([src.fetch(cfg, profile, credential), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * One radar run: for every enabled source, fetch -> gate -> tier -> collect,
 * then persist the scan (and run delisting detection) via the store's
 * recordScan(). Returns every result (passers AND rejections-with-reasons)
 * so nothing is silently dropped. This is the primitive a cron or the /api
 * route calls.
 *
 * tier() runs after gate() for every gig, independent of pass/fail — a
 * rejected gig still gets a GREEN/YELLOW/RED role-area classification, since
 * tiering answers a different question ("is this my kind of role?") than the
 * gate's hard constraints. A group's roleArea is optional; when unset,
 * EMPTY_ROLE_AREA_CONFIG makes every gig tier YELLOW for that group rather
 * than erroring. The tier is stamped onto the persisted Gig (gig.tier) so it
 * survives the trip through the store — see Gig.tier's doc in ../types.ts.
 *
 * multi-group-architecture epic: every gig also gets evaluated against
 * EVERY one of the owner's configured Config.groups that this source is in
 * scope for (SourceConfig.groupIds, default: every group) — see
 * matching/group-match.ts's matchGroups(). Gig.matchedGroupIds/
 * matchedGroupTiers carry that full per-group picture; the flat
 * Gig.tier/matchedProfileIds fields (and this function's own MatchResult.
 * pass/reasons/score) stay anchored to the FIRST in-scope group for
 * backward compatibility — byte-identical to pre-multi-group behavior for
 * a not-yet-multi-group install, which has exactly one group.
 *
 * `storeOpts` forwards straight to recordScan() (db/now overrides) — tests
 * use it to point at a temp database instead of the process-wide default.
 *
 * `runOpts.credential` (llm-custom-sources epic; widened from a raw
 * `anthropicApiKey` string by llm-provider-harness's
 * custom-llm-source-credential-migration story): forwarded as `fetch()`'s
 * optional 3rd argument to EVERY source uniformly — every hand-written
 * adapter ignores it (see source.ts's `fetch()` doc comment); only
 * `kind: "custom-llm"`/`kind: "gmail-digest"` sources (routed to
 * `customLlmSource`/`gmailDigestSource` below) read it. Resolved by the
 * CALLER (CLI `main()`/the scheduler/agent-chat-loop.ts's run_scan tool),
 * never module-scope — same discipline `stageApplication()`'s own
 * `credential` parameter already established.
 */
export async function runRadar(
  config: Config,
  storeOpts: RecordScanOptions = {},
  runOpts: { credential?: LlmCredential } = {},
): Promise<{
  results: MatchResult[];
  passed: MatchResult[];
  /**
   * `needsVerification`/`blockedUrl` (verification-copilot epic): set ONLY
   * when the caught error was a `VerificationChallengeError` — checked
   * HERE, where the real thrown error object is still available, before
   * it's flattened to a plain message string below. A caller (the
   * scheduler's raiseIssue() loop) reads these to route this failure to a
   * distinctly-titled issue instead of the generic "Source fetch failed."
   */
  errors: { sourceId: string; message: string; needsVerification?: boolean; blockedUrl?: string }[];
  /**
   * Store keys (gigKey(sourceId, externalId)) that were BRAND NEW this run
   * — recordScan()'s own `upserted[].inserted` signal, surfaced here so a
   * caller (the scheduler's notify-on-green-match story) can tell "just
   * discovered this cycle" apart from "already existed, re-seen." Empty
   * when every enabled source errored (recordScan() never ran).
   */
  newlyInsertedKeys: string[];
}> {
  const results: MatchResult[] = [];
  const errors: { sourceId: string; message: string; needsVerification?: boolean; blockedUrl?: string }[] = [];
  const batches: SourceScanBatch[] = [];
  // rank-bucket-ai-overlay-timeout-and-cap story: counts only calls that
  // actually invoke the AI (see the call site below) — local to one
  // runRadar() invocation (one scan cycle), never module-scope state, so
  // concurrent/sequential test runs and separate cycles never leak into
  // each other.
  let rankBucketAiOverlayCallsThisCycle = 0;
  // ai-verify-timeout-and-cap story: same "local to one runRadar()
  // invocation, never module-scope state" discipline as
  // rankBucketAiOverlayCallsThisCycle above, for the SAME reasons.
  let aiVerifyCallsThisCycle = 0;

  for (const sc of config.sources.filter((s) => s.enabled)) {
    // llm-custom-sources epic: a kind:"custom-llm" source is NEVER in the
    // static registerSource() registry (its id is whatever the owner typed
    // in, e.g. "monster") — see design-discussion.md §3 for why this ONE
    // fallback line (not dynamic registerSource() calls, not codegen) is
    // the chosen mechanism, and custom-llm-source.ts's own header comment.
    // email-digest-ingestion epic extends the SAME fallback chain a
    // second time for kind:"gmail-digest" — not a second, parallel
    // mechanism.
    const src =
      getSource(sc.id) ??
      (sc.kind === "custom-llm" ? customLlmSource : sc.kind === "gmail-digest" ? gmailDigestSource : undefined);
    if (!src) { errors.push({ sourceId: sc.id, message: "no such registered source" }); continue; }
    let gigs: Gig[] = [];
    try {
      // scan-pipeline-per-source-timeout story: raced against a 60s
      // deadline (see fetchWithTimeout's own doc comment above) so a
      // source whose fetch() never settles can't block every source after
      // it in this loop forever — see this story's progress_note for the
      // live-confirmed hang this fixes.
      gigs = await fetchWithTimeout(src, sc, config.profile, runOpts.credential);
    } catch (e) {
      // A source that needs login throws — report it, don't fake zero results.
      // Crucially: do NOT push a batch for it either, so recordScan can tell
      // "errored" apart from "ran, found zero" (see store/gigs.ts recordScan doc).
      // A SourceFetchTimeoutError lands here too (thrown by the deadline
      // race, not by src.fetch() itself) and is handled identically to a
      // real thrown error — same errors[] entry shape, same "continue to
      // the next source" behavior, same downstream backoff.ts treatment —
      // just with its own distinguishable "timed out after Nms" message.
      if (e instanceof VerificationChallengeError) {
        errors.push({ sourceId: sc.id, message: e.message, needsVerification: true, blockedUrl: e.url });
      } else {
        errors.push({ sourceId: sc.id, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }

    // multi-group-architecture epic: which of the owner's configured
    // groups this source's gigs get evaluated against. Absent
    // SourceConfig.groupIds means every group — a source is shared across
    // every search unless deliberately scoped down. Resolved once per
    // source (not per gig) since it never varies within one source's batch.
    const scopedGroupIds = sc.groupIds ?? config.groups.map((grp) => grp.id);
    const scopedGroups = config.groups.filter((grp) => scopedGroupIds.includes(grp.id));
    // ai-match-verification epic: lookup for applyAiVerification() below,
    // built once per source (not per gig) since scopedGroups never varies
    // within one source's batch.
    const scopedGroupsById = new Map(scopedGroups.map((grp) => [grp.id, grp]));
    // The first in-scope group anchors this gig's BACKWARD-COMPATIBLE flat
    // tier/matchedProfileIds/reasons/score (Gig.tier, Gig.matchedProfileIds)
    // — for a not-yet-multi-group install (exactly one group, every source
    // scoped to it) this is byte-identical to pre-multi-group behavior. A
    // real multi-group install's per-group detail lives in
    // matchedGroupIds/matchedGroupTiers instead (see below), never lost.
    const primaryGroup = scopedGroups[0];

    // customizable-tier-scoring epic: for every in-scope group using
    // "percentile" tier scoring, pre-fetch the population of OTHER
    // currently-tracked gigs' scores ONCE per source (not per gig) — see
    // matching/score-tiering.ts's own header comment for why this read
    // happens here (the one impure call site) rather than inside the pure
    // matchGroups()/computeTier() pipeline. A group not using percentile
    // mode never gets a DB query.
    const scorePopulations: Record<string, number[]> = {};
    for (const grp of scopedGroups) {
      if (grp.tierScoring?.kind === "percentile") {
        scorePopulations[grp.id] = listGroupScores(grp.id, storeOpts);
      }
    }

    // Dedup this source's own fetch by key (defends against a single fetch
    // call returning the same externalId twice) before gating and persisting.
    const seenInBatch = new Set<string>();
    const deduped: Gig[] = [];
    for (const g of gigs) {
      const key = gigKey(g.sourceId, g.externalId);
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);

      const gateResult = primaryGroup
        ? gate(g, primaryGroup.needs, config.profile, primaryGroup.roleArea)
        : { gig: g, pass: false, reasons: ["no group in scope for this source"], score: 0, matchedProfiles: [] };
      const { matchedGroupIds: heuristicMatchedGroupIds, groupTiers, groupScores, groupBands, groupProfileIds } = matchGroups(g, scopedGroups, config.profile, scorePopulations);
      // ai-match-verification epic: a second, LLM-driven check, spent only
      // on groups the heuristic ALREADY matched and that opted in via
      // GroupConfig.aiVerify — see matching/ai-verify.ts's header comment.
      // No-op (matchedGroupIds/aiFlags pass through unchanged) when no
      // group in scope has aiVerify on, or no LLM credential resolved this
      // cycle — byte-identical to before this feature existed either way.
      // ai-verify-timeout-and-cap story (triage t-003): the remaining
      // AI_VERIFY_CAP budget for this cycle is passed in so
      // applyAiVerification()'s own per-group loop stops calling out once
      // it's exhausted (see that function's own doc comment for why the
      // cap check lives there rather than here, unlike
      // RANK_BUCKET_AI_OVERLAY_CAP's below) — `callsMade` reports back how
      // many real calls it actually made, so this cycle's running counter
      // stays accurate across every gig/source this loop still has left.
      const { matchedGroupIds, aiFlags, callsMade: aiVerifyCallsMade } = await applyAiVerification(
        g,
        heuristicMatchedGroupIds,
        scopedGroupsById,
        config.profile,
        config.applyProfile,
        runOpts.credential,
        Math.max(0, AI_VERIFY_CAP - aiVerifyCallsThisCycle),
      );
      aiVerifyCallsThisCycle += aiVerifyCallsMade ?? 0;
      // The flat/legacy Gig.tier stays anchored to the primary group's OWN
      // tier result (customizable-tier-scoring epic: respects that group's
      // own tierScoring mode now, not always the keyword classifier) —
      // EMPTY_ROLE_AREA_CONFIG's "yellow" default when there's no primary
      // group at all. Reuses groupScores[primaryGroup.id] (already
      // computed by matchGroups() above) rather than a third gate() call.
      const primaryTierResult =
        primaryGroup && primaryGroup.tierScoring && primaryGroup.tierScoring.kind !== "keyword"
          ? computeTier(groupScores[primaryGroup.id]!, primaryGroup.tierScoring, scorePopulations[primaryGroup.id] ?? [])
          : tier(g, primaryGroup?.roleArea ?? EMPTY_ROLE_AREA_CONFIG);
      // ai-verify-tier-integration story (config-rebuild-and-match-quality
      // epic): applyAiVerification()'s verdict used to be computed and
      // persisted (aiFlags, ai_flags DB column) but never actually
      // affected flatTier or reached the UI anywhere — confirmed live
      // this session ("This is supposed to have multiple levels and an AI
      // assistant on top to help sort and it seems that is not happening
      // at all," owner's own words). Real fix, scoped to match
      // ai-verify.ts's own stated philosophy ("never a replacement for
      // [the heuristic]"): a GREEN match the AI explicitly rejected
      // (confirmed: false) downgrades to YELLOW — still visible, still
      // reviewable, never silently hidden or hard-rejected — with the
      // model's own reason appended to flatReasons so it shows up
      // wherever reasons already render. yellow/red are left untouched
      // (nothing to downgrade to; the badge/tooltip in dashboard-client.tsx
      // still surfaces the AI's reason regardless of tier).
      const primaryAiFlag = primaryGroup ? aiFlags[primaryGroup.id] : undefined;
      const aiDowngraded = primaryAiFlag?.confirmed === false && primaryTierResult.tier === "green";
      const flatTier = aiDowngraded ? "yellow" : primaryTierResult.tier;
      const flatReasons = aiDowngraded
        ? [...primaryTierResult.reasons, `⚠ AI verification: ${primaryAiFlag!.reason} (downgraded green → yellow)`]
        : primaryTierResult.reasons;
      const flatScore = primaryGroup ? groupScores[primaryGroup.id]! : gateResult.score;
      // rate-band-match-quality epic: same primary-group-anchoring
      // convention as flatTier/flatScore above -- "out-of-band" (not
      // undefined) when there's no primary group at all, since nothing
      // configured means nothing can be in-band, mirroring gateResult's
      // own fail-closed default in that same no-primary-group case above.
      const flatMatchBand = primaryGroup ? groupBands[primaryGroup.id]! : "out-of-band";
      // rank-buckets epic: only groups that actually have rankBuckets
      // configured get an entry -- same sparse-entry convention aiFlags
      // already uses (a group with nothing to check has no entry at all,
      // never a fabricated "unassigned" placeholder). Runs the rule-based
      // evaluator (rank-bucket.ts) then the opt-in AI overlay
      // (rank-bucket-ai-overlay.ts) for each, per group.
      const matchedRankBuckets: Record<string, RankBucketAssignment> = {};
      for (const group of scopedGroups) {
        if (!group.rankBuckets || group.rankBuckets.length === 0) continue;
        const ruleResult = assignRankBucket(g, group.rankBuckets);
        // rank-bucket-ai-overlay-timeout-and-cap story (triage t-002):
        // this call would actually spawn a real claude-CLI subprocess only
        // when the group opted in AND a credential resolved this cycle —
        // the SAME condition applyRankBucketAiOverlay() itself checks
        // before calling out (rank-bucket-ai-overlay.ts). Only THAT case
        // counts against RANK_BUCKET_AI_OVERLAY_CAP; a call that would be
        // a free no-op anyway never spends cap budget for nothing.
        const wouldCallAi = group.rankBucketAiOverlay === true && runOpts.credential !== undefined;
        if (wouldCallAi && rankBucketAiOverlayCallsThisCycle >= RANK_BUCKET_AI_OVERLAY_CAP) {
          // Over the per-cycle cap: keep the rule-based result for THIS
          // cycle rather than spawning another subprocess — no data loss,
          // this gig is picked up by the AI overlay on a later scan once
          // it's still green/yellow and re-scanned (same self-heals
          // pattern this codebase already uses elsewhere — see
          // RANK_BUCKET_AI_OVERLAY_CAP's own doc comment above).
          matchedRankBuckets[group.id] = ruleOnlyRankBucketAssignment(ruleResult);
          continue;
        }
        if (wouldCallAi) rankBucketAiOverlayCallsThisCycle += 1;
        matchedRankBuckets[group.id] = await applyRankBucketAiOverlay(g, group, ruleResult, runOpts.credential);
      }
      // Same primary-group-anchoring convention as flatTier/flatMatchBand
      // above -- undefined (not a fabricated default) when the primary
      // group has no rankBuckets configured at all.
      const flatRankBucket = primaryGroup ? matchedRankBuckets[primaryGroup.id] : undefined;
      // Stamp tier + matchedProfileIds/matchedGroupIds/matchedGroupTiers
      // onto the persisted gig (not the original `g`, so a caller's own
      // Gig object is never mutated) — this is the object that both the
      // batch and the returned MatchResult reference, so the store and the
      // in-memory result agree on all of it.
      const gigWithTier: Gig = {
        ...g,
        tier: flatTier,
        matchedProfileIds: gateResult.matchedProfiles,
        matchedGroupIds,
        matchedGroupTiers: groupTiers,
        matchScore: flatScore,
        matchedGroupScores: groupScores,
        matchBand: flatMatchBand,
        matchedGroupBands: groupBands,
        matchedGroupProfileIds: groupProfileIds,
        ...(Object.keys(aiFlags).length > 0 ? { aiFlags } : {}),
        ...(Object.keys(matchedRankBuckets).length > 0 ? { matchedRankBuckets } : {}),
        ...(flatRankBucket ? { rankBucket: flatRankBucket } : {}),
      };

      deduped.push(gigWithTier);
      results.push({
        ...gateResult,
        // "pass" reflects whether this gig cleared ANY in-scope group, not
        // just the primary one — the auto-draft/notify-on-green-match
        // consumers of RunRadar()'s own `passed` list must react to a real
        // match in ANY of the owner's groups, not just whichever happens
        // to be first. Byte-identical to before for a single-group install
        // (there IS only one group to check).
        pass: matchedGroupIds.length > 0,
        gig: gigWithTier,
        tier: flatTier,
        matchBand: flatMatchBand,
        reasons: [...gateResult.reasons, ...flatReasons],
      });
    }
    // Always add a batch for a source whose fetch succeeded — even an
    // explicit empty one — so recordScan sees "ran, found zero" rather than
    // treating it the same as a source that never ran at all.
    batches.push({ sourceId: sc.id, gigs: deduped });
  }

  // Persist the scan + run delisting detection. Skipped when every enabled
  // source errored (nothing to record, no DB connection needs opening).
  const newlyInsertedKeys =
    batches.length > 0 ? recordScan(batches, storeOpts).upserted.filter((u) => u.inserted).map((u) => u.key) : [];

  const passed = results.filter((r) => r.pass).sort((a, b) => b.score - a.score);
  return { results, passed, errors, newlyInsertedKeys };
}

/**
 * ASSISTED apply — the "runs the apps with them" layer. This intentionally
 * does NOT blast auto-submissions. It stages a per-gig application draft
 * (a real, LLM-generated cover message + any structured answers, grounded
 * in the user's own `Profile`/`Config.applyProfile`) for review, mirroring
 * the human-in-the-loop model — the user always approves before anything is
 * submitted. `draft-generation-foundation` story, `assisted-apply-drafting`
 * epic.
 */
export interface ApplicationDraft {
  gig: Gig;
  content: DraftContent;
  status: "draft";
}

/**
 * Stages a real application draft for `r.gig` and persists it (status
 * `"draft"`) via `saveDraft()`. Two guardrails fire BEFORE any LLM call is
 * made, in this order:
 *
 * 1. `r.tier === "red"` — a minimal, common-sense guardrail (never spend a
 *    real LLM call drafting for a gig the tiering system already flagged as
 *    clearly off-target). Green and yellow are both draftable; this is
 *    deliberately narrower than the full 4-check gate reserved for the
 *    later auto-fire epic (see design_decisions in this story's YAML).
 * 2. `config.applyProfile` unset — `generateDraft()` needs real contact/
 *    apply fields to draft anything meaningful; rather than attempt a
 *    degraded draft with garbled/missing fields, this throws a specific,
 *    actionable error pointing at `/config` (this project's established
 *    "throw loud, don't silently degrade" convention).
 *
 * `credential` is a REQUIRED parameter, resolved by the CALLER (matching
 * `generateDraft()`'s own real shape — see draft.ts's header comment) —
 * this function never reads `process.env` or holds a module-scope client
 * itself; it only ever forwards `credential` straight through to
 * `generateDraft()`.
 */
export async function stageApplication(
  r: MatchResult,
  config: Config,
  credential: LlmCredential,
  storeOpts: DbOption = {},
  resumeId?: string,
): Promise<ApplicationDraft> {
  if (r.tier === "red") {
    throw new Error(
      `gigradar apply: cannot draft an application for "${r.gig.title}" — its role-area tier is "red" ` +
        "(flagged clearly off-target); drafting is restricted to green/yellow-tier gigs.",
    );
  }
  if (!config.applyProfile) {
    throw new Error(
      "gigradar apply: no apply profile configured. Set up your apply profile in /config before generating a draft.",
    );
  }

  const format = resolveApplicationFormat(r.gig, config);
  // resume-store-multi-resume-and-tailoring story: `resumeId` selects which
  // of `config.applyProfile.resumes` this draft is grounded in -- omitted
  // falls back to generateDraft()'s own default (the first stored resume),
  // preserving the old single-resume behavior byte-for-byte. The resume
  // actually used (if any) rides through on `content.resumeId`.
  const content = await generateDraft(r.gig, config.profile, config.applyProfile, credential, format, resumeId);
  saveDraft(gigKey(r.gig.sourceId, r.gig.externalId), content, storeOpts);

  return { gig: r.gig, content, status: "draft" };
}

// CLI entrypoint: `npm run radar` — loads the user's local config, runs one
// scan, prints the shortlist (passers) and any per-source errors. This was
// previously an unimplemented stub (runRadar() existed and was fully tested,
// but nothing ever actually called it from the CLI) — found and fixed while
// producing a real, populated screenshot of the dashboard for the project's
// GitHub Pages site; `npm run radar` had silently done nothing since the
// project's first epic.
async function main(): Promise<void> {
  // runner-registry-and-sidecar-lifecycle epic: shared with scheduler/
  // index.ts (and, now, src/app/issues/actions.ts's retrySourceAction) via
  // register-all.ts — see that file's own doc comment for why this must
  // stay a dynamic-import call inside a function, never a static top-level
  // import of this module.
  await registerAllSources();

  const config = loadConfig();
  const { passed, errors } = await runRadar(config, {}, { credential: resolveLlmCredential() });

  if (errors.length > 0) {
    console.error(`gigradar: ${errors.length} source(s) errored:`);
    for (const e of errors) console.error(`  - ${e.sourceId}: ${e.message}`);
  }

  console.log(`gigradar: ${passed.length} gig(s) passed the gate.`);
  for (const r of passed) {
    console.log(`  [${r.tier ?? "yellow"}] ${r.gig.title} — ${r.gig.company ?? "?"} (${r.gig.sourceId})`);
  }
}

// Only run when invoked directly (`npm run radar`), not when imported by
// tests or other modules that just need runRadar()/stageApplication().
if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  main().catch((e) => {
    console.error("gigradar: fatal error running radar:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
