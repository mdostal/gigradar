"use client";

// profile-assist epic. Manual tab: profile-assist-persistent-session-
// manual-mode story. Guided tab: profile-assist-guided-mode story — the
// tool-use loop is entirely server-side (profile-assist-loop.ts); this
// component's job is just to keep calling advanceLoopTurnAction() while
// events don't need a human, and stop (surfacing the right control) the
// moment one does (a pending approval or an ask_human question). Full-auto
// tab is disabled — profile-assist-full-auto-mode story, not yet shipped.
import { useRef, useState } from "react";
import {
  advanceLoopTurnAction,
  answerHumanAction,
  endAssistSessionAction,
  resolveApprovalAction,
  startAssistSessionAction,
  suggestProfileFieldsAction,
} from "./actions";
import type { FieldSuggestion } from "@/lib/apply/profile-suggest";
import type { LoopEvent } from "@/lib/apply/profile-assist-loop";

type Tab = "manual" | "guided" | "full-auto";

const TABS: { id: Tab; label: string; enabled: boolean }[] = [
  { id: "manual", label: "Manual", enabled: true },
  { id: "guided", label: "Guided", enabled: true },
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

/** One rendered line in the Guided transcript — a thin display-only wrapper around LoopEvent, plus the "advancing" spinner state and the eventual human answer/approval outcome folded in after the fact. */
type TranscriptItem =
  | { kind: "advancing" }
  | { kind: "event"; event: LoopEvent; resolvedApproval?: "approved" | "rejected"; humanAnswer?: string }
  | { kind: "error"; message: string };

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

function TranscriptLine({ item }: { item: TranscriptItem }) {
  if (item.kind === "advancing") {
    return <p className="text-xs text-slate-400">Thinking…</p>;
  }
  if (item.kind === "error") {
    return (
      <p role="alert" className="text-xs text-red-600">
        {item.message}
      </p>
    );
  }

  const { event } = item;
  if (event.type === "read") {
    return <p className="text-xs text-slate-500">Looked at the page.</p>;
  }
  if (event.type === "click" || event.type === "fill") {
    const verb = event.type === "click" ? "Clicked" : `Filled "${event.value}" into`;
    const status =
      item.resolvedApproval === "rejected"
        ? " (rejected by you)"
        : event.pending
          ? " (awaiting your approval)"
          : "";
    return (
      <p className="text-sm text-slate-700">
        {verb} <code className="text-xs text-slate-500">{event.ref}</code> — {event.reason}
        <span className="text-slate-400">{status}</span>
      </p>
    );
  }
  if (event.type === "invalid_ref") {
    return (
      <p className="text-xs text-amber-700">
        Tried to {event.tool} a stale reference — asked it to look again.
      </p>
    );
  }
  if (event.type === "ask_human") {
    return (
      <p className="text-sm text-slate-800">
        <strong>Question:</strong> {event.question}
        {item.humanAnswer && (
          <>
            <br />
            <span className="text-slate-500">You answered: {item.humanAnswer}</span>
          </>
        )}
      </p>
    );
  }
  if (event.type === "done") {
    return <p className="text-sm font-medium text-green-700">Done — {event.summary}</p>;
  }
  return <p className="text-sm font-medium text-amber-700">Reached the turn limit for this session.</p>;
}

export function ProfileAssistClient({ sources }: { sources: { id: string; label: string }[] }) {
  const [tab, setTab] = useState<Tab>("manual");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [session, setSession] = useState<SessionState>({ status: "idle" });
  const [suggest, setSuggest] = useState<SuggestState>({ status: "idle" });
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [pendingEvent, setPendingEvent] = useState<Extract<LoopEvent, { type: "click" | "fill" }> | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [humanAnswer, setHumanAnswer] = useState("");
  const runningRef = useRef(false);

  async function handleStart() {
    setSession({ status: "starting" });
    setTranscript([]);
    setPendingEvent(null);
    setPendingQuestion(null);
    const mode = tab === "guided" ? "guided" : "manual";
    const result = await startAssistSessionAction(sourceId, mode);
    if (!result.ok) {
      setSession({ status: "error", message: result.error });
      return;
    }
    setSession({ status: "active", sessionId: result.data.sessionId });
    setSuggest({ status: "idle" });
    if (mode === "guided") {
      void runUntilBlocked(result.data.sessionId);
    }
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
    setTranscript([]);
    setPendingEvent(null);
    setPendingQuestion(null);
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

  /** Keeps calling advanceLoopTurnAction() until an event needs a human (a pending approval or an unanswered question) or the loop is over (done/turn_limit_reached). Each intermediate event is appended to the transcript as it arrives. */
  async function runUntilBlocked(sessionId: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        setTranscript((prev) => [...prev, { kind: "advancing" }]);
        const result = await advanceLoopTurnAction(sessionId);
        setTranscript((prev) => prev.slice(0, -1)); // drop the "advancing" placeholder

        if (!result.ok) {
          setTranscript((prev) => [...prev, { kind: "error", message: result.error }]);
          return;
        }

        const event = result.data;
        setTranscript((prev) => [...prev, { kind: "event", event }]);

        if (event.type === "click" || event.type === "fill") {
          if (event.pending) {
            setPendingEvent(event);
            setEditValue(event.value ?? "");
            return;
          }
          continue; // full-auto executed already — keep going (Guided reaches here only via read/invalid_ref)
        }
        if (event.type === "ask_human") {
          setPendingQuestion(event.question);
          return;
        }
        if (event.type === "done" || event.type === "turn_limit_reached") {
          return;
        }
        // "read" / "invalid_ref" — no human input needed, keep advancing.
      }
    } finally {
      runningRef.current = false;
    }
  }

  async function handleApproval(approve: boolean, useEditedValue: boolean) {
    if (session.status !== "active" || !pendingEvent) return;
    const sessionId = session.sessionId;
    const finalValue = useEditedValue ? editValue : undefined;
    const result = await resolveApprovalAction(sessionId, approve, finalValue);
    setTranscript((prev) =>
      prev.map((item, i) =>
        i === prev.length - 1 && item.kind === "event"
          ? { ...item, resolvedApproval: approve ? "approved" : "rejected" }
          : item,
      ),
    );
    setPendingEvent(null);
    if (!result.ok) {
      setTranscript((prev) => [...prev, { kind: "error", message: result.error }]);
      return;
    }
    void runUntilBlocked(sessionId);
  }

  async function handleAnswerHuman() {
    if (session.status !== "active" || !pendingQuestion) return;
    const sessionId = session.sessionId;
    const answer = humanAnswer;
    const result = await answerHumanAction(sessionId, answer);
    setTranscript((prev) =>
      prev.map((item, i) => (i === prev.length - 1 && item.kind === "event" ? { ...item, humanAnswer: answer } : item)),
    );
    setPendingQuestion(null);
    setHumanAnswer("");
    if (!result.ok) {
      setTranscript((prev) => [...prev, { kind: "error", message: result.error }]);
      return;
    }
    void runUntilBlocked(sessionId);
  }

  const startForm = (
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
  );

  const doneButton = (
    <button
      type="button"
      onClick={handleDone}
      disabled={session.status === "ending"}
      className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      {session.status === "ending" ? "Closing…" : "Done"}
    </button>
  );

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
            onClick={() => t.enabled && session.status === "idle" && setTab(t.id)}
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
            startForm
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-slate-600">
                  A real browser window is open on your desktop — sign in / navigate if needed, then use the
                  suggestions below or refresh them any time.
                </p>
                {doneButton}
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

      {tab === "guided" && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {session.status === "idle" || session.status === "starting" || session.status === "error" ? (
            startForm
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-slate-600">
                  A real browser window is open on your desktop — every proposed action needs your approval below
                  before it happens.
                </p>
                {doneButton}
              </div>

              <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
                {transcript.length === 0 ? (
                  <p className="text-xs text-slate-400">Starting…</p>
                ) : (
                  transcript.map((item, i) => <TranscriptLine key={i} item={item} />)
                )}
              </div>

              {pendingEvent && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    Proposed: {pendingEvent.type === "click" ? "click" : "fill"}{" "}
                    <code className="text-xs">{pendingEvent.ref}</code>
                    {pendingEvent.type === "fill" && (
                      <>
                        {" "}
                        with{" "}
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="rounded border border-slate-300 px-1.5 py-0.5 text-sm"
                        />
                      </>
                    )}
                    {" — "}
                    {pendingEvent.reason}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleApproval(true, pendingEvent.type === "fill")}
                      className="rounded-md border border-green-600 bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApproval(false, false)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {pendingQuestion && (
                <div className="rounded-md border border-blue-300 bg-blue-50 p-3">
                  <p className="text-sm text-blue-900">{pendingQuestion}</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={humanAnswer}
                      onChange={(e) => setHumanAnswer(e.target.value)}
                      placeholder="Your answer…"
                      className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={handleAnswerHuman}
                      disabled={!humanAnswer.trim()}
                      className="whitespace-nowrap rounded-md border border-brand-accent bg-brand-accent px-3 py-1 text-sm font-medium text-brand-bg disabled:opacity-50"
                    >
                      Answer
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
