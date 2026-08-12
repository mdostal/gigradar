// Shared nav header (`overview-nav-status` story): the app had zero
// navigation between `/` (dashboard) and `/config` before this — mounted
// from src/app/layout.tsx, above `{children}`, so it appears on every page.
// Minimal styling consistent with the existing Tailwind classes in
// page.tsx/config-client.tsx — deliberately not a redesign.
import Link from "next/link";

/** Exported (not just inlined in JSX) so it's directly assertable in tests without rendering. */
export const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/config", label: "Config" },
] as const;

export function NavHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-sm font-medium text-slate-600 hover:text-slate-900 hover:underline"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
