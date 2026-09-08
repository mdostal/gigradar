import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans, Oxanium, Public_Sans } from "next/font/google";
import "./globals.css";
import { resolveAppIcon } from "@/lib/app-icons";
import { readRawConfig } from "@/lib/config/save";
import { listIssues } from "@/lib/notify/issues";
import { resolveUiTheme } from "@/lib/ui-theme";
import { sweepNowAction } from "./actions";
import { loadSonarSweepStatus } from "./dashboard-data";
import { issuesBadgeInfo } from "./issues-badge";
import { NavHeader } from "./nav-header";
import { SonarSweepHeader } from "./sonar-sweep-header";
import { UpdateNotifier } from "./update-notifier";

/**
 * gigradar-command-center epic: Signal Deck's own display/body/mono
 * typefaces, loaded via next/font/google -- self-hosted and bundled at
 * BUILD time, never a runtime request to Google's CDN. This is the reason
 * to use next/font here rather than signal-deck.css's own CSS @import
 * (what the original verified concept used): a local-first, performance-
 * sensitive app (see the owner's own "this should be BLAZING fast running
 * from local" complaint) should never add an external network dependency
 * to page load, even a themeable one. Loaded unconditionally (every theme
 * bundles these font files, not just signal-deck) -- statically cached,
 * effectively free after the first load, and far simpler than a
 * per-theme-conditional font-loading path.
 */
const signalDeckHeadingFont = Oxanium({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-signal-deck-heading" });
const signalDeckBodyFont = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-signal-deck-body" });
const signalDeckMonoFont = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-signal-deck-mono" });

/**
 * gigradar-command-center epic, signal-desk-theme story. Signal Desk's own
 * real typeface (Public Sans for both heading and body -- the verified
 * concept never used a separate display face; see signal-desk.css's own
 * --font-heading/--font-body both pointing at this one variable) plus its
 * IBM Plex Mono numerals, same self-hosted-not-CDN reasoning as Signal
 * Deck's fonts above.
 */
const signalDeskBodyFont = Public_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-signal-desk-body" });
const signalDeskMonoFont = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-signal-desk-mono" });

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
/**
 * multi-group-architecture epic, Slice 3. Every configured group's
 * `{id, label}`, tolerant-extracted from the RAW (unresolved) config the
 * same way dashboard-data.ts's extractEngagementProfileSummaries() reads
 * `groups[]` — a missing/malformed `groups` array (first-run, no config
 * yet) yields `[]`, so NavHeader's own "2+ groups" gate simply renders no
 * switcher rather than throwing.
 */
export function extractGroupSummaries(rawConfig: Record<string, unknown>): { id: string; label: string }[] {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return [];
  const result: { id: string; label: string }[] = [];
  for (const g of groups) {
    if (typeof g !== "object" || g === null) continue;
    const { id, label } = g as Record<string, unknown>;
    if (typeof id === "string" && typeof label === "string") result.push({ id, label });
  }
  return result;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const openIssues = listIssues({ open: true });
  const raw = readRawConfig();
  const theme = resolveUiTheme(raw.uiTheme);
  const groups = extractGroupSummaries(raw);
  // sonar-sweep-header-global-masthead story (header-layout-cleanup epic).
  // The owner's own confirmed direction: the branded sonar-sweep masthead
  // is the literal top of every page, with NavHeader's tabs + Groups row
  // rendering below it -- a page's own content (where SonarSweepHeader used
  // to render, e.g. src/app/page.tsx) can never appear ABOVE this shared
  // layout's UI, so it has to live here instead. `loadSonarSweepStatus()`
  // (dashboard-data.ts) is a lightweight, aggregate-only read (a real SQL
  // MAX(last_seen) plus the same cheap config/source-count reads
  // computeStatusStrip() already did) -- NEVER loadDashboardData()'s
  // listGigs()-based path, which would otherwise run a full gig-table scan
  // (2000+ real rows for the owner) on every single route, not just once on
  // the Dashboard. `now` is computed once, server-side, for the same
  // hydration-mismatch reason every other SonarSweepHeader call site already
  // documents (see sonar-sweep-header.tsx's own header comment).
  const { status, lastScanIso } = loadSonarSweepStatus();
  const now = Date.now();
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${signalDeckHeadingFont.variable} ${signalDeckBodyFont.variable} ${signalDeckMonoFont.variable} ${signalDeskBodyFont.variable} ${signalDeskMonoFont.variable}`}
    >
      <body className="theme-body min-h-screen antialiased">
        <div className="mx-auto max-w-[88rem] px-6 pt-6">
          <SonarSweepHeader status={status} lastScanIso={lastScanIso} now={now} sweepAction={sweepNowAction} />
        </div>
        <NavHeader issuesBadge={issuesBadgeInfo(openIssues)} groups={groups} />
        {children}
        <UpdateNotifier />
      </body>
    </html>
  );
}
