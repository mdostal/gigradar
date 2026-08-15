import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { resolveAppIcon } from "@/lib/app-icons";
import { readRawConfig } from "@/lib/config/save";
import { listIssues } from "@/lib/notify/issues";
import { issuesBadgeInfo } from "./issues-badge";
import { NavHeader } from "./nav-header";

/**
 * Dynamic (not a static `export const metadata`) so the favicon reflects
 * the user's `Config.appIcon` pick (`icon-picker` story) on every request —
 * reads via `readRawConfig()` (config-write-path's save.ts), the same
 * non-resolving, ENOENT-tolerant reader status-strip.ts/config/page.tsx
 * already use. `appIcon` is cosmetic, never a secret, so raw (unresolved)
 * is the correct read here regardless.
 */
export async function generateMetadata(): Promise<Metadata> {
  const raw = readRawConfig();
  const icon = resolveAppIcon(typeof raw.appIcon === "string" ? raw.appIcon : undefined);
  return {
    title: "gigradar",
    description: "Find and interact with fractional/contract engagements.",
    icons: { icon: icon.path },
  };
}

/**
 * Reads open issues DIRECTLY (a Server Component, unlike NavHeader itself)
 * so the nav badge is real on every navigation, no client-side fetch or
 * polling — mirrors how `/config`'s page.tsx and `/`'s dashboard page
 * already read the store synchronously on render. `resolveIssueAction`
 * (`/issues`) calls `revalidatePath("/")` after a real resolve, so this
 * re-reads and the badge updates without a manual reload.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const openIssues = listIssues({ open: true });
  const raw = readRawConfig();
  const icon = resolveAppIcon(typeof raw.appIcon === "string" ? raw.appIcon : undefined);
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <NavHeader issuesBadge={issuesBadgeInfo(openIssues)} iconSrc={icon.path} />
        {children}
      </body>
    </html>
  );
}
