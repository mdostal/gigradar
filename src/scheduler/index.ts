// gigradar's scheduler (scan-scheduler epic, scan-scheduler story): a
// standalone, long-running `npm run scheduler` process that fires runRadar()
// on the user's own `Config.schedule` cron cadence, in their own local
// `Profile.timezone`, with per-source exponential backoff (src/scheduler/backoff.ts)
// so a source that starts failing repeatedly backs off instead of getting
// hammered every single cycle. Mirrors src/mcp/server.ts's established
// "standalone long-running process, own npm script" convention — see that
// file's own header comment for the shape this one follows.
//
// croner (new dependency this story) was installed and its shipped
// `dist/croner.d.ts` + README read live before anything below was written
// against it — confirmed API: `new Cron(pattern, { timezone, catch }, fn)`,
// `job.nextRun()`/`job.nextRuns(n)`, `job.trigger()` (force an immediate run,
// used by this story's own tests to avoid real scheduling delays — see
// src/scheduler/__tests__/index.test.ts), `job.stop()`. `catch` accepts a
// callback `(err, job) => void`, invoked when the scheduled function throws —
// used below as a second, defense-in-depth layer under this file's own
// try/catch (see runCycle()).
//
// NEVER calls saveConfig() or writes to config.json under any circumstance —
// loadConfig() (src/lib/config/load.ts) is the ONLY config-reading function
// this module ever calls, and the per-cycle backoff-filtered Config
// (buildCycleConfig() below) is an in-memory-only variant, never written
// back anywhere. This is stated explicitly, and defended by a grep-verifiable
// regression test (src/scheduler/__tests__/no-save-config.test.ts), because
// this project has held a strict, repeatedly-enforced discipline against
// silently mutating the user's real config — see
// .pHive/epics/scan-scheduler/docs/design-discussion.md §3 step 2.
//
// Idles rather than exits when Config.schedule is unset (rechecking on
// `idleRecheckMs`, 1 hour by default) — an immediate clean exit risks being
// misread as a crash by an always-restart process supervisor (systemd,
// launchd's KeepAlive), producing restart-loop noise. See
// docs/ARCHITECTURE.md's "Scheduler" section and
// docs/scheduler-launchd-template.plist for a real, copy-pasteable macOS
// launchd starting point for keeping this process alive across a restart —
// that supervision choice itself is the user's own OS-level setup, not built
// here (matches electron-wrapper's own "terminal-launched, not a packaged
// installer/service" scope discipline).
import { Cron } from "croner";
import { startSidecarHealthCheck } from "./sidecar-health.js";
import { evaluateAutoFire } from "../lib/apply/autofire.js";
import { runRadar, stageApplication } from "../lib/apply/runner.js";
import { loadConfig } from "../lib/config/load.js";
import { resolveLlmCredential } from "../lib/config/env-store.js";
import { sendDesktopNotification } from "../lib/notify/desktop.js";
import { raiseIssue, resolveIssuesForSource } from "../lib/notify/issues.js";
import { registerAllSources } from "../lib/sources/register-all.js";
import { getDraft, getGig, gigKey, markDraftFailed, markDraftSubmitted, markDraftSubmitting, recordScanCycle, runStaleGigMaintenance } from "../lib/store/index.js";
import { KEEPALIVE_TARGETS, keepAliveSession } from "../lib/auth/session-keepalive.js";
import { getSubmitAdapter } from "../lib/submit/adapter.js";
import type { ApplyProfileConfig, Config, Gig, MatchResult, SourceConfig } from "../lib/types.js";
import { BackoffTracker, DEFAULT_MAX_BACKOFF_MS } from "./backoff.js";

/**
 * Fixed, non-configurable per-cycle cap on how many gigs `runAutoDraft()`
 * will stage a draft for in one cycle — bounds LLM cost on a large first
 * scan without adding a new config field speculatively (see this story's
 * design_decisions in .pHive/epics/auto-draft-on-scan/stories/auto-draft-on-scan.yaml).
 */
export const AUTO_DRAFT_CAP = 5;

/** Default recheck cadence while idling with `Config.schedule` unset. Exported so tests assert the real production default without needing to wait on it (they override it via `SchedulerOptions.idleRecheckMs`). */
export const DEFAULT_IDLE_RECHECK_MS = 60 * 60 * 1000; // 1 hour

// session-keepalive-refresh story (real-app-diagnosability epic
// follow-up). A fixed, internal cadence -- NOT owner-configurable like
// Config.schedule, since this is an implementation detail of keeping an
// already-captured session alive, not a scan the owner tunes. Every 10
// minutes gives KEEPALIVE_TARGETS' own real dwell time (session-keepalive.
// ts's DEFAULT_KEEPALIVE_DWELL_MS) many more chances per hour to catch
// whatever background refresh window a site's own client-side JS may use
// than the 30-min main scan cycle alone ever did (that cycle's own
// auth-check-then-scrape is fast, by design -- it was never dwelling long
// enough to exercise a refresh timer even once).
export const DEFAULT_KEEPALIVE_INTERVAL_CRON = "*/10 * * * *";

export type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface SchedulerOptions {
  /** Defaults to the real loadConfig(). Overridable so tests never touch a real config.json. */
  loadConfigFn?: () => Config;
  /** Defaults to the real runRadar(). Overridable so tests use fixture sources with no network/DB. */
  runRadarFn?: typeof runRadar;
  /** Defaults to the real stageApplication(). Overridable so tests observe/simulate auto-draft calls (success, failure, count) without a real Anthropic client or a live DB — mirrors runRadarFn's own injectable-options pattern. */
  stageApplicationFn?: typeof stageApplication;
  /** Defaults to the real getDraft(). Overridable so tests simulate an already-drafted gig without a live DB — mirrors runRadarFn's own injectable-options pattern. */
  getDraftFn?: typeof getDraft;
  /** Defaults to the real sendDesktopNotification(). Overridable so tests observe/simulate notify-on-green-match calls without firing a real OS notification — mirrors runRadarFn's own injectable-options pattern. */
  notifyFn?: typeof sendDesktopNotification;
  /** ms between idle rechecks when Config.schedule is unset. Defaults to DEFAULT_IDLE_RECHECK_MS (1 hour); tests override with a tiny value or a synchronous-firing setTimeoutFn to avoid real waiting. */
  idleRecheckMs?: number;
  /** Ceiling forwarded to each schedule-activation's BackoffTracker. Defaults to backoff.ts's own 24h default. */
  maxBackoffMs?: number;
  /** Injectable clock, forwarded to the BackoffTracker (see backoff.ts). Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer used only for the idle-recheck loop. Defaults to the real global setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
  /** Injectable timer-cancel, paired with setTimeoutFn above. Defaults to the real global clearTimeout. */
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
  /** Called once the fatal error boundary fires, in place of process.exit — defaults to process.exit itself. Overridable so tests observe a fatal exit without actually terminating the test process. */
  exitFn?: (code: number) => void;
  /** Test hook: called once per idle recheck (Config.schedule still unset), after the idle log line. No-op by default. */
  onIdleTick?: () => void;
  /** Test hook: called once a Cron job has been created for a now-set Config.schedule, before this function returns. No-op by default — lets a test .trigger() the job immediately instead of waiting for its real schedule. */
  onScheduled?: (job: Cron) => void;
  /** Defaults to the real keepAliveSession(). Overridable so tests observe/simulate keepalive calls without a real browser session. */
  keepAliveSessionFn?: typeof keepAliveSession;
  /** Cron pattern for the keepalive job. Defaults to DEFAULT_KEEPALIVE_INTERVAL_CRON; tests override with a fast-firing pattern or use onKeepaliveScheduled to .trigger() immediately. */
  keepaliveIntervalCron?: string;
  /** Test hook: called once the keepalive Cron job has been created, mirroring onScheduled above. No-op by default. */
  onKeepaliveScheduled?: (job: Cron) => void;
}

export interface SchedulerHandle {
  /** Stops the scheduler: clears the idle-recheck timer (if idling) and stops the Cron job (if scheduled). Idempotent. */
  stop: () => void;
  /** The active Cron job, once Config.schedule has been set and activate() has run — undefined while idling. */
  getJob: () => Cron | undefined;
  /** The active BackoffTracker, once activate() has run — undefined while idling. */
  getTracker: () => BackoffTracker | undefined;
  /** The active keepalive Cron job, once activate() has run — undefined while idling. */
  getKeepaliveJob: () => Cron | undefined;
}

/**
 * Derives the schedule's own "base interval" (the cadence BackoffTracker
 * backs a source off to on its first failure, and resets to on recovery) by
 * asking croner for the gap between the pattern's next two real run times —
 * rather than trying to hand-parse an arbitrary cron expression into a fixed
 * interval ourselves. Works for both a real cadence (e.g. daily 9am -> 24h)
 * and a short test pattern (e.g. every second -> 1000ms), so
 * src/scheduler/__tests__/index.test.ts never has to wait on a real schedule
 * to prove the backoff wiring. A pattern with fewer than two future runs
 * (e.g. a one-off year-bound expression) falls back to the 24h cap itself as
 * a sane base.
 */
export function deriveBaseIntervalMs(pattern: string, timezone: string): number {
  const probe = new Cron(pattern, { timezone });
  const [first, second] = probe.nextRuns(2);
  if (!first || !second) return DEFAULT_MAX_BACKOFF_MS;
  return second.getTime() - first.getTime();
}

/**
 * Builds the in-memory-only, backoff-filtered `Config` variant for one
 * cycle: `sources` is REPLACED with a filtered array (any source currently
 * in an active backoff window excluded, per `tracker.filterSources()`) —
 * every other field is passed through unchanged. Never written to disk,
 * never mutates `config` itself (`{ ...config, sources }` — a shallow copy).
 */
export function buildCycleConfig(config: Config, tracker: BackoffTracker): Config {
  return { ...config, sources: tracker.filterSources(config.sources) };
}

/** Prints the required per-cycle summary: gigs found/passed, per-source errors, sources skipped for backoff, and every tracked source's current backoff state. */
function logCycleSummary(
  result: { results: unknown[]; passed: unknown[]; errors: { sourceId: string; message: string }[] },
  tracker: BackoffTracker,
  skippedSourceIds: string[],
): void {
  console.log(
    `gigradar scheduler: cycle complete — ${result.results.length} gig(s) found, ${result.passed.length} passed the gate.`,
  );
  if (result.errors.length > 0) {
    console.error(`gigradar scheduler: ${result.errors.length} source(s) errored this cycle:`);
    for (const e of result.errors) console.error(`  - ${e.sourceId}: ${e.message}`);
  }
  if (skippedSourceIds.length > 0) {
    console.log(`gigradar scheduler: ${skippedSourceIds.length} source(s) skipped this cycle (in backoff): ${skippedSourceIds.join(", ")}.`);
  }
  const states = tracker.getAllStates();
  if (states.size > 0) {
    console.log("gigradar scheduler: current backoff states:");
    for (const [sourceId, state] of states) {
      const inBackoff = tracker.isInBackoff(sourceId);
      console.log(
        `  - ${sourceId}: consecutiveFailures=${state.consecutiveFailures} intervalMs=${state.intervalMs} inBackoff=${inBackoff}`,
      );
    }
  }
}

/**
 * `auto-draft-on-scan` epic/story: after a cycle's `runRadarFn()` returns its
 * `passed` matches, auto-generates a real draft (`stageApplicationFn`,
 * `stageApplication()` unmodified) for new green-tier matches — opt-in via
 * `config.autoDraftOnScan`, capped at `AUTO_DRAFT_CAP` (5) per cycle. Never
 * throws: a missing prerequisite or a per-gig failure is logged and this
 * function returns normally either way, so it can never fail the cycle
 * itself (matches this file's own per-source error-isolation discipline).
 *
 * Two prerequisites are checked ONCE per cycle, not discovered per-gig via
 * `stageApplication()`'s own errors (a realistic misconfiguration — no LLM
 * credential set, apply profile never filled in — would otherwise repeat
 * the same error once per eligible gig, every cycle, forever): an LLM
 * credential resolves via `resolveLlmCredential()` (llm-credential-modes
 * epic — a fresh disk read, works identically whether called from this
 * cron path or a Server Action — the SAME call `runCycle()` below now
 * makes for the `runOpts.credential`/`Source.fetch()` path, since
 * llm-provider-harness's custom-llm-source-credential-migration story)
 * AND `config.applyProfile` set. Either missing logs exactly ONE clear
 * line naming which, and skips auto-drafting entirely for the cycle.
 *
 * Eligibility: green tier AND in-band rate for at least one in-scope group
 * (group-aware-auto-draft-and-notify story — see `isGreenInBandForAnyGroup()`
 * below; NOT limited to the primary group) AND
 * `getDraftFn(gigKey(...)) === undefined` — ANY existing draft, regardless
 * of its status (`draft`/`approved`/`rejected`/`submitted`), excludes a gig
 * from future auto-drafting. Never silently overwrites a decision the user
 * already made about a gig; the user can still manually re-request a draft
 * via the existing dashboard button. A draft stays ONE artifact per gig even
 * when multiple groups match it — only the eligibility check is group-aware,
 * not the drafting mechanism itself.
 *
 * Each eligible gig's `stageApplicationFn()` call is individually
 * try/caught — one gig's failure is logged and does NOT stop the rest of
 * that cycle's auto-drafting (`stageApplication()`'s own red-tier/missing-
 * applyProfile guardrails are structurally unreachable here, since the two
 * cycle-level checks above already excluded both cases before any gig is
 * attempted — this per-gig catch is defense-in-depth, not the primary
 * mechanism). Always ends with a one-line summary of how many gigs were
 * auto-drafted.
 */
/**
 * The auto-fire attempt for one just-staged gig (graduated-auto-fire-trust
 * epic) — called right after `stageApplicationFn()` succeeds inside
 * `runAutoDraft()`'s own per-gig loop below. Has its OWN internal
 * try/catch, entirely separate from that loop's drafting-failure catch: the
 * draft itself already succeeded by the time this runs, so a submit
 * failure here is a DIFFERENT kind of failure and must never be logged or
 * counted as an "auto-draft failed" line. Every outcome (evaluated, fired
 * or not, or a submit failure) is already durably logged elsewhere
 * (`evaluateAutoFireFn()`'s own `autofire_decisions` row, or
 * `markDraftFailed()`'s own console.error) — this function adds one
 * success line on a real fire and nothing else on every other path,
 * matching `runAutoDraft()`'s own "one line, never a crash" discipline.
 */
async function attemptAutoFire(
  key: string,
  config: Config,
  applyProfile: ApplyProfileConfig,
  evaluateAutoFireFn: typeof evaluateAutoFire,
  getSubmitAdapterFn: typeof getSubmitAdapter,
): Promise<void> {
  let decision: ReturnType<typeof evaluateAutoFire>;
  try {
    decision = evaluateAutoFireFn(key, config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`gigradar scheduler: auto-fire evaluation failed for "${key}" — ${message}`);
    await raiseIssue({
      severity: "warning",
      source: `autofire-eval:${key}`,
      title: "Auto-fire evaluation failed",
      message,
      context: { gigKey: key },
    });
    return;
  }
  if (!decision.fired) return;

  const gig = getGig(key);
  const draft = getDraft(key);
  const adapter = gig ? getSubmitAdapterFn(gig.sourceId) : undefined;
  if (!gig || !draft || !adapter) {
    // Structurally shouldn't happen -- evaluateAutoFire() only returns
    // fired:true after confirming a gig, a draft, and a registered adapter
    // all exist. Defense-in-depth, not the primary mechanism.
    console.error(`gigradar scheduler: auto-fire decision said fire for "${key}" but the gig/draft/adapter it needs is missing.`);
    return;
  }

  markDraftSubmitting(key);
  try {
    await adapter.submit(gig, draft.content, applyProfile);
    markDraftSubmitted(key);
    console.log(`gigradar scheduler: auto-fired application for "${gig.title}" (${key}).`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    markDraftFailed(key, message);
    // severity "error", not "warning" -- unlike an evaluation bug above,
    // this is a real submission ATTEMPT that failed; a materially bigger
    // deal (see design-discussion.md §3.3 in the notifications-epic docs).
    await raiseIssue({
      severity: "error",
      source: `autofire-submit:${key}`,
      title: "Auto-fire submit failed",
      message,
      context: { gigKey: key, sourceId: gig.sourceId },
    });
  }
}

/**
 * group-aware-auto-draft-and-notify story: true when at least one of the
 * owner's groups is GREEN tier AND in-band rate for this gig -- the SAME
 * group must satisfy BOTH checks (a gig green for group A but only in-band
 * for group B does not count). Mirrors runRadar()'s own already-fixed
 * precedent for `MatchResult.pass` (see runner.ts's own comment: "'pass'
 * reflects whether this gig cleared ANY in-scope group, not just the
 * primary one") -- runAutoDraft()'s eligibility gate below applies that
 * SAME principle instead of reading the flat, primary-group-only
 * `gig.tier`/`gig.matchBand`.
 *
 * `matchedGroupTiers`/`matchedGroupBands` are unconditionally stamped onto
 * every gig by a real runRadar() scan (see runner.ts) -- a gig with neither
 * (only possible for hand-constructed data predating the
 * multi-group-architecture epic) fails closed here, the same "automation
 * firing on stale/unclassified data is the worse outcome" discipline
 * runAutoDraft() already applies to a missing flat `matchBand` below.
 *
 * For a single-group install this is byte-identical to the old primary-
 * group-only check: there is only one group to find, and it IS the
 * primary group.
 */
function isGreenInBandForAnyGroup(gig: Gig): boolean {
  const tiers = gig.matchedGroupTiers;
  const bands = gig.matchedGroupBands;
  if (!tiers) return false;
  return Object.keys(tiers).some((groupId) => tiers[groupId] === "green" && bands?.[groupId] === "in-band");
}

/**
 * group-aware-auto-draft-and-notify story: true when at least one of the
 * owner's groups is GREEN tier for this gig -- band is deliberately NOT
 * part of this check, matching runNotifyOnGreenMatch()'s own pre-existing
 * "tier only" scope (see that function's doc comment; this story doesn't
 * add a check the original notify-on-green-match story never had). Same
 * "any in-scope group, not just primary" principle as
 * isGreenInBandForAnyGroup() above -- see that function's doc comment for
 * the fail-closed/single-group-byte-identical reasoning, which applies
 * here identically.
 */
function isGreenForAnyGroup(gig: Gig): boolean {
  const tiers = gig.matchedGroupTiers;
  if (!tiers) return false;
  return Object.values(tiers).some((t) => t === "green");
}

export async function runAutoDraft(
  config: Config,
  passed: MatchResult[],
  stageApplicationFn: typeof stageApplication,
  getDraftFn: typeof getDraft,
  evaluateAutoFireFn: typeof evaluateAutoFire = evaluateAutoFire,
  getSubmitAdapterFn: typeof getSubmitAdapter = getSubmitAdapter,
): Promise<void> {
  if (!config.autoDraftOnScan) return;

  const credential = resolveLlmCredential();
  if (!credential) {
    console.log(
      "gigradar scheduler: autoDraftOnScan is enabled but ANTHROPIC_API_KEY is not set — skipping auto-draft this cycle.",
    );
    return;
  }
  if (!config.applyProfile) {
    console.log(
      "gigradar scheduler: autoDraftOnScan is enabled but no apply profile is configured (set one up in /config) — skipping auto-draft this cycle.",
    );
    return;
  }
  const applyProfile = config.applyProfile;

  // rate-band-match-quality epic: additive match-band check alongside
  // tier -- tier is a keyword-only, rate-blind signal (matching/tiering.ts);
  // an unset matchBand (a gig scanned before this epic shipped) fails
  // closed here, the deliberate opposite of dashboard-filter.ts's own
  // resolveDisplayBand() fallback (see that file's header comment) --
  // automation firing on stale/unclassified rate data is the worse
  // outcome, display hiding a legitimate historical gig is not.
  //
  // group-aware-auto-draft-and-notify story: this used to read the flat
  // r.tier/r.gig.matchBand (the PRIMARY group's own result only) -- widened
  // to isGreenInBandForAnyGroup() so a gig that's a real green+in-band
  // match for a non-primary group is no longer silently skipped. See that
  // function's own doc comment above.
  const eligible = passed
    .filter((r) => isGreenInBandForAnyGroup(r.gig) && getDraftFn(gigKey(r.gig.sourceId, r.gig.externalId)) === undefined)
    .slice(0, AUTO_DRAFT_CAP);

  let draftedCount = 0;
  for (const r of eligible) {
    const key = gigKey(r.gig.sourceId, r.gig.externalId);
    try {
      await stageApplicationFn(r, config, credential);
      draftedCount += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`gigradar scheduler: auto-draft failed for "${r.gig.title}" (${key}) — ${message}`);
      await raiseIssue({
        severity: "warning",
        source: `autoDraft:${key}`,
        title: "Auto-draft failed",
        message,
        context: { gigKey: key },
      });
      continue;
    }

    // graduated-auto-fire-trust epic: evaluated right after a successful
    // draft, using the SAME per-gig isolation as the draft attempt above --
    // its own try/catch (attemptAutoFire) so one gig's auto-fire outcome
    // never affects another's, and never retroactively "fails" the
    // drafting step that already succeeded.
    await attemptAutoFire(key, config, applyProfile, evaluateAutoFireFn, getSubmitAdapterFn);
  }

  console.log(`gigradar scheduler: ${draftedCount} gig(s) auto-drafted this cycle.`);
}

/**
 * `notify-on-green-match` story: after a cycle's `runRadarFn()` returns its
 * `passed` matches and `newlyInsertedKeys`, fires ONE best-effort desktop
 * notification (`notifyFn`, `sendDesktopNotification()` unmodified) when the
 * cycle found one or more BRAND-NEW green-tier matches — opt-in via
 * `config.notifyOnGreenMatch`. "Green-tier match" means green for at least
 * one in-scope group (group-aware-auto-draft-and-notify story — see
 * `isGreenForAnyGroup()` above; NOT limited to the primary group), same
 * widening as `runAutoDraft()`'s own eligibility check above. Never throws:
 * `sendDesktopNotification()` itself never rejects (see its own doc
 * comment), and the call here is still wrapped defensively so a
 * notification can never fail the cycle.
 *
 * "New" is `newlyInsertedKeys` (from `runRadar()`'s own `recordScan()`
 * insertion signal) — a gig re-seen on a later scan is never re-notified,
 * even if it's still green-tier. Deliberately a single summarizing
 * notification per cycle, never one per gig — same "no per-item spam"
 * discipline `runAutoDraft()`'s own log line follows.
 */
export async function runNotifyOnGreenMatch(
  config: Config,
  passed: MatchResult[],
  newlyInsertedKeys: string[],
  notifyFn: typeof sendDesktopNotification,
): Promise<void> {
  if (!config.notifyOnGreenMatch) return;

  const newKeys = new Set(newlyInsertedKeys);
  // group-aware-auto-draft-and-notify story: this used to read the flat
  // r.tier (the PRIMARY group's own result only) -- widened to
  // isGreenForAnyGroup() so a brand-new gig that's a real green match for a
  // non-primary group still triggers a notification. Band is deliberately
  // NOT part of this check, same as before this story -- see that
  // function's own doc comment above.
  const newGreenMatches = passed.filter(
    (r) => isGreenForAnyGroup(r.gig) && newKeys.has(gigKey(r.gig.sourceId, r.gig.externalId)),
  );

  if (newGreenMatches.length === 0) return;

  const first = newGreenMatches[0];
  const title = newGreenMatches.length === 1 ? "gigradar: new green-tier match" : "gigradar: new green-tier matches";
  const body =
    newGreenMatches.length === 1
      ? `${first?.gig.title} @ ${first?.gig.company ?? "?"}`
      : `${newGreenMatches.length} new matches, including "${first?.gig.title}"`;

  try {
    await notifyFn({ title, body });
  } catch (e) {
    console.warn(`gigradar scheduler: notify-on-green-match failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`gigradar scheduler: ${newGreenMatches.length} new green-tier match(es) this cycle — notified.`);
}

/**
 * Starts the scheduler: loads Config via `loadConfigFn` (real `loadConfig()`
 * by default). If `Config.schedule` is unset, logs clearly and idles,
 * rechecking every `idleRecheckMs` — never exits (see this file's header
 * comment for why). Once `Config.schedule` IS set, schedules `runRadarFn`
 * via croner using `Profile.timezone`, with per-source exponential backoff.
 *
 * Any error outside a scan cycle's own per-source handling (a malformed
 * cron expression, loadConfigFn() throwing, a bug in this orchestration
 * code, or runRadarFn itself throwing rather than returning its own
 * `errors[]`) hits the fatal error boundary: logs fatally and calls
 * `exitFn(1)` (real `process.exit(1)` by default) — never hangs silently.
 *
 * Returns a `SchedulerHandle` immediately (idling or scheduled) rather than
 * blocking forever — the process itself stays alive because croner's and
 * Node's own timers hold the event loop open, exactly like
 * src/mcp/server.ts's stdio transport keeps that process alive.
 */
export function startScheduler(options: SchedulerOptions = {}): SchedulerHandle {
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const runRadarFn = options.runRadarFn ?? runRadar;
  const stageApplicationFn = options.stageApplicationFn ?? stageApplication;
  const getDraftFn = options.getDraftFn ?? getDraft;
  const notifyFn = options.notifyFn ?? sendDesktopNotification;
  const idleRecheckMs = options.idleRecheckMs ?? DEFAULT_IDLE_RECHECK_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const nowFn = options.now ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle: TimeoutHandle) => clearTimeout(handle));
  const exitFn = options.exitFn ?? ((code: number) => process.exit(code));
  const keepAliveSessionFn = options.keepAliveSessionFn ?? keepAliveSession;
  const keepaliveIntervalCron = options.keepaliveIntervalCron ?? DEFAULT_KEEPALIVE_INTERVAL_CRON;

  let stopped = false;
  let idleTimer: TimeoutHandle | undefined;
  let job: Cron | undefined;
  let keepaliveJob: Cron | undefined;
  let tracker: BackoffTracker | undefined;

  function stop(): void {
    stopped = true;
    if (idleTimer !== undefined) clearTimeoutFn(idleTimer);
    job?.stop();
    keepaliveJob?.stop();
  }

  /**
   * session-keepalive-refresh story. One keepalive pass across every real
   * browser-session-auth target (session-keepalive.ts's KEEPALIVE_TARGETS)
   * this config has enabled — a target with no matching enabled
   * SourceConfig is silently skipped (nothing to keep alive). Each
   * target's own failure is caught and logged individually, never
   * aborting the others — same per-source isolation discipline as
   * runCycle()'s own per-source error handling in runner.ts.
   */
  async function runKeepaliveCycle(config: Config): Promise<void> {
    for (const target of KEEPALIVE_TARGETS) {
      const sourceConfig = config.sources.find((s) => s.id === target.sourceId && s.enabled);
      if (!sourceConfig) continue;
      try {
        await keepAliveSessionFn(target, sourceConfig);
        console.log(`gigradar scheduler: keepalive succeeded for "${target.sourceId}".`);
      } catch (e) {
        console.warn(`gigradar scheduler: keepalive failed for "${target.sourceId}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The one fatal error boundary: logs, stops any active timer/job, and exits non-zero. Never called for a per-source scan error — those stay inside runRadar()'s own errors[] and this module's per-cycle summary log. */
  function fatal(error: unknown): void {
    console.error(`gigradar scheduler: fatal error — ${error instanceof Error ? error.message : String(error)}`);
    stop();
    exitFn(1);
  }

  async function runCycle(config: Config): Promise<void> {
    if (!tracker) throw new Error("gigradar scheduler: internal error — runCycle invoked before a BackoffTracker was created");
    try {
      const cycleConfig = buildCycleConfig(config, tracker);
      const skippedSourceIds = config.sources
        .filter((s) => !cycleConfig.sources.some((c) => c.id === s.id))
        .map((s) => s.id);

      // llm-custom-sources epic: resolved fresh each cycle via
      // resolveLlmCredential() -- the SAME call runAutoDraft() below
      // already makes for this exact long-running CLI/scheduler context
      // (llm-provider-harness epic, custom-llm-source-credential-migration
      // story: this used to read process.env.ANTHROPIC_API_KEY directly,
      // silently bypassing both AI SDK multi-provider mode and
      // claude-code-harness mode for every custom-llm/gmail-digest source's
      // real scheduled scan -- found live while verifying a new source
      // preset's Capture Login end to end).
      const result = await runRadarFn(cycleConfig, {}, { credential: resolveLlmCredential() });

      const erroredIds = new Set(result.errors.map((e) => e.sourceId));
      for (const source of cycleConfig.sources as SourceConfig[]) {
        if (!source.enabled) continue;
        if (erroredIds.has(source.id)) tracker.recordFailure(source.id);
        else tracker.recordSuccess(source.id);
      }

      // source-status-features epic, auto-resolve-stale-issues story: every
      // source that succeeded THIS cycle gets any of its still-open issues
      // cleared -- a transient failure (network blip, rate limit) that
      // self-heals on a later scan shouldn't sit in the Issues list forever
      // waiting for a manual "mark resolved" click. A source that's still
      // failing keeps its open issue untouched (raiseIssue() below dedupes
      // it, never re-raises a duplicate).
      for (const source of cycleConfig.sources as SourceConfig[]) {
        if (!source.enabled || erroredIds.has(source.id)) continue;
        resolveIssuesForSource(source.id);
      }

      logCycleSummary(result, tracker, skippedSourceIds);

      // status-strip-reflects-cycle-completion story (real-usability-
      // verification-and-fixes epic): persists THIS cycle's real
      // completion state -- errored (erroredIds, from runRadarFn()'s own
      // errors[]) AND backoff-skipped (skippedSourceIds, already computed
      // above) source ids, against the full count of ENABLED sources this
      // cycle was supposed to cover -- so src/lib/status/status-strip.ts's
      // freshness label can honestly distinguish a fully-completed cycle
      // from a partial one, instead of only ever reflecting
      // MAX(gig.lastSeen) (per-gig recency, not per-cycle completion; see
      // that file's own header comment for the real gap this closes).
      // Never derives a NEW judgment about cycle health -- just persists
      // the exact same errored/skipped sets this function already computed
      // for backoff-tracking and issue-raising above.
      recordScanCycle({
        sourcesTotal: config.sources.filter((s) => s.enabled).length,
        incompleteSourceIds: [...skippedSourceIds, ...erroredIds],
      });

      // notifications-epic: a source erroring isn't catastrophic (backoff
      // above already handles repeats), but the owner should be able to
      // SEE it without tailing logs. Deduped by raiseIssue() itself on
      // (source, title) -- a source failing every cycle raises exactly
      // once until resolved, not once per cycle.
      //
      // verification-copilot epic: a VerificationChallengeError (flagged
      // via result.errors[].needsVerification -- see runner.ts's own doc
      // comment) routes to its OWN distinctly-titled issue instead of the
      // generic "Source fetch failed" -- a DIFFERENT (source, title)
      // dedupe key, so the two issue types never collide/mask each other
      // for the same source.
      for (const e of result.errors) {
        if (e.needsVerification) {
          await raiseIssue({
            severity: "warning",
            source: `runRadar:${e.sourceId}`,
            title: "Needs human verification",
            message: e.message,
            context: { sourceId: e.sourceId, blockedUrl: e.blockedUrl },
          });
        } else {
          await raiseIssue({
            severity: "warning",
            source: `runRadar:${e.sourceId}`,
            title: "Source fetch failed",
            message: e.message,
            context: { sourceId: e.sourceId },
          });
        }
      }

      // auto-draft-on-scan epic: opt-in, off by default (config.autoDraftOnScan
      // unset/false is a no-op inside runAutoDraft() itself) — see that
      // function's own doc comment above for the full behavior.
      await runAutoDraft(config, result.passed, stageApplicationFn, getDraftFn);

      // notify-on-green-match story: opt-in, off by default (same no-op
      // pattern as runAutoDraft() above) — see that function's own doc
      // comment for the full behavior.
      await runNotifyOnGreenMatch(config, result.passed, result.newlyInsertedKeys, notifyFn);

      // stale-tier-retier-and-archive story: piggybacks on this same
      // 30-min cycle rather than a separate timer. Uses the FULL config
      // (not cycleConfig) -- a source currently in backoff shouldn't stop
      // its already-stored gigs from being re-tiered/archived against the
      // owner's real, current redKeywords/coreTitles. Only ever touches
      // status:"new" gigs (see maintenance.ts's own header comment).
      const { retiered, archived } = runStaleGigMaintenance(config);
      if (retiered > 0 || archived > 0) {
        console.log(`gigradar scheduler: stale-gig maintenance — ${retiered} re-tiered, ${archived} archived (expired_unapplied).`);
      }
    } catch (e) {
      // Anything that reaches here is, by construction, OUTSIDE runRadar()'s
      // own per-source try/catch (that function never throws for a single
      // source's failure — see apply/runner.ts) — a genuine top-level fault.
      fatal(e);
    }
  }

  function activate(config: Config): void {
    // Config.schedule/Profile.timezone are validated non-empty by ConfigSchema
    // before loadConfig() ever returns them; the `!` below just narrows past
    // `schedule`'s optional-field type after the `if (!config.schedule)` guard
    // in idleTick() already confirmed it's set for this call.
    const schedule = config.schedule as string;
    const timezone = config.profile.timezone;

    const baseIntervalMs = deriveBaseIntervalMs(schedule, timezone);
    tracker = new BackoffTracker({ baseIntervalMs, maxIntervalMs: maxBackoffMs, now: nowFn });

    job = new Cron(
      schedule,
      {
        timezone,
        catch: (err: unknown) => fatal(err), // defense-in-depth: runCycle() already catches everything itself, but a croner-internal fault would otherwise become a silent unhandled rejection.
      },
      () => runCycle(config),
    );

    console.log(
      `gigradar scheduler: scheduled — cron "${schedule}" in timezone "${timezone}", next run ${job.nextRun()?.toISOString() ?? "unknown"}.`,
    );
    options.onScheduled?.(job);

    // session-keepalive-refresh story. Activated alongside the main scan
    // job (same lifecycle, same "only runs once Config.schedule is set"
    // gating) — unattended automated scanning is the whole reason a
    // session needs to survive between capture and next use, so keepalive
    // never runs on its own independent of the main scheduler being
    // active. Own try/catch per target inside runKeepaliveCycle() means a
    // croner-internal fault is the only thing `catch` here needs to guard.
    keepaliveJob = new Cron(
      keepaliveIntervalCron,
      { timezone, catch: (err: unknown) => console.warn(`gigradar scheduler: keepalive cycle's own croner job faulted (non-fatal): ${err instanceof Error ? err.message : String(err)}`) },
      () => runKeepaliveCycle(config),
    );
    console.log(`gigradar scheduler: keepalive scheduled — cron "${keepaliveIntervalCron}" in timezone "${timezone}".`);
    options.onKeepaliveScheduled?.(keepaliveJob);
  }

  function idleTick(): void {
    if (stopped) return;
    try {
      const config = loadConfigFn();
      if (!config.schedule) {
        console.log(
          `gigradar scheduler: Config.schedule is unset — idling, rechecking in ${idleRecheckMs}ms. Set a cron expression in /config to start scheduled scans.`,
        );
        options.onIdleTick?.();
        idleTimer = setTimeoutFn(idleTick, idleRecheckMs);
        return;
      }
      activate(config);
    } catch (e) {
      fatal(e);
    }
  }

  idleTick();

  return {
    stop,
    getJob: () => job,
    getTracker: () => tracker,
    getKeepaliveJob: () => keepaliveJob,
  };
}

// CLI entrypoint: `npm run scheduler`. runner-registry-and-sidecar-lifecycle
// epic: registration is now shared with src/lib/apply/runner.ts's own CLI
// main() (and src/app/issues/actions.ts's retrySourceAction) via
// register-all.ts — see that file's own doc comment for why this must stay
// a dynamic-import call inside a function, never a static top-level import
// of this module (this module's own tests import startScheduler() directly
// and register their own network-free test-double sources under the SAME
// ids — a top-level import here would collide with "duplicate source id"
// in that same test process).
async function main(): Promise<void> {
  await registerAllSources();

  startScheduler();
  startSidecarHealthCheck();
}

// Only run when invoked directly (`npm run scheduler`), not when imported by
// tests that just need startScheduler()/buildCycleConfig()/deriveBaseIntervalMs()
// — mirrors src/lib/apply/runner.ts's and src/mcp/server.ts's identical
// process.argv[1] guard around their own main().
if (process.argv[1] && process.argv[1].endsWith("scheduler/index.ts")) {
  main().catch((e) => {
    console.error("gigradar scheduler: fatal error starting scheduler:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
