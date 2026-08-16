// Tests for src/lib/sources/verification-challenge.ts (verification-copilot
// epic, verification-challenge-detection story).
import { describe, expect, it } from "vitest";
import { isVerificationChallengeContent, VerificationChallengeError } from "../verification-challenge.js";

describe("isVerificationChallengeContent: known phrases", () => {
  it("matches \"performing security verification\" case-insensitively", () => {
    expect(isVerificationChallengeContent("Performing Security Verification")).toBe(true);
    expect(isVerificationChallengeContent("performing security verification...")).toBe(true);
  });

  it("matches \"checking your browser\"", () => {
    expect(isVerificationChallengeContent("Checking your browser before accessing example.com.")).toBe(true);
  });

  it("matches \"verify you are human\"", () => {
    expect(isVerificationChallengeContent("Please verify you are human to continue.")).toBe(true);
  });

  it("matches \"just a moment\" only when \"cloudflare\" also appears -- the real fixture's exact title", () => {
    expect(isVerificationChallengeContent("Just a moment... | Cloudflare")).toBe(true);
  });

  it('does NOT match "just a moment" alone -- too generic without the cloudflare co-occurrence', () => {
    expect(isVerificationChallengeContent("Just a moment, I'll be right with you!")).toBe(false);
  });
});

describe("isVerificationChallengeContent: no false positives on ordinary content", () => {
  it("returns false for a real, ordinary jobs-listing page's title/body", () => {
    expect(isVerificationChallengeContent("Fractional Jobs | GoFractional\nBrowse open fractional roles from real companies.")).toBe(false);
  });

  it("returns false for a real sign-in page", () => {
    expect(isVerificationChallengeContent("Sign In\nContinue with Google\nContinue with Github")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(isVerificationChallengeContent("")).toBe(false);
  });
});

describe("VerificationChallengeError", () => {
  it("carries sourceId and url as named fields, not just baked into the message", () => {
    const err = new VerificationChallengeError("gofractional", "https://www.gofractional.com/job/123");

    expect(err.sourceId).toBe("gofractional");
    expect(err.url).toBe("https://www.gofractional.com/job/123");
    expect(err.name).toBe("VerificationChallengeError");
    expect(err).toBeInstanceOf(Error);
  });

  it("the message names both the source and the url", () => {
    const err = new VerificationChallengeError("gofractional", "https://www.gofractional.com/job/123");

    expect(err.message).toContain("gofractional");
    expect(err.message).toContain("https://www.gofractional.com/job/123");
  });
});
