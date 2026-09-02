"use client";

// chat-copilot-self-tuning epic, Slice 2. Extracted from chat-client.tsx
// (which owned this rendering inline before Slice 2) so the SAME
// message-list + input-form UI backs both the full /chat page and the
// new contextual hover-chat panel (contextual-chat-trigger.tsx) -- one
// rendering implementation, two entry points into the same underlying
// agent-chat-loop.ts session mechanism.
import { useEffect, useRef } from "react";

export type ChatScreenshot = { sourceId: string; dataUrl: string };

export type ChatMessage =
  | { role: "user" | "assistant" | "system"; text: string }
  | { role: "proposal"; tool: string; description: string; resolved?: "approved" | "rejected" }
  | { role: "screenshot"; sourceId: string; dataUrl: string }
  // chat-copilot-self-tuning epic: a config edit that auto-fired because
  // Config.chatAutoApproveConfigEdits is on -- rendered as a visually
  // distinct warning banner, never the plain assistant bubble or the
  // approve/reject proposal card.
  | { role: "auto_applied"; tool: string; description: string };

export function ChatConversation({
  messages,
  isSending,
  error,
  sessionId,
  hasPendingProposal,
  input,
  onInputChange,
  onSend,
  onResolveProposal,
  emptyStateHint,
  inputPlaceholder,
}: {
  messages: ChatMessage[];
  isSending: boolean;
  error: string | null;
  sessionId: string | null;
  hasPendingProposal: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onResolveProposal: (index: number, approve: boolean) => void;
  /** Shown when there are no messages yet -- the two call sites want different suggested prompts. */
  emptyStateHint: string;
  /** Placeholder shown once a session is ready and nothing is blocking input -- the two call sites phrase this slightly differently. */
  inputPlaceholder: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-md border border-slate-200">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && <p className="text-sm text-slate-400">{emptyStateHint}</p>}
        {messages.map((m, i) => {
          if (m.role === "screenshot") {
            return (
              // eslint-disable-next-line react/no-array-index-key -- messages are append-only within this session, index is stable
              <div key={i} className="self-start rounded-md border border-slate-200 bg-slate-50 p-2">
                <p className="mb-1 text-xs text-slate-500">Screenshot of the open login capture for &ldquo;{m.sourceId}&rdquo;:</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI screenshot, never a remote/optimizable src */}
                <img src={m.dataUrl} alt={`Screenshot of the login capture for ${m.sourceId}`} className="max-h-80 max-w-full rounded border border-slate-300" />
              </div>
            );
          }
          if (m.role === "auto_applied") {
            return (
              // eslint-disable-next-line react/no-array-index-key -- messages are append-only within this session, index is stable
              <div key={i} className="self-stretch rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm text-red-900" role="alert">
                <p className="font-semibold">⚠ Auto-approved (config-edit auto-approve is on): {m.description}</p>
              </div>
            );
          }
          if (m.role === "proposal") {
            return (
              // eslint-disable-next-line react/no-array-index-key -- messages are append-only within this session, index is stable
              <div key={i} className="self-stretch rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">The agent wants to: {m.description}</p>
                {!m.resolved ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onResolveProposal(i, true)}
                      disabled={isSending}
                      className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolveProposal(i, false)}
                      disabled={isSending}
                      className="rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-medium text-amber-800 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs italic">{m.resolved === "approved" ? "Approved." : "Rejected."}</p>
                )}
              </div>
            );
          }
          return (
            // eslint-disable-next-line react/no-array-index-key -- messages are append-only within this session, index is stable
            <div key={i} className={`max-w-[85%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === "user"
                ? "self-end bg-slate-900 text-white"
                : m.role === "system"
                  ? "self-center bg-amber-50 text-amber-800"
                  : "self-start bg-slate-100 text-slate-900"
            }`}
            >
              {m.text}
            </div>
          );
        })}
        {isSending && <p className="self-start text-sm text-slate-400">Thinking…</p>}
        {error && <p role="alert" className="self-start text-sm text-red-700">{error}</p>}
        <div ref={bottomRef} />
      </div>
      <form
        className="flex gap-2 border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={hasPendingProposal ? "Resolve the pending action above first…" : sessionId ? inputPlaceholder : "Starting chat…"}
          disabled={!sessionId || isSending || hasPendingProposal}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!sessionId || isSending || hasPendingProposal || !input.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
