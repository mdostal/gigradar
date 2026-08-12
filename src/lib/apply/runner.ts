import type { Config, Gig, MatchResult } from "../types.js";
import { getSource } from "../sources/source.js";
import { gate } from "../matching/gate.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "../matching/tiering.js";
import { gigKey, recordScan } from "../store/index.js";
import type { RecordScanOptions, SourceScanBatch } from "../store/index.js";
import { loadConfig } from "../config/load.js";

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
 * gate's hard constraints. config.roleArea is optional; when the user hasn't
 * configured one, EMPTY_ROLE_AREA_CONFIG makes every gig tier YELLOW rather
 * than erroring. The tier is stamped onto the persisted Gig (gig.tier) so it
 * survives the trip through the store — see Gig.tier's doc in ../types.ts.
 *
 * `storeOpts` forwards straight to recordScan() (db/now overrides) — tests
 * use it to point at a temp database instead of the process-wide default.
 */
export async function runRadar(
  config: Config,
  storeOpts: RecordScanOptions = {},
): Promise<{
  results: MatchResult[];
  passed: MatchResult[];
  errors: { sourceId: string; message: string }[];
}> {
  const results: MatchResult[] = [];
  const errors: { sourceId: string; message: string }[] = [];
  const batches: SourceScanBatch[] = [];

  for (const sc of config.sources.filter((s) => s.enabled)) {
    const src = getSource(sc.id);
    if (!src) { errors.push({ sourceId: sc.id, message: "no such registered source" }); continue; }
    let gigs: Gig[] = [];
    try {
      gigs = await src.fetch(sc, config.profile);
    } catch (e) {
      // A source that needs login throws — report it, don't fake zero results.
      // Crucially: do NOT push a batch for it either, so recordScan can tell
      // "errored" apart from "ran, found zero" (see store/gigs.ts recordScan doc).
      errors.push({ sourceId: sc.id, message: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // Dedup this source's own fetch by key (defends against a single fetch
    // call returning the same externalId twice) before gating and persisting.
    const seenInBatch = new Set<string>();
    const deduped: Gig[] = [];
    for (const g of gigs) {
      const key = gigKey(g.sourceId, g.externalId);
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);

      const gateResult = gate(g, config.needs, config.profile);
      const tierResult = tier(g, config.roleArea ?? EMPTY_ROLE_AREA_CONFIG);
      // Stamp the tier onto the persisted gig (not the original `g`, so a
      // caller's own Gig object is never mutated) — this is the object that
      // both the batch and the returned MatchResult reference, so the store
      // and the in-memory result agree on the same tier.
      const gigWithTier: Gig = { ...g, tier: tierResult.tier };

      deduped.push(gigWithTier);
      results.push({
        ...gateResult,
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
  if (batches.length > 0) recordScan(batches, storeOpts);

  const passed = results.filter((r) => r.pass).sort((a, b) => b.score - a.score);
  return { results, passed, errors };
}

/**
 * ASSISTED apply — the "runs the apps with them" layer. This intentionally
 * does NOT blast auto-submissions. It stages a per-gig application draft
 * (answers keyed to the user's profile) for review, mirroring the human-in-
 * the-loop model. Wiring an LLM/agent to draft the answers goes here; the
 * user always approves before anything is submitted.
 *
 * TODO(build): draft(gig, profile) -> ApplicationDraft; queue for review.
 */
export interface ApplicationDraft {
  gig: Gig;
  fields: Record<string, string>;
  status: "draft" | "approved" | "submitted";
}
export async function stageApplication(_r: MatchResult): Promise<ApplicationDraft> {
  throw new Error("not implemented — assisted-apply drafting goes here (human approves before submit)");
}

// CLI entrypoint: `npm run radar` — loads the user's local config, runs one
// scan, prints the shortlist (passers) and any per-source errors. This was
// previously an unimplemented stub (runRadar() existed and was fully tested,
// but nothing ever actually called it from the CLI) — found and fixed while
// producing a real, populated screenshot of the dashboard for the project's
// GitHub Pages site; `npm run radar` had silently done nothing since the
// project's first epic.
async function main(): Promise<void> {
  // Registering every built-in source's side-effecting registerSource() call
  // — runRadar() only ever looks sources up by id (getSource()), so without
  // this the registry is empty and every configured source would report "no
  // such registered source" no matter what's in config.json. Deliberately
  // done here (inside main(), the CLI-only path), NOT as a top-level import
  // of this module: runner.test.ts imports runRadar() directly and registers
  // its own network-free test doubles under the SAME ids (e.g. "braintrust")
  // — a top-level import here would load the real adapters into that same
  // test process and crash on "duplicate source id".
  await Promise.all([
    import("../sources/braintrust.js"),
    import("../sources/builtin.js"),
    import("../sources/gofractional.js"),
    import("../sources/ateam.js"),
  ]);

  const config = loadConfig();
  const { passed, errors } = await runRadar(config);

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
