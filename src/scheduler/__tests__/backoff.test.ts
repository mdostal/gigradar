import { describe, expect, it } from "vitest";
import { BackoffTracker, DEFAULT_MAX_BACKOFF_MS } from "../backoff.js";

// Every test drives an explicit, mutable fake clock — never real time — so
// "3 consecutive failures double each time, capped at 24h" and "resets on
// first success" are both verified with zero real waiting, per this story's
// own acceptance criteria.
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const HOUR = 60 * 60 * 1000;

describe("BackoffTracker", () => {
  it("a source never recorded is not in backoff and is included by filterSources", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    expect(tracker.isInBackoff("braintrust")).toBe(false);
    expect(tracker.getState("braintrust")).toBeUndefined();
    expect(tracker.filterSources([{ id: "braintrust" }])).toEqual([{ id: "braintrust" }]);
  });

  it("first failure backs off to the base interval", () => {
    const clock = fakeClock(1_000_000);
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    tracker.recordFailure("flaky");

    const state = tracker.getState("flaky");
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.intervalMs).toBe(HOUR);
    expect(state?.backoffUntil).toBe(1_000_000 + HOUR);
    expect(tracker.isInBackoff("flaky")).toBe(true);
  });

  it("doubles the interval on each additional consecutive failure, capped at 24h", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    tracker.recordFailure("flaky"); // 1st: base (1h)
    expect(tracker.getState("flaky")?.intervalMs).toBe(HOUR);

    tracker.recordFailure("flaky"); // 2nd: 2h
    expect(tracker.getState("flaky")?.intervalMs).toBe(2 * HOUR);

    tracker.recordFailure("flaky"); // 3rd: 4h
    expect(tracker.getState("flaky")?.intervalMs).toBe(4 * HOUR);
    expect(tracker.getState("flaky")?.consecutiveFailures).toBe(3);
  });

  it("caps the interval at maxIntervalMs (default 24h) even after many consecutive failures", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    // 1h, 2h, 4h, 8h, 16h, 32h(->capped 24h), 24h, ...
    for (let i = 0; i < 10; i++) tracker.recordFailure("flaky");

    expect(tracker.getState("flaky")?.intervalMs).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(tracker.getState("flaky")?.intervalMs).toBe(24 * HOUR);
  });

  it("respects a custom maxIntervalMs cap", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, maxIntervalMs: 3 * HOUR, now: clock.now });

    tracker.recordFailure("flaky"); // 1h
    tracker.recordFailure("flaky"); // 2h
    tracker.recordFailure("flaky"); // would be 4h, capped to 3h
    tracker.recordFailure("flaky"); // stays capped at 3h

    expect(tracker.getState("flaky")?.intervalMs).toBe(3 * HOUR);
  });

  it("a source in its active backoff window is excluded by filterSources; recovers once the window elapses", () => {
    const clock = fakeClock(0);
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });
    const sources = [{ id: "flaky" }, { id: "healthy" }];

    tracker.recordFailure("flaky");
    expect(tracker.filterSources(sources)).toEqual([{ id: "healthy" }]);

    clock.advance(HOUR - 1);
    expect(tracker.isInBackoff("flaky")).toBe(true);
    expect(tracker.filterSources(sources)).toEqual([{ id: "healthy" }]);

    clock.advance(2); // now past backoffUntil
    expect(tracker.isInBackoff("flaky")).toBe(false);
    expect(tracker.filterSources(sources)).toEqual([{ id: "flaky" }, { id: "healthy" }]);
  });

  it("resets to the base interval (not the prior elevated backoff) on the first success after a failure streak", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    tracker.recordFailure("flaky"); // 1h
    tracker.recordFailure("flaky"); // 2h
    tracker.recordFailure("flaky"); // 4h
    expect(tracker.getState("flaky")?.intervalMs).toBe(4 * HOUR);
    expect(tracker.isInBackoff("flaky")).toBe(true);

    tracker.recordSuccess("flaky");

    const state = tracker.getState("flaky");
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.intervalMs).toBe(HOUR); // back to base, not 4h
    expect(state?.backoffUntil).toBeNull();
    expect(tracker.isInBackoff("flaky")).toBe(false);

    // A subsequent failure starts the doubling over from the base again.
    tracker.recordFailure("flaky");
    expect(tracker.getState("flaky")?.intervalMs).toBe(HOUR);
  });

  it("filterSources never mutates the input array or its entries", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });
    const sources = Object.freeze([{ id: "a" }, { id: "b" }]);

    tracker.recordFailure("a");
    const filtered = tracker.filterSources(sources);

    expect(filtered).not.toBe(sources);
    expect(sources).toHaveLength(2); // untouched
    expect(filtered).toEqual([{ id: "b" }]);
  });

  it("tracks multiple sources independently", () => {
    const clock = fakeClock();
    const tracker = new BackoffTracker({ baseIntervalMs: HOUR, now: clock.now });

    tracker.recordFailure("a");
    tracker.recordFailure("a");
    tracker.recordSuccess("b");

    expect(tracker.getState("a")?.consecutiveFailures).toBe(2);
    expect(tracker.getState("b")?.consecutiveFailures).toBe(0);
    expect(tracker.getAllStates().size).toBe(2);
  });
});
