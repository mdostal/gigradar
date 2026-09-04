import { describe, expect, it } from "vitest";
import { describeCron } from "../describe-cron";

describe("describeCron", () => {
  it("describes a single daily run", () => {
    expect(describeCron("0 9 * * *")).toBe("Runs at 09:00 daily");
  });

  it("describes multiple runs per day", () => {
    expect(describeCron("0 7,13,19 * * *")).toBe("Runs at 07:00, 13:00, 19:00 daily");
  });

  it("describes a weekday-only schedule as 'weekdays'", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Runs at 09:00, weekdays");
  });

  it("describes an explicit day list", () => {
    expect(describeCron("30 8 * * 1,3,5")).toBe("Runs at 08:30, Mon, Wed, Fri");
  });

  it("pads single-digit minutes and hours", () => {
    expect(describeCron("5 9 * * *")).toBe("Runs at 09:05 daily");
  });

  it("returns null for a calendar-date schedule (day-of-month constrained)", () => {
    expect(describeCron("0 9 1 * *")).toBeNull();
  });

  it("returns null for a month-constrained schedule", () => {
    expect(describeCron("0 0 * 12 *")).toBeNull();
  });

  it("returns null for a malformed cron string", () => {
    expect(describeCron("not a cron")).toBeNull();
    expect(describeCron("* * * *")).toBeNull();
  });

  it("returns null for a per-minute list (not representable as H:MM)", () => {
    expect(describeCron("0,30 9 * * *")).toBeNull();
  });

  it("returns null for every-day-of-week written as 0-6 (redundant with '*')", () => {
    expect(describeCron("0 9 * * 0-6")).toBe("Runs at 09:00 daily");
  });
});
