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
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Exported (not just inlined in JSX) so it's directly assertable in tests without rendering. */
export const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/drafts", label: "Drafts" },
  { href: "/config", label: "Config" },
] as const;

export function NavHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <span className="text-sm font-bold tracking-tight text-slate-900">gigradar</span>
        <div className="flex items-center gap-1">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                ].join(" ")}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
