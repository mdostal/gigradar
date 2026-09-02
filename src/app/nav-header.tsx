"use client";

// Shared nav header (`overview-nav-status` story): the app had zero
// navigation between `/` (dashboard) and `/config` before this — mounted
// from src/app/layout.tsx, above `{children}`, so it appears on every page.
//
// `/drafts` (`draft-review-ui` story, `assisted-apply-drafting` epic) added
// between Dashboard and Config, matching the natural workflow order: find
// gigs -> review/approve drafted applications -> configure.
//
// `"use client"` + usePathname() (dashboard-styling-pass): active-link
// highlighting needs to know the current route, which a Server Component
// can't read directly. This is the only reason this file is a Client
// Component — it renders no interactive state of its own otherwise.
//
// `/setup` (product-review-followups epic, setup-wizard story) sits right
// before `/config` -- it's the guided subset of the same settings, so it
// belongs next to the full editor, not off on its own.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { IssuesBadgeInfo } from "./issues-badge";

/** Exported (not just inlined in JSX) so it's directly assertable in tests without rendering. */
export const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/today", label: "Today" },
  { href: "/metrics", label: "Metrics" },
  { href: "/drafts", label: "Drafts" },
  { href: "/profile-assist", label: "Profile assist" },
  { href: "/chat", label: "Chat" },
  { href: "/issues", label: "Issues" },
  { href: "/setup", label: "Setup" },
  { href: "/config", label: "Config" },
] as const;

const BADGE_COLOR_CLASS: Record<IssuesBadgeInfo["color"], string> = {
  red: "bg-red-600 text-white",
  amber: "bg-amber-500 text-white",
};

/**
 * `issuesBadge` is computed server-side (layout.tsx reads `listIssues()`
 * directly — a Server Component, unlike this file) and passed down as a
 * plain prop; this component only ever renders it, never fetches on its
 * own. `null` (zero open issues) renders no badge at all — see
 * issues-badge.ts's own doc comment for why that's the correct empty state,
 * not a "0" badge.
 */
export function NavHeader({
  issuesBadge = null,
  iconSrc,
  groups = [],
}: {
  issuesBadge?: IssuesBadgeInfo | null;
  /** Public path of the current `Config.appIcon` pick (`icon-picker` story) — layout.tsx resolves this server-side via resolveAppIcon(), so it's always a valid path, never undefined in practice. Optional only so tests can render NavHeader standalone without wiring it. */
  iconSrc?: string;
  /**
   * multi-group-architecture epic, Slice 3. Every configured group's
   * `{id, label}` — layout.tsx resolves this server-side via
   * readRawConfig() (same non-resolving, ENOENT-tolerant reader every
   * other status-strip-adjacent read in this app uses). Rendered as a
   * row of group-switcher pills UNDER the main nav, but ONLY once 2+
   * groups exist — a not-yet-multi-group install (the common case) sees
   * zero extra UI, byte-identical to before this prop existed.
   */
  groups?: { id: string; label: string }[];
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 border-b border-brand-border bg-brand-bg/95 backdrop-blur supports-[backdrop-filter]:bg-brand-bg/90">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-bold tracking-tight text-brand-text">
          {iconSrc && (
            <img
              src={iconSrc}
              alt=""
              width={22}
              height={22}
              className="rounded-md shadow-[0_0_10px_1px_rgba(52,211,153,0.35)]"
            />
          )}
          gigradar
        </Link>
        <div className="flex items-center gap-1">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-brand-accent/15 text-brand-accent ring-1 ring-inset ring-brand-accent/30"
                    : "text-brand-text-dim hover:bg-brand-bg-elevated hover:text-brand-text",
                ].join(" ")}
              >
                {link.label}
                {link.href === "/issues" && issuesBadge && (
                  <span
                    className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold ${BADGE_COLOR_CLASS[issuesBadge.color]}`}
                  >
                    {issuesBadge.count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
      {groups.length > 1 && (
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1.5 px-6 pb-2.5 text-xs">
          <span className="text-brand-text-dim">Search:</span>
          <Link
            href="/"
            aria-current={pathname === "/" ? "page" : undefined}
            className={[
              "rounded-full px-2.5 py-1 font-medium transition-colors",
              pathname === "/"
                ? "bg-brand-accent/15 text-brand-accent ring-1 ring-inset ring-brand-accent/30"
                : "text-brand-text-dim hover:bg-brand-bg-elevated hover:text-brand-text",
            ].join(" ")}
          >
            All groups
          </Link>
          {groups.map((g) => {
            const href = `/${g.id}`;
            const active = pathname === href;
            return (
              <Link
                key={g.id}
                href={href}
                aria-current={active ? "page" : undefined}
                className={[
                  "rounded-full px-2.5 py-1 font-medium transition-colors",
                  active
                    ? "bg-brand-accent/15 text-brand-accent ring-1 ring-inset ring-brand-accent/30"
                    : "text-brand-text-dim hover:bg-brand-bg-elevated hover:text-brand-text",
                ].join(" ")}
              >
                {g.label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
