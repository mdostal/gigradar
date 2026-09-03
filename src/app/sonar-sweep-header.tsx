"use client";

// dashboard-drafts-data-integrity epic, sonar-sweep-header-widget story.
// Recovers the animated sonar-scope header from the owner's own approved
// Signal Deck concept (Artifact 730c378b-c24c-4ab0-840e-a56185854145) that
// silently fell out of the gigradar-command-center epic's
// signal-deck-main-dashboard story — see this epic's own
// docs/design-discussion.md §1 for the exact markup/timing this ports.
// Replaces the plain-text status pills that used to render this same data
// (computeStatusStrip()'s sourcesLabel/profileLabel/lastScanLabel — reused
// UNCHANGED, no new data source).
//
// "use client": the sweep icon animates continuously and "Last sweep"
// ticks live off a real timestamp (matching metrics/page.tsx's own
// established now-computed-server-side-once pattern to avoid a
// hydration-mismatch — React error #418, a real bug caught live during
// that story's own verification).
import { useEffect, useState } from "react";
import type { StatusStripView } from "@/lib/status/status-strip";
import { formatRelativeTime } from "@/lib/status/status-strip";
import type { ActionResult } from "@/lib/actions/result";
import type { SweepResult } from "./actions";

const TICK_INTERVAL_MS = 15_000;

export function SonarSweepHeader({
  status,
  lastScanIso,
  now,
  sweepAction,
}: {
  status: StatusStripView;
  /** ISO datetime of the most recent scan, or null if none has ever run — same value computeLastScanIso() already produces, threaded through separately from status.lastScanLabel so this component can tick it live rather than just render a frozen string. */
  lastScanIso: string | null;
  /** Computed server-side once (see this file's own header comment) — never Date.now() during render. */
  now: number;
  /** Wraps runRadar(loadConfig()) — see actions.ts's sweepNowAction(). */
  sweepAction: () => Promise<ActionResult<SweepResult>>;
}) {
  const [clientNow, setClientNow] = useState(now);
  const [scanIso, setScanIso] = useState(lastScanIso);
  const [sweeping, setSweeping] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setClientNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  async function handleSweepNow() {
    setError(null);
    setSweeping(true);
    try {
      const result = await sweepAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { newCount, errors } = result.data;
      setScanIso(new Date(clientNow).toISOString());
      setToast(
        errors.length > 0
          ? `Sweep complete — ${newCount} new signal${newCount === 1 ? "" : "s"}, ${errors.length} source${errors.length === 1 ? "" : "s"} had errors`
          : newCount > 0
            ? `Sweep complete — ${newCount} new signal${newCount === 1 ? "" : "s"}`
            : "Sweep complete — no new signals since last pass",
      );
    } finally {
      setSweeping(false);
    }
  }

  const lastScanLabel = scanIso === null ? "never run" : formatRelativeTime(scanIso, clientNow);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-theme-surface-border pb-4">
      <div className="flex items-center gap-3.5">
        <ScopeIcon sweeping={sweeping} />
        <div>
          <h1 className="font-theme-heading text-lg font-bold uppercase tracking-wide text-theme-text">Gigradar</h1>
          <p className="font-theme-mono text-xs text-theme-text-faint">Fractional &amp; contract engagement scan</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <Instrument label="Sources" value={status.sourcesLabel} warn={status.sourcesLabel.includes("need attention")} />
        <Instrument label="Profile" value={status.profileLabel.replace(/^Profile:\s*/, "")} warn={status.profileLabel.includes("needs setup")} />
        <Instrument label="Last sweep" value={lastScanLabel} />
        <button
          type="button"
          onClick={handleSweepNow}
          disabled={sweeping}
          className="flex items-center gap-1.5 rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
        >
          {sweeping ? "Sweeping…" : "Sweep now"}
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-theme-accent-dim bg-theme-surface-raised px-3.5 py-2.5 text-sm text-theme-text shadow-lg">
          {toast}
        </div>
      )}
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Instrument({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="text-right">
      <div className="font-theme-mono text-[10.5px] uppercase tracking-wide text-theme-text-faint">{label}</div>
      <div className={`font-theme-mono text-[13px] tabular-nums ${warn ? "text-amber-600" : "text-theme-text"}`}>{value}</div>
    </div>
  );
}

/**
 * Ports design-discussion.md §1's exact geometry (52x52, concentric
 * circles + crosshair, 3 staggered pulsing blips, a rotating gradient
 * sweep wedge) — using theme CSS custom properties for every color
 * instead of the concept's hardcoded dark-console palette, so this reads
 * correctly on every one of the app's 5 themes, not just Signal Deck.
 * `sweeping` briefly speeds the rotation (0.6s vs the idle 4s), mirroring
 * the concept's own scanBtn click handler (animationDuration override,
 * reverted after ~1.2s in the concept — reverted here once `sweeping`
 * goes false instead, which is the real-completion signal a mock toast
 * doesn't have).
 */
function ScopeIcon({ sweeping }: { sweeping: boolean }) {
  return (
    <div className="relative h-[46px] w-[46px] flex-none" aria-hidden="true">
      <style>{`
        @keyframes sonar-spin { to { transform: rotate(360deg); } }
        @keyframes sonar-blip { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }
        .sonar-sweep { transform-origin: 26px 26px; animation: sonar-spin 4s linear infinite; }
        .sonar-sweep.fast { animation-duration: 0.6s; }
        .sonar-blip { animation: sonar-blip 2.6s ease-in-out infinite; }
        .sonar-blip.b2 { animation-delay: .9s; }
        .sonar-blip.b3 { animation-delay: 1.7s; }
        @media (prefers-reduced-motion: reduce) {
          .sonar-sweep { animation: none; }
          .sonar-blip { animation: none; opacity: .7; }
        }
      `}</style>
      <svg viewBox="0 0 52 52" width="100%" height="100%">
        <circle cx="26" cy="26" r="24" fill="none" stroke="var(--color-theme-surface-border)" strokeWidth="1" />
        <circle cx="26" cy="26" r="16" fill="none" stroke="var(--color-theme-surface-border)" strokeWidth="1" />
        <circle cx="26" cy="26" r="8" fill="none" stroke="var(--color-theme-surface-border)" strokeWidth="1" />
        <line x1="26" y1="2" x2="26" y2="50" stroke="var(--color-theme-surface-border)" strokeWidth="1" />
        <line x1="2" y1="26" x2="50" y2="26" stroke="var(--color-theme-surface-border)" strokeWidth="1" />
        <circle className="sonar-blip b1" cx="34" cy="16" r="1.8" fill="var(--color-theme-tier-green)" />
        <circle className="sonar-blip b2" cx="17" cy="33" r="1.8" fill="var(--color-theme-tier-green)" />
        <circle className="sonar-blip b3" cx="35" cy="34" r="1.6" fill="var(--color-theme-tier-yellow)" />
        <g className={`sonar-sweep${sweeping ? " fast" : ""}`}>
          <path d="M26 26 L26 3 A23 23 0 0 1 45 15 Z" fill="url(#sonarSweepGrad)" opacity="0.9" />
        </g>
        <defs>
          <linearGradient id="sonarSweepGrad" x1="26" y1="26" x2="45" y2="15" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--color-theme-accent)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--color-theme-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
