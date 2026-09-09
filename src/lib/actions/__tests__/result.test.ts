import { afterEach, describe, expect, it, vi } from "vitest";
import { actionErr, actionOk } from "../result.js";

// real-app-diagnosability epic follow-up (2026-09-09): actionErr() gained a
// console.error() call so every one of this app's ~105 Server Action call
// sites -- each of which catches its own error and returns it as plain
// data, never an uncaught exception -- finally leaves a real, durable trace
// server-side (now that tauri_plugin_log is registered unconditionally,
// per this same epic's other story). Live-discovered gap: a GoFractional
// Capture Login that silently never saved a session left zero trace once
// its in-app-only error toast was dismissed.
describe("actionErr", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the real error message via console.error, in addition to returning it", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = actionErr(new Error("gofractional: capture produced no usable session"));

    expect(result).toEqual({ ok: false, error: "gofractional: capture produced no usable session" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("gigradar action error: gofractional: capture produced no usable session");
  });

  it("logs a non-Error thrown value's String() form, matching what's returned to the client", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = actionErr("a plain string throw");

    expect(result).toEqual({ ok: false, error: "a plain string throw" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("gigradar action error: a plain string throw");
  });

  it("never logs anything for a successful actionOk() result", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    actionOk({ fine: true });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
