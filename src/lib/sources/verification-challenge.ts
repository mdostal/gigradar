// verification-copilot epic, verification-challenge-detection story. A
// shared, reusable detector for bot-detection/"verification" interstitials
// (Cloudflare's "Performing security verification" and similar) — see
// .pHive/epics/verification-copilot/docs/design-discussion.md §3. Wired
// into browser-session.ts's withBrowserSession() (the ONE place every
// browser-session-auth adapter already goes through) rather than
// duplicated per-adapter — gofractional.ts's own file-level comment
// documents this exact failure mode, but as avoidance (never navigate
// there), not detection; this is the first real detector.
//
// DELIBERATELY CONSERVATIVE. Matches specific, known phrases only — never
// a broad "this looks suspicious" heuristic. A false positive here would
// misclassify an ordinary page as a verification block, degrading the
// whole signal this epic exists to make trustworthy. A false negative
// (a real block not yet in this list) just falls through to whatever
// generic failure the caller's own isAuthenticated check produces — no
// worse than today's behavior.

const KNOWN_PHRASES = ["performing security verification", "checking your browser", "verify you are human"];

/**
 * True if `text` (a page's title + visible body text, or any similar
 * signal) matches a known verification-challenge phrase. Case-insensitive.
 * "just a moment" alone is too generic (plausibly real copy on an
 * unrelated page) — only counted when "cloudflare" also appears somewhere
 * in the same text, matching the real interstitial's actual content
 * (confirmed via this project's own test fixture: title exactly
 * "Just a moment... | Cloudflare").
 */
export function isVerificationChallengeContent(text: string): boolean {
  const lower = text.toLowerCase();
  if (KNOWN_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return lower.includes("just a moment") && lower.includes("cloudflare");
}

/**
 * Thrown by withBrowserSession() when `isVerificationChallengeContent()`
 * matches — distinguishable from a generic thrown `Error` via
 * `instanceof`, so callers (runner.ts's per-source error handling) never
 * need to parse message strings to route it to a distinct issue. Carries
 * `sourceId`/`url` as named fields for that same reason.
 */
export class VerificationChallengeError extends Error {
  readonly sourceId: string;
  readonly url: string;

  constructor(sourceId: string, url: string) {
    super(
      `gigradar: source "${sourceId}" hit a verification challenge at "${url}" — a human needs to clear it before this source can be scanned again.`,
    );
    this.name = "VerificationChallengeError";
    this.sourceId = sourceId;
    this.url = url;
  }
}
