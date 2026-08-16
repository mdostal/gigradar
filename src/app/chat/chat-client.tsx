"use client";

import { useEffect, useRef, useState } from "react";
import { endChatSessionAction, resolveChatApprovalAction, sendChatMessageAction, startChatSessionAction } from "./actions";

type ChatMessage =
  | { role: "user" | "assistant" | "system"; text: string }
  | { role: "proposal"; tool: string; description: string; resolved?: "approved" | "rejected" }
  | { role: "screenshot"; sourceId: string; dataUrl: string };

/**
 * Starts a real chat session on mount, ends it on unmount (idempotent —
 * a fast navigate-away-and-back never leaks a session, and a
 * double-invoke under React StrictMode's dev double-effect is harmless
 * since endChatSession()/startChatSession() are both safe to call
 * more than once).
 */
export function ChatClient() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // A pending proposal blocks new messages -- mirrors agent-chat-loop.ts's
  // own sendMessage() throwing if called while pendingApproval is set;
  // the input is disabled here so a user can never even attempt it.
  const hasPendingProposal = messages.some((m) => m.role === "proposal" && !m.resolved);

  useEffect(() => {
    let cancelled = false;
    startChatSessionAction().then((result) => {
      if (!cancelled && result.ok) setSessionId(result.data.sessionId);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately run once on mount only; sessionId is set BY this effect, not a dependency of it.
  }, []);

  useEffect(() => {
    const id = sessionId;
    return () => {
      if (id) void endChatSessionAction(id);
    };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  type ChatScreenshot = { sourceId: string; dataUrl: string };

  function applyEvent(
    event:
      | { type: "message"; text: string; screenshots?: ChatScreenshot[] }
      | { type: "proposal"; tool: string; input: Record<string, unknown>; description: string; screenshots?: ChatScreenshot[] }
      | { type: "turn_limit_reached" },
  ) {
    if (event.type === "message") {
      const screenshots = event.screenshots ?? [];
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: event.text },
        ...screenshots.map((s): ChatMessage => ({ role: "screenshot", sourceId: s.sourceId, dataUrl: s.dataUrl })),
      ]);
    } else if (event.type === "proposal") {
      const screenshots = event.screenshots ?? [];
      setMessages((prev) => [
        ...prev,
        ...screenshots.map((s): ChatMessage => ({ role: "screenshot", sourceId: s.sourceId, dataUrl: s.dataUrl })),
        { role: "proposal", tool: event.tool, description: event.description },
      ]);
    } else {
      setMessages((prev) => [...prev, { role: "system", text: "Hit the turn limit for this message — try asking again, or more specifically." }]);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || !sessionId || isSending || hasPendingProposal) return;

    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setIsSending(true);

    const result = await sendChatMessageAction(sessionId, text);
    setIsSending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    applyEvent(result.data);
  }

  async function handleResolveProposal(index: number, approve: boolean) {
    if (!sessionId) return;
    setError(null);
    setIsSending(true);
    setMessages((prev) => prev.map((m, i) => (i === index && m.role === "proposal" ? { ...m, resolved: approve ? "approved" : "rejected" } : m)));

    const result = await resolveChatApprovalAction(sessionId, approve);
    setIsSending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    applyEvent(result.data);
  }

  return (
    <div className="mt-4 flex flex-1 flex-col overflow-hidden rounded-md border border-slate-200">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Try: &ldquo;how many green-tier gigs do I have?&rdquo; or &ldquo;what&apos;s my status summary?&rdquo;
          </p>
        )}
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
          if (m.role === "proposal") {
            return (
              // eslint-disable-next-line react/no-array-index-key -- messages are append-only within this session, index is stable
              <div key={i} className="self-stretch rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">The agent wants to: {m.description}</p>
                {!m.resolved ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleResolveProposal(i, true)}
                      disabled={isSending}
                      className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleResolveProposal(i, false)}
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
          void handleSend();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            hasPendingProposal ? "Resolve the pending action above first…" : sessionId ? "Ask about your gigs…" : "Starting chat…"
          }
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
