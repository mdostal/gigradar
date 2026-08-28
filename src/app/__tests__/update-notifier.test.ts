import { describe, expect, it } from "vitest";
import { formatCountdown } from "../update-notifier";

// This repo has no React Testing Library / DOM-rendering test infra
// (nav-header.test.ts's own comment explains why -- the exported-plain-
// function convention is followed here too): UpdateNotifier itself is
// Tauri-only and not rendered in tests; only its extracted pure countdown
// formatter is exercised directly.
describe("formatCountdown", () => {
  it("formats a multi-minute remaining duration as 'Nm SSs'", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const deadline = now + 5 * 60 * 1000 + 7 * 1000; // 5m07s from now
    expect(formatCountdown(deadline, now)).toBe("5m 07s");
  });

  it("formats a sub-minute remaining duration as just 'Ns'", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const deadline = now + 42 * 1000;
    expect(formatCountdown(deadline, now)).toBe("42s");
  });

  it("rounds a fractional remaining duration up to the next whole second", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const deadline = now + 1500; // 1.5s
    expect(formatCountdown(deadline, now)).toBe("2s");
  });

  it("clamps to 'any moment now' once the deadline has already passed", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(formatCountdown(now - 5000, now)).toBe("any moment now");
    expect(formatCountdown(now, now)).toBe("any moment now");
  });

  it("pads single-digit seconds in the minutes-present case", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const deadline = now + 1 * 60 * 1000 + 3 * 1000; // 1m03s
    expect(formatCountdown(deadline, now)).toBe("1m 03s");
  });
});
