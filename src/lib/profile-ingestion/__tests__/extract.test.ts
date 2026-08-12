import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mocked Anthropic client — per this story's testing contract, ZERO real
// API calls happen in this automated suite. vi.hoisted() so mockCreate /
// mockAnthropicConstructor exist before vi.mock()'s factory (which vitest
// hoists above these imports) runs.
const { mockCreate, mockAnthropicConstructor } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockAnthropicConstructor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
    constructor(options: unknown) {
      mockAnthropicConstructor(options);
    }
  }
  return { default: FakeAnthropic };
});

import { detectLoginWall, extractProfile, htmlToText } from "../extract.js";

const mockFetch = vi.fn();

beforeEach(() => {
  mockCreate.mockReset();
  mockAnthropicConstructor.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds a fake fetch() Response covering exactly the surface extract.ts reads: .url, .status, .ok, .redirected, .headers.get(), .text(). */
function fakeFetchResponse(opts: {
  url: string;
  status?: number;
  ok?: boolean;
  redirected?: boolean;
  contentType?: string | null;
  body: string;
}): Response {
  return {
    url: opts.url,
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    redirected: opts.redirected ?? false,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? (opts.contentType ?? "text/html; charset=utf-8") : null),
    },
    text: async () => opts.body,
  } as unknown as Response;
}

/** Builds a canned Anthropic Messages API response carrying the expected extract_profile tool_use block. */
function fakeExtractToolResponse(roles: string[], skills: string[]) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_test", name: "extract_profile", input: { roles, skills } }],
    model: "claude-opus-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** Pulls every "text" content block's `.text` out of the single messages.create() call, for assertions about what actually reached the LLM. */
function textBlocksSentToLLM(): string[] {
  const call = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParams | undefined;
  if (!call) throw new Error("test setup: messages.create() was not called");
  const content = call.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error("test setup: expected an array of content blocks");
  return content.filter((block): block is Anthropic.TextBlockParam => block.type === "text").map((block) => block.text);
}

describe("extractProfile: plain-text resume, no links (AC1)", () => {
  it("returns {roles, skills, warnings: []} derived from the mocked Anthropic client's structured response", async () => {
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Fractional CTO", "Senior Backend Engineer"], ["TypeScript", "Node.js"]));

    const result = await extractProfile({ resumeText: "Jane Doe — 10 years building backend systems." }, "fake-api-key");

    expect(result).toEqual({
      roles: ["Fractional CTO", "Senior Backend Engineer"],
      skills: ["TypeScript", "Node.js"],
      warnings: [],
    });
  });

  it("sends the resume text as a plain text content block, not a document block", async () => {
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse([], []));

    await extractProfile({ resumeText: "Jane Doe — backend engineer." }, "fake-api-key");

    const call = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    const content = call.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content.some((b) => b.type === "document")).toBe(false);
    expect(textBlocksSentToLLM().some((t) => t.includes("Jane Doe — backend engineer."))).toBe(true);
  });

  it("requests structured output via tool-use (forced tool_choice on the extract_profile tool), not free-text parsing", async () => {
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse([], []));

    await extractProfile({ resumeText: "some resume text" }, "fake-api-key");

    const call = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(call.tool_choice).toEqual({ type: "tool", name: "extract_profile" });
    expect(call.tools?.some((t) => t.name === "extract_profile")).toBe(true);
  });
});

describe("extractProfile: PDF resume (AC2)", () => {
  it("constructs the Anthropic request with a native PDF document content block — no local text extraction performed", async () => {
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Engineer"], ["Python"]));
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes for testing, not a real PDF");

    const result = await extractProfile({ resumeFile: { data: pdfBytes, mediaType: "application/pdf" } }, "fake-api-key");

    expect(result.roles).toEqual(["Engineer"]);
    const call = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    const content = call.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    const documentBlock = content.find((b): b is Anthropic.DocumentBlockParam => b.type === "document");
    expect(documentBlock).toBeDefined();
    expect(documentBlock?.source).toMatchObject({
      type: "base64",
      media_type: "application/pdf",
      data: pdfBytes.toString("base64"),
    });
    // No local text-extraction fallback: the raw PDF bytes never appear as
    // a plain text content block anywhere in the request.
    expect(textBlocksSentToLLM().some((t) => t.includes("fake pdf bytes for testing"))).toBe(false);
  });
});

describe("extractProfile: script/style stripping before extraction (AC3, grill H1)", () => {
  it("given a link whose HTML contains real <script> and <style> blocks, neither the script nor style text appears in what's sent to the LLM call", async () => {
    const url = "https://janedoe.dev/about";
    const html = `<!doctype html>
<html>
<head>
  <style>
    body { background: LEAK_STYLE_MARKER_color_should_not_appear; }
    .hero::before { content: "also leaked style content"; }
  </style>
  <script>
    var secretToken = "LEAK_SCRIPT_MARKER_should_not_appear";
    function trackEvent() { console.log("evil analytics call", secretToken); }
  </script>
</head>
<body>
  <h1>Jane Doe</h1>
  <p>Backend engineer with experience in Go, Kubernetes, and distributed systems.</p>
</body>
</html>`;
    mockFetch.mockResolvedValueOnce(fakeFetchResponse({ url, body: html, contentType: "text/html" }));
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Backend Engineer"], ["Go", "Kubernetes"]));

    const result = await extractProfile({ links: [url] }, "fake-api-key");

    expect(result.warnings).toEqual([]);
    const sentText = textBlocksSentToLLM().join("\n");
    expect(sentText).not.toContain("LEAK_STYLE_MARKER_color_should_not_appear");
    expect(sentText).not.toContain("also leaked style content");
    expect(sentText).not.toContain("LEAK_SCRIPT_MARKER_should_not_appear");
    expect(sentText).not.toContain("evil analytics call");
    expect(sentText).not.toContain("<script");
    expect(sentText).not.toContain("<style");
    // The real visible content DOES make it through.
    expect(sentText).toContain("Jane Doe");
    expect(sentText).toContain("Backend engineer");
    expect(sentText).toContain("Kubernetes");
  });
});

describe("extractProfile: known LinkedIn-style login-wall (AC4, grill H2)", () => {
  it("given a link that returns a LinkedIn-style authwall redirect, it produces a specific 'may require login' warning, does NOT abort the call, and other input still contributes to the result", async () => {
    const linkedInUrl = "https://www.linkedin.com/in/somebody";
    mockFetch.mockResolvedValueOnce(
      fakeFetchResponse({
        url: "https://www.linkedin.com/authwall?trk=public_profile&trkInfo=redirect",
        redirected: true,
        body: "<html><body>Sign in to continue - LinkedIn login form markup</body></html>",
        contentType: "text/html",
      }),
    );
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Fractional CTO"], ["Leadership"]));

    const result = await extractProfile({ resumeText: "Jane Doe resume content", links: [linkedInUrl] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(linkedInUrl);
    expect(result.warnings[0]?.toLowerCase()).toContain("may require login");

    // The call was NOT aborted — the resume still contributed to a real result.
    expect(result.roles).toEqual(["Fractional CTO"]);
    expect(result.skills).toEqual(["Leadership"]);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // The LinkedIn login-wall page content never reached the LLM call.
    const sentText = textBlocksSentToLLM().join("\n");
    expect(sentText).not.toContain("LinkedIn login form markup");
    expect(sentText).toContain("Jane Doe resume content");
  });

  it("given a generic (non-LinkedIn) 3xx redirect to a /login path, it is also flagged as a login-wall by the same signature-based rule", async () => {
    const url = "https://example.com/profile/jane";
    mockFetch.mockResolvedValueOnce(
      fakeFetchResponse({
        url: "https://example.com/login?next=/profile/jane",
        redirected: true,
        body: "<html><body>Please sign in</body></html>",
      }),
    );
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse([], []));

    const result = await extractProfile({ resumeText: "resume text", links: [url] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("may require login");
  });
});

describe("extractProfile: short-but-legitimate page is NOT flagged as a login-wall (AC5, grill H2 regression)", () => {
  it("given a link that returns a normal, short, valid page (a minimal portfolio site), it is processed normally and contributes real content — not flagged just because the body is short", async () => {
    const url = "https://janedoe.dev";
    const shortHtml = "<html><body><h1>Jane Doe</h1><p>Portfolio.</p></body></html>";
    mockFetch.mockResolvedValueOnce(fakeFetchResponse({ url, body: shortHtml, redirected: false, status: 200 }));
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Designer"], ["Figma"]));

    const result = await extractProfile({ links: [url] }, "fake-api-key");

    expect(result.warnings).toEqual([]);
    const sentText = textBlocksSentToLLM().join("\n");
    expect(sentText).toContain("Jane Doe");
    expect(sentText).toContain("Portfolio.");
    expect(result.roles).toEqual(["Designer"]);
  });
});

describe("extractProfile: partial link failure never fails the overall call", () => {
  it("given a network error on one link, that link produces a warning while the resume and result still succeed", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network unreachable"));
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Engineer"], ["Rust"]));

    const result = await extractProfile({ resumeText: "resume content here", links: ["https://unreachable.example"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("https://unreachable.example");
    expect(result.roles).toEqual(["Engineer"]);
    expect(result.skills).toEqual(["Rust"]);
  });
});

describe("extractProfile: Anthropic client is constructed per-call, never at module scope", () => {
  it("constructs a new Anthropic client on each extractProfile() call, with the exact apiKey passed in", async () => {
    mockCreate.mockResolvedValue(fakeExtractToolResponse([], []));

    await extractProfile({ resumeText: "a" }, "key-one");
    await extractProfile({ resumeText: "b" }, "key-two");

    expect(mockAnthropicConstructor).toHaveBeenCalledTimes(2);
    expect(mockAnthropicConstructor).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: "key-one" }));
    expect(mockAnthropicConstructor).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: "key-two" }));
  });
});

describe("extractProfile: no secret or personal data ever appears in a thrown error message (AC8)", () => {
  it("when no resume and no usable link content is provided, the thrown error never echoes the apiKey", async () => {
    const apiKey = "sk-ant-super-secret-key-should-not-leak";

    await expect(extractProfile({}, apiKey)).rejects.toThrow();
    try {
      await extractProfile({}, apiKey);
      throw new Error("expected extractProfile() to throw");
    } catch (e) {
      expect((e as Error).message).not.toContain(apiKey);
    }
  });

  it("when the Anthropic response omits the expected tool_use block, the thrown error names the structural problem, never the apiKey or resume content", async () => {
    mockCreate.mockResolvedValueOnce({ ...fakeExtractToolResponse([], []), content: [{ type: "text", text: "free-text response instead" }] });
    const apiKey = "sk-ant-another-secret-key";
    const resumeText = "Jane Doe's private resume content";

    try {
      await extractProfile({ resumeText }, apiKey);
      throw new Error("expected extractProfile() to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain(apiKey);
      expect(message).not.toContain(resumeText);
      expect(message.toLowerCase()).toContain("structured extraction result");
    }
  });
});

describe("detectLoginWall(): signature-based, not a length/content heuristic (grill H2)", () => {
  it("flags a LinkedIn authwall URL", () => {
    expect(
      detectLoginWall({
        requestedUrl: "https://www.linkedin.com/in/someone",
        finalUrl: "https://www.linkedin.com/authwall?trk=x",
        status: 200,
        redirected: true,
      }),
    ).toBe(true);
  });

  it("flags a LinkedIn checkpoint/challenge URL", () => {
    expect(
      detectLoginWall({
        requestedUrl: "https://www.linkedin.com/in/someone",
        finalUrl: "https://www.linkedin.com/checkpoint/challenge",
        status: 200,
        redirected: true,
      }),
    ).toBe(true);
  });

  it("flags a generic 3xx redirect landing on a /login path", () => {
    expect(
      detectLoginWall({
        requestedUrl: "https://example.com/profile",
        finalUrl: "https://example.com/login",
        status: 302,
        redirected: true,
      }),
    ).toBe(true);
  });

  it("does NOT flag a normal 200 response with no redirect and no login-path signature, regardless of how short the requested URL or its (irrelevant, unused-by-this-function) content would be", () => {
    expect(
      detectLoginWall({
        requestedUrl: "https://janedoe.dev",
        finalUrl: "https://janedoe.dev",
        status: 200,
        redirected: false,
      }),
    ).toBe(false);
  });

  it("does NOT flag a redirect that lands somewhere other than a login path", () => {
    expect(
      detectLoginWall({
        requestedUrl: "https://example.com/old-url",
        finalUrl: "https://example.com/new-url",
        status: 200,
        redirected: true,
      }),
    ).toBe(false);
  });
});

describe("htmlToText(): script/style removal is element-and-content, not tag-only", () => {
  it("removes <script> and <style> elements entirely (tag + content), keeps visible text, and decodes basic HTML entities", () => {
    const html = `<html><head><style>.x{color:red}</style><script>var x = "leak";</script></head>` + `<body><p>Fish &amp; Chips &mdash; caf&#39;e</p></body></html>`;

    const text = htmlToText(html);

    expect(text).not.toContain("color:red");
    expect(text).not.toContain("leak");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<style");
    expect(text).toContain("Fish & Chips");
    expect(text).toContain("caf'e");
  });

  it("does not false-positive strip ordinary body text that merely contains the substrings 'script' or 'style' as words", () => {
    const html = "<html><body><p>I write scripts for a living and love good style.</p></body></html>";

    const text = htmlToText(html);

    expect(text).toContain("I write scripts for a living and love good style.");
  });
});
