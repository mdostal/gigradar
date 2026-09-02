// deep-dive-audit-and-testing-framework epic, sidecar-health-check story.
// Fully injected -- no real timers, no real network, no real store. Proves
// the consecutive-failure threshold, the dedup-safe raiseIssue() call
// shape, and the auto-resolve-on-recovery behavior in isolation.
import { describe, expect, it, vi } from "vitest";
import { startSidecarHealthCheck } from "../sidecar-health.js";

function makeIntervalHarness() {
  let tickFn: (() => void) | undefined;
  const setIntervalFn = vi.fn((fn: () => void) => {
    tickFn = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalFn = vi.fn();
  return {
    setIntervalFn,
    clearIntervalFn,
    fireTick: async () => {
      tickFn?.();
      // tick() is async internally -- flush microtasks so its awaits settle.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("startSidecarHealthCheck", () => {
  it("does not raise an issue until consecutiveFailureThreshold consecutive failures are observed", async () => {
    const { setIntervalFn, clearIntervalFn, fireTick } = makeIntervalHarness();
    const raiseIssueFn = vi.fn();
    const checkFn = vi.fn().mockRejectedValue(new Error("connection refused"));

    const handle = startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn, raiseIssueFn, consecutiveFailureThreshold: 3 });

    await fireTick();
    expect(raiseIssueFn).not.toHaveBeenCalled();
    expect(handle.getConsecutiveFailures()).toBe(1);

    await fireTick();
    expect(raiseIssueFn).not.toHaveBeenCalled();
    expect(handle.getConsecutiveFailures()).toBe(2);

    await fireTick();
    expect(raiseIssueFn).toHaveBeenCalledTimes(1);
    expect(raiseIssueFn).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "error", source: "sidecar-health-check", title: "gigradar's own server isn't responding" }),
    );
    expect(handle.getConsecutiveFailures()).toBe(3);
  });

  it("a single successful check in between resets the consecutive-failure count -- a brief blip never accumulates toward the threshold", async () => {
    const { setIntervalFn, clearIntervalFn, fireTick } = makeIntervalHarness();
    const raiseIssueFn = vi.fn();
    const checkFn = vi.fn();

    checkFn.mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down"));

    startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn, raiseIssueFn, consecutiveFailureThreshold: 3 });

    await fireTick(); // fail 1
    await fireTick(); // fail 2
    await fireTick(); // success -- resets
    await fireTick(); // fail 1 again
    await fireTick(); // fail 2 again

    expect(raiseIssueFn).not.toHaveBeenCalled();
  });

  it("only raises ONE issue per outage -- does not re-raise on every subsequent failing tick past the threshold", async () => {
    const { setIntervalFn, clearIntervalFn, fireTick } = makeIntervalHarness();
    const raiseIssueFn = vi.fn();
    const checkFn = vi.fn().mockRejectedValue(new Error("down"));

    startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn, raiseIssueFn, consecutiveFailureThreshold: 2 });

    await fireTick();
    await fireTick();
    await fireTick();
    await fireTick();

    expect(raiseIssueFn).toHaveBeenCalledTimes(1);
  });

  it("resolves the issue once the server recovers after an outage that crossed the threshold", async () => {
    const { setIntervalFn, clearIntervalFn, fireTick } = makeIntervalHarness();
    const raiseIssueFn = vi.fn();
    const resolveIssuesForSourceFn = vi.fn();
    const checkFn = vi.fn();
    checkFn.mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(undefined);

    startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn, raiseIssueFn, resolveIssuesForSourceFn, consecutiveFailureThreshold: 2 });

    await fireTick(); // fail 1
    await fireTick(); // fail 2 -- crosses threshold, raises
    expect(raiseIssueFn).toHaveBeenCalledTimes(1);

    await fireTick(); // recovers
    expect(resolveIssuesForSourceFn).toHaveBeenCalledWith("sidecar-health-check");
  });

  it("never calls resolveIssuesForSource when the outage never crossed the threshold in the first place", async () => {
    const { setIntervalFn, clearIntervalFn, fireTick } = makeIntervalHarness();
    const resolveIssuesForSourceFn = vi.fn();
    const checkFn = vi.fn();
    checkFn.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(undefined);

    startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn, resolveIssuesForSourceFn, consecutiveFailureThreshold: 3 });

    await fireTick(); // fail 1 -- below threshold
    await fireTick(); // recovers

    expect(resolveIssuesForSourceFn).not.toHaveBeenCalled();
  });

  it("stop() clears the interval via the injected clearIntervalFn", () => {
    const { setIntervalFn, clearIntervalFn } = makeIntervalHarness();
    const handle = startSidecarHealthCheck({ setIntervalFn, clearIntervalFn, checkFn: vi.fn() });

    handle.stop();

    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
