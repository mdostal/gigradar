// Resume/link → { roles, skills } extraction via Claude's Messages API.
// profile-overview-ingestion epic, profile-ingestion-module story — the
// foundation module the epic's later UI/Server-Action stories build on. See
// .pHive/epics/profile-overview-ingestion/docs/design-discussion.md §3
// step 2.
//
// In-memory only: the resume bytes and any fetched link text exist for the
// duration of one extractProfile() call and are never written to disk by
// this module. Nothing here persists anything — persistence, if any, is
// entirely the caller's concern (an explicit user Save elsewhere).
//
// THE ANTHROPIC CLIENT AND apiKey ARE NEVER HELD AT MODULE SCOPE. Both are
// constructed/used strictly inside extractProfile(), per call — never a
// module-level `const client = new Anthropic(...)`. This is deliberate,
// not an oversight: the Next.js app's Server Action request path never
// populates a secret at import time, so a module-scope client would
// permanently capture `undefined` on first import (see design-discussion.md
// §3 step 4's collaborative-review finding).
//
// Secret/personal-data handling contract: the API key, the resume's raw
// content, and any extracted personal data (name, skills, roles, fetched
// link text) are NEVER logged and NEVER included in a thrown error message
// — errors here describe what went wrong structurally (a missing tool_use
// block, a fetch failure), never the content itself. If you touch this
// file, keep auditing that invariant.
import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const dnsLookupAsync = promisify(dnsLookup);

/** One input to extractProfile(): a resume (as a PDF file or plain text), and/or public links to fetch and include as additional context. */
export interface ExtractProfileInput {
  /** A PDF resume, sent to Claude as a native PDF document content block — never locally text-extracted (see buildResumeContentBlock() below). */
  resumeFile?: { data: Buffer; mediaType: string };
  /** A plain-text resume, sent as a text content block. Mutually exclusive with resumeFile in practice, but this module does not enforce that — a caller providing both gets both included. */
  resumeText?: string;
  /** Public URLs to fetch and include as additional context (e.g. a GitHub profile or personal portfolio). */
  links?: string[];
}

/** extractProfile()'s result: the extracted structured data, plus a warnings entry for every link that couldn't be used (never a hard failure for the whole call). */
export interface ExtractProfileResult {
  roles: string[];
  skills: string[];
  warnings: string[];
}

const EXTRACT_TOOL_NAME = "extract_profile";

/**
 * Known LinkedIn login-wall/authwall URL signatures — checked against BOTH
 * the originally-requested URL and the final URL fetch() landed on (in
 * case a redirect chain retargeted the request). Deliberately specific
 * (authwall, the login form path, the checkpoint/challenge path) rather
 * than "any linkedin.com URL", so a link that's genuinely a public
 * linkedin.com page (if one existed) wouldn't false-positive.
 */
const LINKEDIN_LOGIN_WALL_PATTERN = /linkedin\.com\/(authwall|uas\/login|checkpoint)/i;

/** A generic `/login`, `/signin`, or `/sign-in` path — checked ONLY against a URL fetch() actually redirected to (see detectLoginWall() below), never against page content or length. */
const GENERIC_LOGIN_PATH_PATTERN = /\/(login|signin|sign-in)(?:[/?#]|$)/i;

/**
 * Signature-based login-wall detection — per grill finding H2, this is
 * DELIBERATELY NOT a length/content heuristic. A link is flagged only when
 * it matches one of two known signatures:
 *   1. A LinkedIn-specific authwall/login/checkpoint URL (requested or
 *      landed-on).
 *   2. A generic HTTP redirect (fetch() already followed it, so this is
 *      read off `response.redirected`/`response.url`, or a raw 3xx status
 *      if the caller used `redirect: "manual"`) that lands on a
 *      `/login`/`/signin`/`/sign-in` path.
 * A legitimately short page that matches neither signature is NOT flagged
 * — see extract.test.ts's short-portfolio-page regression test.
 */
export function detectLoginWall(check: {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirected: boolean;
}): boolean {
  if (LINKEDIN_LOGIN_WALL_PATTERN.test(check.finalUrl) || LINKEDIN_LOGIN_WALL_PATTERN.test(check.requestedUrl)) {
    return true;
  }
  if (check.redirected && GENERIC_LOGIN_PATH_PATTERN.test(check.finalUrl)) return true;
  if (check.status >= 300 && check.status < 400 && GENERIC_LOGIN_PATH_PATTERN.test(check.finalUrl)) return true;
  return false;
}

const HTML_ENTITY_REPLACEMENTS: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeBasicHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => HTML_ENTITY_REPLACEMENTS[match] ?? match);
}

/**
 * HTML → visible text. Per grill finding H1: `<script>` and `<style>`
 * ELEMENTS (tag + their full text content) are stripped ENTIRELY first, as
 * their own dedicated pass — before the general tag-stripping regex runs.
 * A naive "just strip `<...>` markup" implementation would leave raw
 * JavaScript/CSS source sitting in the extracted text as if it were page
 * content, which is exactly what this two-pass order prevents. See
 * extract.test.ts's script/style fixture test.
 */
export function htmlToText(html: string): string {
  const withoutScriptsAndStyles = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScriptsAndStyles.replace(/<[^>]+>/g, " ");
  return decodeBasicHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
}

type LinkFetchResult = { text: string } | { warning: string };

/** Wall-clock cap on the whole fetch() call — see design-discussion.md §3 step 3. */
const FETCH_TIMEOUT_MS = 10_000;

/** Hard cap on the response body, enforced by streaming (never trusting Content-Length alone — it can be missing or spoofed). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Unwraps an IPv4-mapped IPv6 address (e.g. `::ffff:127.0.0.1`) to its
 * embedded IPv4 form. Returns the input unchanged if it isn't in that
 * form. MUST run before range-checking — an address in this form hides a
 * (possibly blocked) IPv4 address inside IPv6 syntax, a known SSRF
 * bypass if IPv4/IPv6 are checked as unrelated cases (grill finding H1,
 * design-discussion.md §3 step 3).
 */
function unwrapIpv4MappedIpv6(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1] ?? address;
}

/** loopback (127.0.0.0/8), link-local (169.254.0.0/16 — covers the cloud metadata IP 169.254.169.254), RFC1918 private. */
function isIpv4InBlockedRange(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** loopback (::1), link-local (fe80::/10 — same range family that covers the cloud metadata IP on the IPv4 side). */
function isIpv6InBlockedRange(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  return false;
}

const IPV4_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Pre-fetch validation, mirroring detectLoginWall()'s "reject early,
 * specific warning" shape: rejects non-http(s) schemes outright (before
 * any DNS resolution), then resolves the hostname via a REAL DNS lookup
 * (not literal-string matching — a hostname could resolve to a blocked
 * range even if its literal text doesn't look internal) and rejects if
 * ANY resolved address is loopback, link-local, or RFC1918 private, after
 * normalizing IPv4-mapped IPv6 addresses to their embedded IPv4 form.
 * Returns a warning string when the target is blocked, or `undefined`
 * when it's safe to fetch. NEVER throws — DNS resolution failure fails
 * closed (treated as "can't fetch", not surfaced as an exception) and
 * NEVER echoes the raw resolved IP or DNS error detail into the warning.
 */
async function findBlockedTargetWarning(url: string): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Couldn't fetch "${url}": invalid URL.`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Couldn't fetch "${url}": only http/https links are supported.`;
  }

  let resolved: { address: string }[];
  try {
    resolved = await dnsLookupAsync(parsed.hostname, { all: true });
  } catch (e) {
    console.error(`fetchAndExtractLink: DNS resolution failed for "${parsed.hostname}":`, e);
    return `Couldn't fetch "${url}": couldn't resolve this link's address.`;
  }

  for (const { address: rawAddress } of resolved) {
    const address = unwrapIpv4MappedIpv6(rawAddress);
    const blocked = IPV4_PATTERN.test(address) ? isIpv4InBlockedRange(address) : isIpv6InBlockedRange(address);
    if (blocked) {
      return `Couldn't fetch "${url}": this link points to a private/internal address and can't be fetched.`;
    }
  }

  return undefined;
}

/** Thrown internally by readBodyWithSizeCap() when the response body exceeds MAX_RESPONSE_BYTES; caught and turned into a warning, never propagated. */
class ResponseTooLargeError extends Error {}

/**
 * Reads a fetch() Response body as text, enforcing MAX_RESPONSE_BYTES by
 * streaming via response.body's reader — NOT by trusting Content-Length,
 * which can be missing or spoofed. Aborts the underlying request (via the
 * shared AbortController) the moment the cap is exceeded, so an
 * oversized response never gets fully buffered into memory. Falls back
 * to response.text() when a body stream isn't available (e.g. a fetch
 * implementation without streaming support), preserving prior behavior
 * for that case.
 */
async function readBodyWithSizeCap(response: Response, controller: AbortController): Promise<string> {
  const body = response.body;
  if (!body) {
    return await response.text();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError("response body exceeded the size cap");
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(combined);
}

/**
 * Fetches one link and returns either its extracted visible text or a
 * warning describing why it couldn't be used. NEVER throws — a failed
 * link becomes a warnings entry, per this story's partial-failure
 * contract (the resume and every other link still contribute to the
 * result). A known login-wall gets the specific "may require login"
 * wording the acceptance criteria require; a blocked SSRF target or an
 * oversized/timed-out response each get their own specific warning;
 * every other failure gets a FIXED, generic message — the real error
 * detail is logged server-side only (console.error) and NEVER appears in
 * the returned warning string (never a resolved secret, personal data,
 * raw resolved IP, or raw exception text — link failures never carry
 * any of those).
 */
async function fetchAndExtractLink(url: string): Promise<LinkFetchResult> {
  const blockedWarning = await findBlockedTargetWarning(url);
  if (blockedWarning) {
    return { warning: blockedWarning };
  }

  // ONE timeout governs the WHOLE operation — fetch() resolving (headers
  // arriving) AND the subsequent body-streaming read — not just the
  // initial fetch() call. A naive `clearTimeout` right after `fetch()`
  // resolves leaves the body-read phase completely unbounded in time
  // (only the MAX_RESPONSE_BYTES cap would apply), which a slow-trickle
  // server could exploit to hold the connection open indefinitely while
  // staying under the size cap — a real gap caught during this story's
  // own review, fixed before merge, not left as a silent scope cut like
  // the (separately, explicitly accepted) DNS-rebinding gap.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (e) {
      console.error(`fetchAndExtractLink: fetch failed for "${url}":`, e);
      return { warning: `Couldn't fetch "${url}": couldn't fetch this link.` };
    }

    const finalUrl = response.url || url;
    if (
      detectLoginWall({
        requestedUrl: url,
        finalUrl,
        status: response.status,
        redirected: response.redirected,
      })
    ) {
      return { warning: `Couldn't use "${url}" — it may require login.` };
    }

    if (!response.ok) {
      return { warning: `Couldn't fetch "${url}": server responded with HTTP ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return { warning: `Couldn't use "${url}": unsupported content type "${contentType || "unknown"}".` };
    }

    let html: string;
    try {
      html = await readBodyWithSizeCap(response, controller);
    } catch (e) {
      if (e instanceof ResponseTooLargeError) {
        return { warning: `Couldn't use "${url}": the response was too large to process.` };
      }
      // A slow-trickle response that never finished streaming before the
      // shared timeout fired aborts the reader, which surfaces here as a
      // generic stream-read error — same fixed, generic warning as any
      // other fetch failure, never distinguished in a way that leaks
      // timing detail to the caller.
      console.error(`fetchAndExtractLink: reading response body failed for "${url}":`, e);
      return { warning: `Couldn't fetch "${url}": couldn't fetch this link.` };
    }

    return { text: htmlToText(html) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Builds the resume's content block: a native PDF document block when
 * `resumeFile` is provided (never locally text-extracted — Claude reads
 * the PDF directly), or a plain text block for `resumeText`. Returns
 * `undefined` if neither is provided.
 */
function buildResumeContentBlock(input: ExtractProfileInput): Anthropic.ContentBlockParam | undefined {
  if (input.resumeFile) {
    return {
      type: "document",
      source: {
        type: "base64",
        // Base64PDFSource's media_type is typed as the single literal
        // "application/pdf" — resumeFile.mediaType is a plain string per
        // this module's documented input shape (PDF-only for v1, per the
        // epic's design-discussion.md §7 "Not verifying" scope cut), so
        // the cast reflects that documented constraint rather than
        // widening the type.
        media_type: input.resumeFile.mediaType as "application/pdf",
        data: input.resumeFile.data.toString("base64"),
      },
    };
  }
  if (input.resumeText) {
    return { type: "text", text: `Resume (plain text):\n${input.resumeText}` };
  }
  return undefined;
}

const EXTRACT_TOOL_SCHEMA = {
  name: EXTRACT_TOOL_NAME,
  description:
    "Report the person's professional roles and skills extracted from the provided resume and/or link content. " +
    "Call this exactly once with the complete extraction result.",
  input_schema: {
    type: "object" as const,
    properties: {
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Professional roles/titles the person has held or is qualified for (e.g. 'Fractional CTO', 'Senior Backend Engineer').",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "Concrete skills, technologies, or areas of expertise (e.g. 'TypeScript', 'React', 'Team Leadership').",
      },
    },
    required: ["roles", "skills"],
    additionalProperties: false,
  },
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Extracts `{ roles, skills }` from a resume (PDF or plain text) and/or
 * public links, via one Claude Messages API call using tool-use for
 * structured output (never free-text parsing). Per-link fetch/parse
 * failures — including known login-walls — are collected into `warnings`
 * and do NOT fail the overall call; only a fully unusable input (no resume
 * and no usable link content) or an Anthropic API error propagates as a
 * thrown error.
 *
 * `apiKey` is used to construct the Anthropic client HERE, inside this
 * function call, and nowhere else — see this file's header comment.
 */
export async function extractProfile(input: ExtractProfileInput, apiKey: string): Promise<ExtractProfileResult> {
  const warnings: string[] = [];
  const linkContents: { url: string; text: string }[] = [];

  for (const url of input.links ?? []) {
    const result = await fetchAndExtractLink(url);
    if ("warning" in result) {
      warnings.push(result.warning);
    } else {
      linkContents.push({ url, text: result.text });
    }
  }

  const contentBlocks: Anthropic.ContentBlockParam[] = [];
  const resumeBlock = buildResumeContentBlock(input);
  if (resumeBlock) contentBlocks.push(resumeBlock);

  for (const { url, text } of linkContents) {
    contentBlocks.push({ type: "text", text: `Content fetched from ${url}:\n${text}` });
  }

  if (contentBlocks.length === 0) {
    throw new Error(
      "gigradar profile ingestion: no usable input — no resume was provided and no link produced usable content.",
    );
  }

  contentBlocks.push({
    type: "text",
    text: "Extract this person's professional roles and skills from the content above by calling the extract_profile tool.",
  });

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    tools: [EXTRACT_TOOL_SCHEMA],
    tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
    messages: [{ role: "user", content: contentBlocks }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === EXTRACT_TOOL_NAME,
  );
  if (!toolUse) {
    throw new Error(
      "gigradar profile ingestion: the Anthropic API response did not include the expected structured extraction result.",
    );
  }

  const parsed = toolUse.input as { roles?: unknown; skills?: unknown };
  const roles = isStringArray(parsed.roles) ? parsed.roles : [];
  const skills = isStringArray(parsed.skills) ? parsed.skills : [];

  return { roles, skills, warnings };
}
