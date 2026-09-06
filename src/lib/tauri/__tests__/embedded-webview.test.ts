// true-embedded-browser epic, embedded-automation-bridge story. Tests for
// embedded-webview.ts's find/click/type helpers -- specifically that
// owner-supplied search/type text is safely embedded into the generated
// JS via JSON.stringify() (never raw string concatenation, which would
// let a quote/backslash in `text` break out of the injected script and
// execute arbitrary JS against the embedded pane's own page). Live
// end-to-end behavior (real find/click/type against a real page) was
// verified this session via a live proof-of-concept against a real
// running Tauri instance -- see .pHive/epics/true-embedded-browser/docs/poc/
// and design-discussion.md §7; this suite covers the one thing a live
// POC doesn't: adversarial input to the script-generation itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/is-tauri", () => ({ isTauri: () => true }));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const {
  findEmbeddedElementByText,
  clickEmbeddedElementByText,
  typeIntoEmbeddedElementByText,
  setEmbeddedWebviewCookies,
  beginEmbeddedVisionSession,
  endEmbeddedVisionSession,
  captureEmbeddedVisionScreenshot,
  clickEmbeddedVisionPoint,
  typeEmbeddedVisionText,
} = await import("../embedded-webview.js");

function baseCookie(overrides: Partial<Parameters<typeof setEmbeddedWebviewCookies>[0][number]> = {}) {
  return {
    name: "session",
    value: "real-secret-value",
    domain: "example.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  };
}

function mockEvalResult(result: unknown) {
  invokeMock.mockResolvedValueOnce(JSON.stringify({ ok: true, result }));
}

describe("embedded-webview.ts find/click/type helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("findEmbeddedElementByText: safely embeds text containing a double quote via JSON.stringify (never raw concatenation)", async () => {
    mockEvalResult({ found: false });
    await findEmbeddedElementByText('Say "hello"');
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("embedded_webview_eval");
    const js = (args as { js: string }).js;
    // The dangerous raw substring must never appear un-escaped in the
    // generated script -- only its JSON-escaped form should.
    expect(js).toContain(JSON.stringify('Say "hello"'));
    expect(js).not.toContain('"Say "hello""');
  });

  it("findEmbeddedElementByText: safely embeds text containing a backslash and a closing-paren-like sequence", async () => {
    mockEvalResult({ found: false });
    await findEmbeddedElementByText("weird\\text)}();alert(1)");
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain(JSON.stringify("weird\\text)}();alert(1)"));
  });

  it("findEmbeddedElementByText: parses a real found result", async () => {
    mockEvalResult({ found: true, tag: "BUTTON", rect: { x: 1, y: 2, width: 3, height: 4 } });
    const result = await findEmbeddedElementByText("Submit");
    expect(result).toEqual({ found: true, tag: "BUTTON", rect: { x: 1, y: 2, width: 3, height: 4 } });
  });

  it("clickEmbeddedElementByText: safely embeds a quote-containing label", async () => {
    mockEvalResult({ clicked: true });
    await clickEmbeddedElementByText('The "Submit" button');
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain(JSON.stringify('The "Submit" button'));
  });

  it("typeIntoEmbeddedElementByText: safely embeds both the label AND the typed value", async () => {
    mockEvalResult({ typed: true });
    await typeIntoEmbeddedElementByText('Field "A"', 'value with "quotes" and \\backslash');
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain(JSON.stringify('Field "A"'));
    expect(js).toContain(JSON.stringify('value with "quotes" and \\backslash'));
  });

  it("throws a specific error when the eval result is ok:false, never swallowing the failure", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({ ok: false, error: "something broke" }));
    await expect(findEmbeddedElementByText("x")).rejects.toThrow(/something broke/);
  });

  it("throws a specific error when the raw eval result isn't valid JSON at all", async () => {
    invokeMock.mockResolvedValueOnce("not json");
    await expect(findEmbeddedElementByText("x")).rejects.toThrow(/non-JSON result/);
  });
});

// GRILL-TIME CORRECTION: setEmbeddedWebviewCookies() originally called a
// native embedded_webview_set_cookies Tauri command -- live-verified this
// session to compile and return Ok(()) but NOT actually work (the cookie
// never reached subsequent requests). Switched to document.cookie
// injection via the SAME already-proven embedded_webview_eval() path,
// live-verified working end to end against a real self-controlled test
// server. These tests cover the script-generation logic the live POC
// doesn't re-exercise on every run: safe escaping, HttpOnly skipping, and
// the cookie-string attribute assembly.
describe("setEmbeddedWebviewCookies", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("calls embedded_webview_eval with a script that assigns document.cookie for each non-HttpOnly cookie", async () => {
    mockEvalResult({ set: 1 });
    await setEmbeddedWebviewCookies([baseCookie()]);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("embedded_webview_eval");
    const js = (args as { js: string }).js;
    expect(js).toContain("document.cookie");
    expect(js).toContain(JSON.stringify("session=real-secret-value; path=/; secure; samesite=lax"));
  });

  it("skips HttpOnly cookies entirely -- document.cookie cannot set them -- and warns, without calling eval() at all if that's the only cookie", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setEmbeddedWebviewCookies([baseCookie({ httpOnly: true })]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipped 1 HttpOnly cookie"));
    warnSpy.mockRestore();
  });

  it("sets the settable cookies and warns about the skipped HttpOnly ones when both are present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEvalResult({ set: 1 });
    await setEmbeddedWebviewCookies([baseCookie({ name: "a" }), baseCookie({ name: "b", httpOnly: true })]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain('"a=real-secret-value');
    expect(js).not.toContain('"b=real-secret-value');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipped 1 HttpOnly cookie"));
    warnSpy.mockRestore();
  });

  it("safely embeds a cookie value containing a double quote via JSON.stringify", async () => {
    mockEvalResult({ set: 1 });
    await setEmbeddedWebviewCookies([baseCookie({ value: 'weird"value' })]);
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain(JSON.stringify('session=weird"value; path=/; secure; samesite=lax'));
  });

  it("includes an expires attribute only for a real expiry, never for a session cookie (-1)", async () => {
    mockEvalResult({ set: 1 });
    await setEmbeddedWebviewCookies([baseCookie({ expires: 1893456000 })]);
    const [, args] = invokeMock.mock.calls[0]!;
    const js = (args as { js: string }).js;
    expect(js).toContain("expires=");
  });
});

describe("embedded-vision-automation-mode bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("beginEmbeddedVisionSession / endEmbeddedVisionSession invoke the exact Rust command names with no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await beginEmbeddedVisionSession();
    expect(invokeMock).toHaveBeenCalledWith("embedded_vision_begin_session", undefined);

    invokeMock.mockResolvedValueOnce(undefined);
    await endEmbeddedVisionSession();
    expect(invokeMock).toHaveBeenCalledWith("embedded_vision_end_session", undefined);
  });

  it("captureEmbeddedVisionScreenshot wraps the raw base64 PNG the Rust side returns as a data: URL", async () => {
    invokeMock.mockResolvedValueOnce("QUJD");
    const dataUrl = await captureEmbeddedVisionScreenshot();
    expect(invokeMock).toHaveBeenCalledWith("embedded_webview_vision_capture", undefined);
    expect(dataUrl).toBe("data:image/png;base64,QUJD");
  });

  it("clickEmbeddedVisionPoint/typeEmbeddedVisionText pass their arguments through untouched -- no JS-injection surface here (plain Tauri command args, not a generated script)", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await clickEmbeddedVisionPoint(12.5, 340);
    expect(invokeMock).toHaveBeenCalledWith("embedded_webview_vision_click", { x: 12.5, y: 340 });

    invokeMock.mockResolvedValueOnce(undefined);
    await typeEmbeddedVisionText('say "hi"');
    expect(invokeMock).toHaveBeenCalledWith("embedded_webview_vision_type", { text: 'say "hi"' });
  });
});
