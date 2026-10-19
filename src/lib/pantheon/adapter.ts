// gigradar's Pantheon adapter (pantheon-adapter story, PANT-1207): what
// src/app/api/pantheon/* serves. Trigger a radar run, read its status back,
// read the shortlist it produced — with the gate's reasons for every gig,
// passed and rejected — and stage (never submit) a draft.
//
// Like src/mcp/server.ts, this is a thin client of the exact src/lib
// functions the CLI and dashboard already use: runRadar() for the run (the
// same pipeline `npm run radar` drives), stageApplication() for a draft.
// Nothing here gates, tiers, scores, or rewrites a reason; a reason string
// reaches the caller byte-for-byte as runRadar() produced it.
//
// Assisted, not auto: this module deliberately imports nothing from
// src/lib/submit/ or src/lib/apply/autofire.ts, and never calls
// setDraftStatus()/markDraftSubmitting()/markDraftSubmitted(). A staged
// draft stays `draft` until a human approves it in /drafts. The
// no-submit-path test (__tests__/no-submit-path.test.ts) enforces this.
import { randomUUID } from "node:crypto";
import { runRadar, stageApplication } from "../apply/runner.js";
import { resolveLlmCredential } from "../config/env-store.js";
import { loadConfig } from "../config/load.js";
import { readRawConfig } from "../config/save.js";
import { ConfigSchema } from "../config/schema.js";
import { registerAllSources } from "../sources/register-all.js";
import {
  completeAdapterRun,
  createAdapterRun,
  failAdapterRun,
  getAdapterRun,
  getAdapterRunResult,
  getGig,
  getLatestAdapterRun,
  listAdapterRunResults,
  recordScanCycle,
} from "../store/index.js";
import type { StoredAdapterRun, StoredAdapterRunResult } from "../store/index.js";
import type { MatchResult } from "../types.js";
import { resolveRunSecrets, withInjectedEnv } from "./secrets.js";

export interface AdapterDeps {
  runRadarFn?: typeof runRadar;
  loadConfigFn?: typeof loadConfig;
  registerSourcesFn?: () => Promise<void>;
  resolveSecretsFn?: () => Promise<Record<string, string>>;
  stageApplicationFn?: typeof stageApplication;
  generateId?: () => string;
}

/** A failure the HTTP layer maps to a specific status, with a message safe to return. */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 502,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

// The one in-flight run, globalThis-pinned (same idiom as
// session-capture.ts) so an HMR re-evaluation can't forget a run that is
// still going and let a second one start beside it.
const g = globalThis as typeof globalThis & { __gigradarPantheonRun?: { id: string; done: Promise<void> } };

/** Test-only: the in-flight run's settle promise, so a test can await completion without polling. */
export function inFlightRun(): Promise<void> | undefined {
  return g.__gigradarPantheonRun?.done;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function executeRun(id: string, deps: AdapterDeps): Promise<void> {
  let sourcesTotal: number | undefined;
  try {
    const secrets = await (deps.resolveSecretsFn ?? resolveRunSecrets)();
    await (deps.registerSourcesFn ?? registerAllSources)();
    const config = withInjectedEnv(secrets, () => (deps.loadConfigFn ?? loadConfig)());
    sourcesTotal = config.sources.filter((s) => s.enabled).length;
    const { results, errors, newlyInsertedKeys } = await (deps.runRadarFn ?? runRadar)(
      config,
      {},
      { credential: resolveLlmCredential(secrets) },
    );
    // A Pantheon-triggered run is a real, complete cycle across every
    // enabled source, exactly like the dashboard's "Sweep now" — so it
    // feeds the same status strip.
    recordScanCycle({ sourcesTotal, incompleteSourceIds: errors.map((e) => e.sourceId) });
    completeAdapterRun(id, {
      sourcesTotal,
      results,
      newCount: newlyInsertedKeys.length,
      errors: errors.map((e) => ({
        sourceId: e.sourceId,
        message: e.message,
        ...(e.needsVerification ? { needsVerification: true } : {}),
      })),
    });
    if (errors.length > 0) {
      console.error(`gigradar pantheon run ${id}: ${errors.length} source(s) errored:`);
      for (const e of errors) console.error(`  - ${e.sourceId}: ${e.message}`);
    }
  } catch (e) {
    console.error(`gigradar pantheon run ${id} failed: ${message(e)}`);
    failAdapterRun(id, "failed", message(e), { sourcesTotal });
  }
}

/**
 * Starts a run in the background and returns its `running` row at once — a
 * real scan is network-bound and can take minutes, longer than a caller
 * should hold a request open. Only one run at a time: while one is in
 * flight this returns it with `started: false` instead of starting another.
 */
export function startRun(deps: AdapterDeps = {}): { run: StoredAdapterRun; started: boolean } {
  const current = g.__gigradarPantheonRun;
  if (current) {
    const run = getAdapterRun(current.id);
    if (run) return { run, started: false };
  }
  const id = (deps.generateId ?? randomUUID)();
  const run = createAdapterRun(id);
  const done = executeRun(id, deps).finally(() => {
    if (g.__gigradarPantheonRun?.id === id) delete g.__gigradarPantheonRun;
  });
  g.__gigradarPantheonRun = { id, done };
  return { run, started: true };
}

/**
 * A `running` row this process isn't actually running belongs to a process
 * that died mid-run (a restart, a crash). Settle it as `interrupted` so a
 * caller polling it gets an answer instead of `running` forever.
 */
function settleOrphan(run: StoredAdapterRun): StoredAdapterRun {
  if (run.status !== "running" || g.__gigradarPantheonRun?.id === run.id) return run;
  failAdapterRun(run.id, "interrupted", "the gigradar process restarted before this run finished");
  return getAdapterRun(run.id)!;
}

/** One run by id, or the latest run when `id` is omitted. */
export function getRunStatus(id?: string): StoredAdapterRun {
  const run = id ? getAdapterRun(id) : getLatestAdapterRun();
  if (!run) throw new AdapterError(id ? `pantheon adapter: no run with id "${id}"` : "pantheon adapter: no run yet", 404);
  return settleOrphan(run);
}

export type CheckResult = "pass" | "fail" | "info";

export interface ShortlistGig {
  key: string;
  sourceId: string;
  externalId: string;
  title: string;
  company?: string;
  url: string;
  tier: StoredAdapterRunResult["tier"];
  matchBand?: string;
  score: number;
  /** Whether runRadar() put this gig on the shortlist. */
  pass: boolean;
  /** Every reason runRadar() returned for this gig, verbatim — one per checked rule. */
  reasons: string[];
  /**
   * The same reasons, each tagged by its own marker: gate.ts prefixes a
   * passed rule with "✓ " and a failed one with "✗ "; anything else (a
   * tiering note, a per-profile detail line) is "info". Text is unchanged.
   */
  checks: { result: CheckResult; text: string }[];
  /** The gig's CURRENT pipeline status in the store (it may have moved since the run). */
  status?: string;
  unavailableSince?: string;
}

export interface Shortlist {
  run: StoredAdapterRun;
  passed: ShortlistGig[];
  rejected: ShortlistGig[];
}

function checkOf(reason: string): { result: CheckResult; text: string } {
  if (reason.startsWith("✓")) return { result: "pass", text: reason };
  if (reason.startsWith("✗")) return { result: "fail", text: reason };
  return { result: "info", text: reason };
}

function toShortlistGig(r: StoredAdapterRunResult): ShortlistGig {
  const current = getGig(r.gigKey);
  return {
    key: r.gigKey,
    sourceId: r.gig.sourceId,
    externalId: r.gig.externalId,
    title: r.gig.title,
    ...(r.gig.company ? { company: r.gig.company } : {}),
    url: r.gig.url,
    tier: r.tier,
    ...(r.gig.matchBand ? { matchBand: r.gig.matchBand } : {}),
    score: r.score,
    pass: r.pass,
    reasons: r.reasons,
    checks: r.reasons.map(checkOf),
    ...(current ? { status: current.status } : {}),
    ...(current?.unavailableSince ? { unavailableSince: current.unavailableSince } : {}),
  };
}

/**
 * The shortlist from run `runId`, or from the latest SUCCEEDED run when
 * omitted (a run still going, or one that failed, has no shortlist to give).
 */
export function getShortlist(runId?: string): Shortlist {
  const run = runId ? getRunStatus(runId) : getLatestAdapterRun({ status: "succeeded" });
  if (!run) throw new AdapterError("pantheon adapter: no completed run yet — trigger one with POST /api/pantheon/runs", 404);
  if (run.status !== "succeeded") {
    throw new AdapterError(`pantheon adapter: run "${run.id}" is ${run.status}, so it has no shortlist`, 409);
  }
  const results = listAdapterRunResults(run.id).map(toShortlistGig);
  return { run, passed: results.filter((r) => r.pass), rejected: results.filter((r) => !r.pass) };
}

export interface StageDraftInput {
  key: string;
  runId?: string;
  resumeId?: string;
}

/**
 * Stages ONE application draft for a gig from a run's shortlist, through
 * the same stageApplication() the dashboard's "Generate draft" uses. The
 * draft lands with status `draft` and goes no further: approving it and
 * marking it submitted stay human actions in /drafts. There is no submit
 * counterpart to this function, by design.
 *
 * Config is read the same non-resolving way generateDraftAction() reads it
 * (readRawConfig() + ConfigSchema): drafting needs the profile and apply
 * profile, never a source's resolved secret. The LLM credential may come
 * from the secrets facade.
 */
export async function stageDraft(input: StageDraftInput, deps: AdapterDeps = {}): Promise<{ gigKey: string; status: "draft"; content: unknown }> {
  if (!input.key) throw new AdapterError("pantheon adapter: `key` is required", 400);
  const { run } = getShortlist(input.runId);
  const result = getAdapterRunResult(run.id, input.key);
  if (!result) throw new AdapterError(`pantheon adapter: gig "${input.key}" is not in run "${run.id}"`, 404);
  if (!result.pass) {
    throw new AdapterError(`pantheon adapter: gig "${input.key}" did not make the shortlist in run "${run.id}"; not drafting it`, 422);
  }
  const gig = getGig(input.key);
  if (!gig) throw new AdapterError(`pantheon adapter: gig "${input.key}" is no longer in the store`, 404);

  const secrets = await (deps.resolveSecretsFn ?? resolveRunSecrets)();
  const credential = resolveLlmCredential(secrets);
  if (!credential) throw new AdapterError("pantheon adapter: no LLM credential is configured, so a draft cannot be generated", 422);
  const parsed = ConfigSchema.safeParse(readRawConfig());
  if (!parsed.success) throw new AdapterError("pantheon adapter: gigradar's saved configuration is incomplete or invalid", 422);

  const matchResult: MatchResult = {
    gig,
    pass: result.pass,
    reasons: result.reasons,
    score: result.score,
    ...(result.tier ? { tier: result.tier } : {}),
    matchedProfiles: gig.matchedProfileIds ?? [],
  };
  try {
    const draft = await (deps.stageApplicationFn ?? stageApplication)(matchResult, parsed.data, credential, {}, input.resumeId);
    return { gigKey: input.key, status: draft.status, content: draft.content };
  } catch (e) {
    // stageApplication()'s own guardrails (red tier, no apply profile) are
    // actionable and say so with their "gigradar apply:" prefix; anything
    // else is the LLM call itself failing upstream.
    throw new AdapterError(message(e), message(e).startsWith("gigradar apply:") ? 422 : 502);
  }
}
