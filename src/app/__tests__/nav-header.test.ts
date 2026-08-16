import { describe, expect, it } from "vitest";
import { NAV_LINKS } from "../nav-header";

// nav-header.tsx itself is a Client Component (usePathname() for
// active-link highlighting, dashboard-styling-pass) — this repo has no
// React Testing Library dependency (see
// dashboard-filter.test.ts's convention: pull the assertable contract out
// into plain data). NAV_LINKS is that contract: the links NavHeader()
// maps over to render <Link>s, so asserting on it here is equivalent to
// asserting the rendered links/hrefs without needing a DOM.
// `/drafts` was added by the `draft-review-ui` story
// (`assisted-apply-drafting` epic); `/issues` by the `notifications-epic`;
// `/profile-assist` by the `profile-assist` epic; `/chat` by the
// `agent-chat` epic.
describe("NAV_LINKS", () => {
  it("has working links to /, /drafts, /profile-assist, /chat, /issues, and /config, in that order", () => {
    expect(NAV_LINKS).toEqual([
      { href: "/", label: "Dashboard" },
      { href: "/drafts", label: "Drafts" },
      { href: "/profile-assist", label: "Profile assist" },
      { href: "/chat", label: "Chat" },
      { href: "/issues", label: "Issues" },
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
