// Per-source exponential backoff, in-memory for the scheduler PROCESS's
// lifetime only (scan-scheduler story). Deliberately does NOT persist across
// a process restart — see .pHive/epics/scan-scheduler/docs/design-discussion.md
// §3 step 3: "persisting across a scheduler PROCESS RESTART, vs. across scan
// CYCLES within one long-running process, are different problems — this
// epic solves the latter." A source that starts failing every cycle backs
// off (doubling, capped at 24h) rather than getting hammered every single
// cycle; the first success after a failure streak resets it straight back
// to the schedule's own base interval.
//
// Time is fully injectable (the `now` constructor option, defaulting to
// Date.now) so every acceptance criterion here (doubling, the 24h cap, and
// the reset-on-success) is testable without any real waiting or fake-timer
// gymnastics — see src/scheduler/__tests__/backoff.test.ts.
//
// This module is pure in-memory bookkeeping: it never reads or writes
// config.json, never imports src/lib/config/save.ts, and has no knowledge
// of the filesystem at all. src/scheduler/index.ts is the only thing that
// ever calls filterSources() below, immediately before invoking runRadar()
// — see that file's own header comment for the "never persisted" guarantee
// this feeds into.

/** One source's current backoff bookkeeping. */
export interface BackoffState {
  /** Consecutive failed cycles since the last success (0 = currently healthy). */
  consecutiveFailures: number;
  /** The backoff interval this source is CURRENTLY subject to, in ms — the base interval while healthy, doubling per additional consecutive failure, capped at `maxIntervalMs`. */
  intervalMs: number;
  /** Epoch ms this source's current backoff window ends, or null when not in an active backoff window (healthy, or never seen). */
  backoffUntil: number | null;
}

export interface BackoffTrackerOptions {
  /** The schedule's own base cadence, in ms — the interval a source backs off to on its FIRST failure and resets to on recovery. */
  baseIntervalMs: number;
  /** Ceiling on the backoff interval, in ms. Defaults to 24 hours per this story's acceptance criteria. */
  maxIntervalMs?: number;
  /** Injectable clock — defaults to Date.now. Tests pass a controllable function instead of waiting on real time. */
  now?: () => number;
}

export const DEFAULT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Tracks per-source backoff state across scan cycles within one scheduler
 * process's lifetime. `filterSources()` is the one method src/scheduler/index.ts
 * calls every cycle to build the in-memory-only, never-persisted `Config`
 * variant passed to `runRadar()`.
 */
export class BackoffTracker {
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, BackoffState>();

  constructor(options: BackoffTrackerOptions) {
    this.baseIntervalMs = options.baseIntervalMs;
    this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a failed cycle for `sourceId`. First failure backs off to the
   * base interval; each additional CONSECUTIVE failure doubles the prior
   * interval, capped at `maxIntervalMs`. `backoffUntil` is stamped from the
   * injected clock at the moment of failure, not the interval's own start.
   */
  recordFailure(sourceId: string): void {
    const existing = this.states.get(sourceId);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const priorIntervalMs = existing && existing.consecutiveFailures > 0 ? existing.intervalMs : this.baseIntervalMs;
    const intervalMs =
      consecutiveFailures === 1 ? this.baseIntervalMs : Math.min(priorIntervalMs * 2, this.maxIntervalMs);
    const backoffUntil = this.now() + intervalMs;
    this.states.set(sourceId, { consecutiveFailures, intervalMs, backoffUntil });
  }

  /**
   * Record a successful cycle for `sourceId` — resets it straight back to
   * the base interval and clears its backoff window, whether or not it had
   * a prior failure streak (idempotent on an already-healthy source).
   */
  recordSuccess(sourceId: string): void {
    this.states.set(sourceId, { consecutiveFailures: 0, intervalMs: this.baseIntervalMs, backoffUntil: null });
  }

  /** True if `sourceId` is currently inside an active backoff window (per the injected clock). A source never seen, or currently healthy, is false. */
  isInBackoff(sourceId: string): boolean {
    const state = this.states.get(sourceId);
    if (!state || state.backoffUntil === null) return false;
    return this.now() < state.backoffUntil;
  }

  /** Read-only snapshot of a single source's state, or undefined if never recorded. */
  getState(sourceId: string): Readonly<BackoffState> | undefined {
    const state = this.states.get(sourceId);
    return state ? { ...state } : undefined;
  }

  /** Read-only snapshot of every tracked source's state — used for the scheduler's per-cycle summary log. */
  getAllStates(): ReadonlyMap<string, Readonly<BackoffState>> {
    return new Map(this.states);
  }

  /**
   * Returns `sources` with any entry currently in an active backoff window
   * excluded — the in-memory-only filtering src/scheduler/index.ts applies
   * to `Config.sources` before calling `runRadar()` each cycle. Never
   * mutates `sources` or anything in it; always returns a new array.
   */
  filterSources<T extends { id: string }>(sources: readonly T[]): T[] {
    return sources.filter((source) => !this.isInBackoff(source.id));
  }
}
