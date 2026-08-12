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
import Anthropic from "@anthropic-ai/sdk";

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

/**
 * Fetches one link and returns either its extracted visible text or a
 * warning describing why it couldn't be used. NEVER throws — a failed
 * link becomes a warnings entry, per this story's partial-failure
 * contract (the resume and every other link still contribute to the
 * result). A known login-wall gets the specific "may require login"
 * wording the acceptance criteria require; every other failure gets a
 * generic, still-specific message (never a resolved secret or personal
 * data — link failures never carry either).
 */
async function fetchAndExtractLink(url: string): Promise<LinkFetchResult> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    return { warning: `Couldn't fetch "${url}": ${e instanceof Error ? e.message : String(e)}` };
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

  const html = await response.text();
  return { text: htmlToText(html) };
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
