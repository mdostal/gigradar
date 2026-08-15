"use client";

// profile-assist epic, profile-assist-persistent-session-manual-mode
// story. Manual tab only for this story — Guided/Full-auto are visually
// present but disabled ("coming soon"), per this story's own scope (ship
// one working tab, not three empty ones). See design-discussion.md §5 for
// the full three-tab UX shape this will grow into.
import { useState } from "react";
import { endAssistSessionAction, startAssistSessionAction, suggestProfileFieldsAction } from "./actions";
import type { FieldSuggestion } from "@/lib/apply/profile-suggest";

type Tab = "manual" | "guided" | "full-auto";

const TABS: { id: Tab; label: string; enabled: boolean }[] = [
  { id: "manual", label: "Manual", enabled: true },
  { id: "guided", label: "Guided", enabled: false },
  { id: "full-auto", label: "Full auto", enabled: false },
];

type SessionState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "active"; sessionId: string }
  | { status: "ending" }
  | { status: "error"; message: string };

type SuggestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; suggestions: FieldSuggestion[] }
  | { status: "error"; message: string };

function tabButtonClass(active: boolean, enabled: boolean): string {
  return [
    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
    !enabled
      ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
      : active
        ? "border-brand-accent bg-brand-accent/10 text-brand-accent"
        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}

export function ProfileAssistClient({ sources }: { sources: { id: string; label: string }[] }) {
  const [tab, setTab] = useState<Tab>("manual");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [session, setSession] = useState<SessionState>({ status: "idle" });
  const [suggest, setSuggest] = useState<SuggestState>({ status: "idle" });

  async function handleStart() {
    setSession({ status: "starting" });
    const result = await startAssistSessionAction(sourceId, "manual");
    if (!result.ok) {
      setSession({ status: "error", message: result.error });
      return;
    }
    setSession({ status: "active", sessionId: result.data.sessionId });
    setSuggest({ status: "idle" });
  }

  async function handleDone() {
    if (session.status !== "active") return;
    const sessionId = session.sessionId;
    setSession({ status: "ending" });
    const result = await endAssistSessionAction(sessionId);
    if (!result.ok) {
      setSession({ status: "error", message: result.error });
      return;
    }
    setSession({ status: "idle" });
    setSuggest({ status: "idle" });
  }

  async function handleRefreshSuggestions() {
    if (session.status !== "active") return;
    setSuggest({ status: "loading" });
    const result = await suggestProfileFieldsAction(session.sessionId);
    if (!result.ok) {
      setSuggest({ status: "error", message: result.error });
      return;
    }
    setSuggest({ status: "success", suggestions: result.data });
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex gap-2" role="tablist" aria-label="Autonomy mode">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={!t.enabled}
            onClick={() => t.enabled && setTab(t.id)}
            className={tabButtonClass(tab === t.id, t.enabled)}
            title={t.enabled ? undefined : "Coming soon"}
          >
            {t.label}
            {!t.enabled && <span className="ml-1 text-xs">(soon)</span>}
          </button>
        ))}
      </div>

      {tab === "manual" && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {session.status === "idle" || session.status === "starting" || session.status === "error" ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                Source
                <select
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  disabled={session.status === "starting"}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                >
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleStart}
                disabled={session.status === "starting" || !sourceId}
                className="rounded-md border border-brand-accent bg-brand-accent px-4 py-1.5 text-sm font-medium text-brand-bg transition-colors hover:bg-brand-accent/90 disabled:opacity-50"
              >
                {session.status === "starting" ? "Opening browser…" : "Start"}
              </button>
              {session.status === "error" && (
                <p role="alert" className="w-full text-xs text-red-600">
                  {session.message}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-slate-600">
                  A real browser window is open on your desktop — sign in / navigate if needed, then use the
                  suggestions below or refresh them any time.
                </p>
                <button
                  type="button"
                  onClick={handleDone}
                  disabled={session.status === "ending"}
                  className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {session.status === "ending" ? "Closing…" : "Done"}
                </button>
              </div>

              <div>
                <button
                  type="button"
                  onClick={handleRefreshSuggestions}
                  disabled={suggest.status === "loading" || session.status !== "active"}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {suggest.status === "loading" ? "Thinking…" : "Refresh suggestions"}
                </button>

                {suggest.status === "error" && (
                  <p role="alert" className="mt-2 text-xs text-red-600">
                    {suggest.message}
                  </p>
                )}

                {suggest.status === "success" && (
                  <div className="mt-3 flex flex-col gap-2">
                    {suggest.suggestions.length === 0 ? (
                      <p className="text-sm text-slate-400">No fields detected to suggest copy for.</p>
                    ) : (
                      suggest.suggestions.map((s, i) => (
                        <div key={i} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs font-semibold text-slate-500">{s.fieldLabel}</p>
                          <p className="mt-1 text-sm text-slate-800">{s.suggestedValue}</p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
