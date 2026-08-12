import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mocked Anthropic client — per this story's testing contract, ZERO real
// API calls happen in this automated suite. vi.hoisted() so mockCreate /
// mockAnthropicConstructor exist before vi.mock()'s factory (which vitest
// hoists above these imports) runs.
const { mockCreate, mockAnthropicConstructor, mockDnsLookup } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockAnthropicConstructor: vi.fn(),
  // Callback-style, matching node:dns's real lookup() signature (extract.ts
  // promisifies it) -- (hostname, options, callback). Defaults (see
  // beforeEach below) resolve every hostname to a safe public address, so
  // every pre-existing test in this file keeps working without knowing
  // about SSRF validation at all; individual ssrf-hardening tests below
  // override this per-call to simulate a hostname resolving to a blocked
  // range. NEVER hits a real resolver -- fully hermetic.
  mockDnsLookup: vi.fn(),
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

vi.mock("node:dns", () => ({
  lookup: mockDnsLookup,
}));

import { detectLoginWall, extractProfile, htmlToText } from "../extract.js";

const mockFetch = vi.fn();
/** Captured before any vi.stubGlobal("fetch", ...) call, for the timeout/size-cap tests below that need a REAL fetch() against a local node:http test server rather than the mocked one. */
const realFetch = globalThis.fetch;

type DnsCallback = (err: NodeJS.ErrnoException | null, addresses?: { address: string; family: number }[]) => void;

/** A benign public address every hostname resolves to by default, so pre-existing tests (written before this story) don't need to know SSRF validation exists. */
const SAFE_PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };

beforeEach(() => {
  mockCreate.mockReset();
  mockAnthropicConstructor.mockReset();
  mockFetch.mockReset();
  mockDnsLookup.mockReset();
  mockDnsLookup.mockImplementation((_hostname: string, _options: unknown, callback: DnsCallback) => {
    callback(null, [SAFE_PUBLIC_ADDRESS]);
  });
  // Fallback Anthropic response for any call a test doesn't explicitly
  // queue via mockResolvedValueOnce -- e.g. the ssrf-hardening tests below
  // that assert on warnings/fetch-call-count and don't care what the LLM
  // "returned". Individual mockResolvedValueOnce() calls still take
  // priority for any test that DOES care.
  mockCreate.mockResolvedValue(fakeExtractToolResponse([], []));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Queues one dns.lookup() resolution (for the mocked "node:dns" module) for the next call only. */
function mockDnsResolvesTo(...addresses: { address: string; family: number }[]) {
  mockDnsLookup.mockImplementationOnce((_hostname: string, _options: unknown, callback: DnsCallback) => {
    callback(null, addresses);
  });
}

/** Queues one dns.lookup() failure (e.g. NXDOMAIN) for the next call only. */
function mockDnsRejects(code: string) {
  mockDnsLookup.mockImplementationOnce((_hostname: string, _options: unknown, callback: DnsCallback) => {
    const err = Object.assign(new Error(`getaddrinfo ${code}`), { code });
    callback(err);
  });
}

/** Spins up a local, real node:http server for the timeout/size-cap tests -- no real network dependency (loopback only), and no involvement of mockFetch. Caller must call the returned close(). */
async function startTestServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        // Forcibly drop any lingering connections (e.g. one an
        // AbortController just cut off mid-stream) so close() can't hang
        // waiting for a socket that will never close on its own.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

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

// ---------------------------------------------------------------------------
// ssrf-hardening story: pre-fetch IP validation, timeout, streaming size cap,
// and the generic-error-message fix in fetchAndExtractLink().
// ---------------------------------------------------------------------------

describe("fetchAndExtractLink(): SSRF IP validation (AC1-AC5)", () => {
  it("AC1: a hostname resolving to 127.0.0.1 (loopback) is blocked with a warning, never throws, and fetch() is never called", async () => {
    mockDnsResolvesTo({ address: "127.0.0.1", family: 4 });
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Engineer"], []));

    const result = await extractProfile({ resumeText: "resume content", links: ["https://looks-fine.example/profile"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
    // The raw resolved IP is never echoed back.
    expect(result.warnings[0]).not.toContain("127.0.0.1");
  });

  it("AC2: a hostname resolving to 169.254.169.254 (the real cloud metadata IP) is blocked the same way -- proves link-local, not just loopback/RFC1918, is covered", async () => {
    mockDnsResolvesTo({ address: "169.254.169.254", family: 4 });

    const result = await extractProfile({ resumeText: "resume content", links: ["https://metadata.example/latest"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.warnings[0]).not.toContain("169.254.169.254");
  });

  it("AC3: a hostname that does NOT look internal in its literal text but DNS-resolves to a private RFC1918 address is still blocked -- proves resolution-based, not literal-string-based, checking", async () => {
    // The hostname text itself gives no hint of anything internal.
    mockDnsResolvesTo({ address: "10.0.0.5", family: 4 });

    const result = await extractProfile({ resumeText: "resume content", links: ["https://totally-normal-looking-site.example/careers"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("AC3b: 172.16.0.0/12 and 192.168.0.0/16 (the other two RFC1918 ranges) are also blocked", async () => {
    mockDnsResolvesTo({ address: "172.20.3.4", family: 4 });
    const result1 = await extractProfile({ resumeText: "resume content", links: ["https://site-a.example"] }, "fake-api-key");
    expect(result1.warnings).toHaveLength(1);
    expect(result1.warnings[0]?.toLowerCase()).toContain("private/internal address");

    mockDnsResolvesTo({ address: "192.168.1.1", family: 4 });
    const result2 = await extractProfile({ resumeText: "resume content", links: ["https://site-b.example"] }, "fake-api-key");
    expect(result2.warnings).toHaveLength(1);
    expect(result2.warnings[0]?.toLowerCase()).toContain("private/internal address");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("AC4: an IPv4-mapped IPv6 address (::ffff:127.0.0.1) is normalized and blocked the same as its embedded IPv4 form", async () => {
    mockDnsResolvesTo({ address: "::ffff:127.0.0.1", family: 6 });

    const result = await extractProfile({ resumeText: "resume content", links: ["https://mapped.example"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.warnings[0]).not.toContain("127.0.0.1");
    expect(result.warnings[0]).not.toContain("::ffff");
  });

  it("AC4b: a real IPv6 loopback (::1) and IPv6 link-local (fe80::1) are also blocked", async () => {
    mockDnsResolvesTo({ address: "::1", family: 6 });
    const result1 = await extractProfile({ resumeText: "resume content", links: ["https://v6-loopback.example"] }, "fake-api-key");
    expect(result1.warnings[0]?.toLowerCase()).toContain("private/internal address");

    mockDnsResolvesTo({ address: "fe80::1", family: 6 });
    const result2 = await extractProfile({ resumeText: "resume content", links: ["https://v6-linklocal.example"] }, "fake-api-key");
    expect(result2.warnings[0]?.toLowerCase()).toContain("private/internal address");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks when ANY resolved address (not just the first) falls in a blocked range", async () => {
    mockDnsResolvesTo({ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 });

    const result = await extractProfile({ resumeText: "resume content", links: ["https://multi-address.example"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("AC5: a non-http(s) scheme (file://) is rejected outright, before any DNS resolution is attempted", async () => {
    const result = await extractProfile({ resumeText: "resume content", links: ["file:///etc/passwd"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("http/https");
    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("AC5b: another non-http(s) scheme (ftp://) is also rejected outright, before any DNS resolution is attempted", async () => {
    const result = await extractProfile({ resumeText: "resume content", links: ["ftp://files.example/archive.zip"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain("http/https");
    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a hostname that fails to resolve at all fails closed (blocked with a warning, not a raw DNS error, and fetch() is never called)", async () => {
    mockDnsRejects("ENOTFOUND");

    const result = await extractProfile({ resumeText: "resume content", links: ["https://does-not-resolve.example"] }, "fake-api-key");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain("ENOTFOUND");
    expect(result.warnings[0]).not.toContain("getaddrinfo");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchAndExtractLink(): timeout and streaming size cap (AC6-AC7)", () => {
  it(
    "AC6: a server that never responds causes fetchAndExtractLink() to time out at ~10s and return a warning, not hang indefinitely",
    async () => {
      const server = await startTestServer(() => {
        // Deliberately never calls res.end() or res.write() -- the request hangs forever unless the timeout aborts it.
      });
      // Use the REAL fetch() against this real local server, not the mocked one.
      vi.stubGlobal("fetch", realFetch);

      try {
        const started = Date.now();
        const result = await extractProfile({ resumeText: "resume content", links: [server.url] }, "fake-api-key");
        const elapsedMs = Date.now() - started;

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("couldn't fetch this link");
        // "Approximately" 10s -- generous bounds to avoid CI flakiness while still proving it's bounded, not infinite.
        expect(elapsedMs).toBeGreaterThanOrEqual(9000);
        expect(elapsedMs).toBeLessThan(14000);
      } finally {
        await server.close();
      }
    },
    { timeout: 20000 },
  );

  it("AC7: a server streaming a response larger than 5MB is aborted partway through and returns a 'too large' warning, not an unbounded read", async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      // Stream far more than the 5MB cap, in small chunks, so a naive
      // "await response.text()" implementation would buffer it all. Keep
      // writing until the client disconnects (which the size-cap abort
      // should trigger) or we hit a generous chunk ceiling as a safety net.
      const chunk = "a".repeat(64 * 1024);
      let written = 0;
      const maxChunks = 200; // 200 * 64KB = 12.5MB, well over the 5MB cap
      const writeMore = () => {
        if (written >= maxChunks) {
          res.end();
          return;
        }
        written++;
        const ok = res.write(chunk);
        if (ok) setImmediate(writeMore);
        else res.once("drain", writeMore);
      };
      writeMore();
      res.on("close", () => {
        /* client (our size-cap abort) disconnected -- expected */
      });
    });
    vi.stubGlobal("fetch", realFetch);

    try {
      const result = await extractProfile({ resumeText: "resume content", links: [server.url] }, "fake-api-key");

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.toLowerCase()).toContain("too large");
    } finally {
      await server.close();
    }
  });

  it(
    "a slow-trickle server (responds immediately, then drips data forever, staying under the size cap) is still bounded by the timeout -- not left connected indefinitely",
    async () => {
      const server = await startTestServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        // Headers arrive immediately (fetch() resolves fast), then a tiny
        // trickle of bytes forever -- well under the 5MB cap even after
        // many seconds, so ONLY a timeout that covers the body-read phase
        // (not just the initial fetch() call) can ever end this.
        const interval = setInterval(() => {
          res.write("x");
        }, 200);
        res.on("close", () => clearInterval(interval));
      });
      vi.stubGlobal("fetch", realFetch);

      try {
        const started = Date.now();
        const result = await extractProfile({ resumeText: "resume content", links: [server.url] }, "fake-api-key");
        const elapsedMs = Date.now() - started;

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("couldn't fetch this link");
        // Same ~10s bound as AC6 -- proves the timeout governs the WHOLE
        // operation (headers + body streaming), not just fetch() resolving.
        expect(elapsedMs).toBeGreaterThanOrEqual(9000);
        expect(elapsedMs).toBeLessThan(14000);
      } finally {
        await server.close();
      }
    },
    { timeout: 20000 },
  );
});

describe("fetchAndExtractLink(): no raw error detail ever reaches the caller (AC8)", () => {
  it("AC8: a fetch() rejection with a real, distinctive error message never has that raw message appear in the returned warning -- only the fixed generic message does", async () => {
    const distinctiveRawMessage = "ECONNREFUSED-super-specific-internal-detail-12345";
    mockFetch.mockRejectedValueOnce(new Error(distinctiveRawMessage));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await extractProfile({ resumeText: "resume content", links: ["https://refuses-connection.example"] }, "fake-api-key");

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).not.toContain(distinctiveRawMessage);
      expect(result.warnings[0]).toContain("couldn't fetch this link");
      // The detail IS still logged server-side, per this story's contract.
      const loggedSomewhere = consoleErrorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(distinctiveRawMessage) || (arg instanceof Error && arg.message === distinctiveRawMessage)));
      expect(loggedSomewhere).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("fetchAndExtractLink(): legitimate public URL happy path is unchanged (AC9, regression)", () => {
  it("AC9: a normal, legitimate public URL works exactly as before this story -- no warning, real content extracted", async () => {
    const url = "https://janedoe.dev/portfolio";
    mockFetch.mockResolvedValueOnce(
      fakeFetchResponse({
        url,
        body: "<html><body><h1>Jane Doe</h1><p>Fractional CTO available for engagements.</p></body></html>",
        contentType: "text/html",
      }),
    );
    mockCreate.mockResolvedValueOnce(fakeExtractToolResponse(["Fractional CTO"], ["Leadership"]));

    const result = await extractProfile({ links: [url] }, "fake-api-key");

    expect(result.warnings).toEqual([]);
    expect(result.roles).toEqual(["Fractional CTO"]);
    expect(result.skills).toEqual(["Leadership"]);
    // fetch() was reached (validation passed) and called with the AbortSignal-bearing options.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(fetchOptions?.signal).toBeInstanceOf(AbortSignal);
  });
});
