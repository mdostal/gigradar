import type { Config, DraftContent, Gig, MatchResult } from "../types.js";
import { resolveLlmCredential, type LlmCredential } from "../config/env-store.js";
import { getSource } from "../sources/source.js";
import { VerificationChallengeError } from "../sources/verification-challenge.js";
import { customLlmSource } from "../sources/custom-llm-source.js";
import { gmailDigestSource } from "../sources/gmail-digest-source.js";
import { registerAllSources } from "../sources/register-all.js";
import { gate } from "../matching/gate.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "../matching/tiering.js";
import { matchGroups } from "../matching/group-match.js";
import { applyAiVerification } from "../matching/ai-verify.js";
import { gigKey, recordScan, saveDraft } from "../store/index.js";
import type { DbOption, RecordScanOptions, SourceScanBatch } from "../store/index.js";
import { loadConfig } from "../config/load.js";
import { generateDraft } from "./draft.js";

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
      gigs = await src.fetch(sc, config.profile, runOpts.credential);
    } catch (e) {
      // A source that needs login throws — report it, don't fake zero results.
      // Crucially: do NOT push a batch for it either, so recordScan can tell
      // "errored" apart from "ran, found zero" (see store/gigs.ts recordScan doc).
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

    // Dedup this source's own fetch by key (defends against a single fetch
    // call returning the same externalId twice) before gating and persisting.
    const seenInBatch = new Set<string>();
    const deduped: Gig[] = [];
    for (const g of gigs) {
      const key = gigKey(g.sourceId, g.externalId);
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);

      const gateResult = primaryGroup
        ? gate(g, primaryGroup.needs, config.profile)
        : { gig: g, pass: false, reasons: ["no group in scope for this source"], score: 0, matchedProfiles: [] };
      const tierResult = tier(g, primaryGroup?.roleArea ?? EMPTY_ROLE_AREA_CONFIG);
      const { matchedGroupIds: heuristicMatchedGroupIds, groupTiers } = matchGroups(g, scopedGroups, config.profile);
      // ai-match-verification epic: a second, LLM-driven check, spent only
      // on groups the heuristic ALREADY matched and that opted in via
      // GroupConfig.aiVerify — see matching/ai-verify.ts's header comment.
      // No-op (matchedGroupIds/aiFlags pass through unchanged) when no
      // group in scope has aiVerify on, or no LLM credential resolved this
      // cycle — byte-identical to before this feature existed either way.
      const { matchedGroupIds, aiFlags } = await applyAiVerification(g, heuristicMatchedGroupIds, scopedGroupsById, runOpts.credential);
      // Stamp tier + matchedProfileIds/matchedGroupIds/matchedGroupTiers
      // onto the persisted gig (not the original `g`, so a caller's own
      // Gig object is never mutated) — this is the object that both the
      // batch and the returned MatchResult reference, so the store and the
      // in-memory result agree on all of it.
      const gigWithTier: Gig = {
        ...g,
        tier: tierResult.tier,
        matchedProfileIds: gateResult.matchedProfiles,
        matchedGroupIds,
        matchedGroupTiers: groupTiers,
        ...(Object.keys(aiFlags).length > 0 ? { aiFlags } : {}),
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
        tier: tierResult.tier,
        reasons: [...gateResult.reasons, ...tierResult.reasons],
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

  const content = await generateDraft(r.gig, config.profile, config.applyProfile, credential);
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
