"use client";

// config-dashboard-and-section-pages story: the collapsible sidebar,
// ported from the owner's own approved Concept A artifact
// (f9e1f4a9-c75f-469c-90c3-3e6b78235854, "gigradar Settings") — 6 nav
// items (Profile/Sources/Groups & Needs/Schedule/Automation/Appearance),
// each with a real status indicator, plus a Dashboard link back to the
// card-grid home. Concept A itself had no collapse affordance (the owner's
// own synthesis explicitly asked for one) — added here as a real,
// persisted-per-viewer preference, same localStorage pattern
// dashboard-overview-prefs.ts already established (own key, read-on-mount
// + write-on-change, never throws on a private-browsing/storage-denied
// context).
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CONFIG_SECTIONS } from "./config-sections";
import type { ConfigPageData } from "./config-data";

const SIDEBAR_COLLAPSED_KEY = "gigradar:config-sidebar-collapsed:v1";

const STATUS_DOT_CLASS: Record<"ok" | "warn" | "danger" | "neutral", string> = {
  ok: "bg-theme-tier-green",
  warn: "bg-theme-tier-yellow",
  danger: "bg-theme-tier-red",
  neutral: "bg-theme-surface-border",
};

export function ConfigSidebar({ data }: { data: ConfigPageData }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      // localStorage unavailable (private browsing, etc.) -- stay expanded.
    }
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Storage full/unavailable -- not persisting a preference is never fatal.
      }
      return next;
    });
  }

  return (
    <aside
      className={`sticky top-0 flex h-screen flex-none flex-col border-r border-theme-surface-border bg-theme-surface transition-[width] ${collapsed ? "w-14" : "w-56"}`}
    >
      <div className="flex items-center justify-between border-b border-theme-surface-border px-3 py-3">
        {!collapsed && <span className="font-theme-heading text-xs font-semibold uppercase tracking-wide text-theme-text-dim">Settings</span>}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1 text-theme-text-dim hover:bg-theme-surface-raised hover:text-theme-text"
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <Link
          href="/config"
          aria-current={pathname === "/config" ? "page" : undefined}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
            pathname === "/config"
              ? "bg-theme-accent/15 text-theme-accent"
              : "text-theme-text-dim hover:bg-theme-surface-raised hover:text-theme-text"
          }`}
        >
          <span aria-hidden="true">⌂</span>
          {!collapsed && "Dashboard"}
        </Link>

        <div className="my-2 border-t border-theme-surface-border" />

        {CONFIG_SECTIONS.map((section) => {
          const active = pathname === section.href;
          return (
            <Link
              key={section.id}
              href={section.href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? section.label : undefined}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-theme-accent/15 text-theme-accent" : "text-theme-text-dim hover:bg-theme-surface-raised hover:text-theme-text"
              }`}
            >
              <span className={`h-1.5 w-1.5 flex-none rounded-full ${STATUS_DOT_CLASS[section.status(data)]}`} aria-hidden="true" />
              {!collapsed && <span className="truncate">{section.label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
