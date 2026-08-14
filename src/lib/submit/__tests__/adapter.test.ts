import { describe, expect, it } from "vitest";
import type { ApplyProfileConfig, DraftContent, Gig } from "../../types.js";
import { getSubmitAdapter, listSubmitAdapters, registerSubmitAdapter } from "../adapter.js";

const GIG: Gig = { sourceId: "test-source", externalId: "1", title: "x", url: "https://example.test/1" };
const DRAFT: DraftContent = { coverText: "hi", answers: {} };
const APPLY_PROFILE: ApplyProfileConfig = { email: "me@example.test" };

describe("SubmitAdapter registry", () => {
  it("registers and looks up an adapter by id", () => {
    registerSubmitAdapter({
      id: "test-adapter-lookup",
      submit: async () => ({ ok: true, confirmation: "done" }),
    });

    const found = getSubmitAdapter("test-adapter-lookup");
    expect(found?.id).toBe("test-adapter-lookup");
  });

  it("returns undefined for an unregistered id", () => {
    expect(getSubmitAdapter("never-registered")).toBeUndefined();
  });

  it("throws on a duplicate id registration", () => {
    registerSubmitAdapter({ id: "test-adapter-dup", submit: async () => ({ ok: true, confirmation: "done" }) });
    expect(() => registerSubmitAdapter({ id: "test-adapter-dup", submit: async () => ({ ok: true, confirmation: "done" }) })).toThrow(
      /duplicate submit adapter id/,
    );
  });

  it("listSubmitAdapters includes every registered adapter", () => {
    registerSubmitAdapter({ id: "test-adapter-list", submit: async () => ({ ok: true, confirmation: "done" }) });
    expect(listSubmitAdapters().some((a) => a.id === "test-adapter-list")).toBe(true);
  });

  it("a registered adapter's submit() returns the SubmitResult shape and receives the real gig/draft/applyProfile", async () => {
    let received: unknown;
    registerSubmitAdapter({
      id: "test-adapter-args",
      submit: async (gig, draft, applyProfile) => {
        received = { gig, draft, applyProfile };
        return { ok: true, confirmation: "confirmed-123" };
      },
    });

    const result = await getSubmitAdapter("test-adapter-args")?.submit(GIG, DRAFT, APPLY_PROFILE);
    expect(result).toEqual({ ok: true, confirmation: "confirmed-123" });
    expect(received).toEqual({ gig: GIG, draft: DRAFT, applyProfile: APPLY_PROFILE });
  });
});
