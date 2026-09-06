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

const { findEmbeddedElementByText, clickEmbeddedElementByText, typeIntoEmbeddedElementByText } = await import("../embedded-webview.js");

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
