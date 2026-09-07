"use client";

import { useState, type ReactNode } from "react";

/**
 * match-warning-tooltip-clarity-and-reliability story (crawler-fidelity-
 * and-app-usability epic). Replaces a native `title=` attribute tooltip --
 * owner's own complaint: "the questionmark hover isn't telling me shit" --
 * which is a genuinely weak mechanism inside a packaged Tauri webview
 * (delayed appearance, no touch support, inconsistent enough that this
 * codebase already has form fixing platform-specific webview gotchas this
 * session, e.g. the Webview::set_cookie() finding from the
 * true-embedded-browser epic).
 *
 * Real, DOM-rendered popover: opens on hover (onMouseEnter/onMouseLeave, so
 * it's real component state -- inspectable/testable like any other piece
 * of render output, not a CSS-only `:hover` pseudo-class a curl/DOM check
 * can't see) AND toggles on click/tap, the fallback this story's
 * acceptance criteria requires for a webview that doesn't hover-track
 * reliably. `label` is also set as the trigger's `aria-label`, so the full
 * message is present in the server-rendered HTML from the very first
 * paint -- verifiable via a plain curl/DOM check of a real build, not just
 * "trust the dev server," per this session's standing no-real-browser-
 * window verification rule.
 *
 * Same relative-container + absolutely-positioned-panel + theme-token
 * styling this app already established for its one other custom popover
 * (sync-status-dropdown.tsx's "Sync statuses" dropdown) -- reused, not a
 * new one-off pattern.
 */
export function InfoTooltip({ trigger, label, className }: { trigger: ReactNode; label: string; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`relative inline-flex ${className ?? ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        className="cursor-help border-0 bg-transparent p-0 text-xs leading-none text-inherit"
      >
        {trigger}
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 z-20 mb-1 w-64 -translate-x-1/2 rounded-md border border-theme-surface-border bg-theme-surface p-2 text-left text-xs font-normal normal-case leading-snug text-theme-text shadow-lg"
        >
          {label}
        </span>
      )}
    </span>
  );
}
