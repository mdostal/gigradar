import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { listIssues } from "@/lib/notify/issues";
import { issuesBadgeInfo } from "./issues-badge";
import { NavHeader } from "./nav-header";

export const metadata: Metadata = {
  title: "gigradar",
  description: "Find and interact with fractional/contract engagements.",
};

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
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <NavHeader issuesBadge={issuesBadgeInfo(openIssues)} />
        {children}
      </body>
    </html>
  );
}
