import { describe, expect, it } from "vitest";
import { NAV_LINKS } from "../nav-header";

// nav-header.tsx itself renders a Server Component with no client-side
// logic — this repo has no React Testing Library dependency (see
// dashboard-filter.test.ts's convention: pull the assertable contract out
// into plain data). NAV_LINKS is that contract: exactly the two links
// (Dashboard -> /, Config -> /config) NavHeader() maps over to render
// <Link>s, so asserting on it here is equivalent to asserting the rendered
// links/hrefs without needing a DOM.
describe("NAV_LINKS", () => {
  it("has working links to / and /config, in that order", () => {
    expect(NAV_LINKS).toEqual([
      { href: "/", label: "Dashboard" },
      { href: "/config", label: "Config" },
    ]);
  });

  it("every link has a non-empty href and label", () => {
    for (const link of NAV_LINKS) {
      expect(link.href.length).toBeGreaterThan(0);
      expect(link.label.length).toBeGreaterThan(0);
    }
  });
});
