"use client";

import { useEffect, useRef, useState } from "react";
import { endChatSessionAction, resolveChatApprovalAction, resumeChatSessionAction, sendChatMessageAction, startChatSessionAction } from "./actions";

// A real page reload (server restart mid-conversation, or just closing and
// reopening the tab) loses React state entirely -- localStorage is what
// lets the NEXT mount ask for the SAME session id back, so
// resumeChatSessionAction() has something to actually look up. This is
// per-browser-tab-origin, never sent anywhere, and holds nothing but an
// opaque session id (no message content, no secrets).
const SESSION_STORAGE_KEY = "gigradar-chat-session-id";

type ChatMessage =
  | { role: "user" | "assistant" | "system"; text: string }
  | { role: "proposal"; tool: string; description: string; resolved?: "approved" | "rejected" }
  | { role: "screenshot"; sourceId: string; dataUrl: string }
  // chat-copilot-self-tuning epic: a config edit that auto-fired because
  // Config.chatAutoApproveConfigEdits is on -- rendered as a visually
  // distinct warning banner (see the render loop below), never the plain
  // assistant bubble or the approve/reject proposal card.
  | { role: "auto_applied"; tool: string; description: string };

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

    async function init() {
      // Try to resume a session id remembered from before a page
      // reload -- if the server never restarted, `resumeChatSessionAction`
      // still returns resumed:false (nothing persisted a session with no
      // history is never worth resuming), so this always falls back
      // correctly to a fresh session either way.
      let storedId: string | null = null;
      try {
        storedId = localStorage.getItem(SESSION_STORAGE_KEY);
      } catch {
        // Private browsing / storage blocked -- fall through to a fresh session.
      }

      if (storedId) {
        const resumeResult = await resumeChatSessionAction(storedId);
        if (cancelled) return;
        if (resumeResult.ok && resumeResult.data.resumed) {
          setSessionId(storedId);
          setMessages([{ role: "system", text: "↻ Resumed your previous conversation — ask a follow-up any time." }]);
          return;
        }
      }

      const result = await startChatSessionAction();
      if (cancelled || !result.ok) return;
      setSessionId(result.data.sessionId);
      try {
        localStorage.setItem(SESSION_STORAGE_KEY, result.data.sessionId);
      } catch {
        // Private browsing / storage blocked -- resume just won't work next time, not fatal.
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately run once on mount only; sessionId is set BY this effect, not a dependency of it.
  }, []);

  useEffect(() => {
    const id = sessionId;
    return () => {
      if (id) {
        void endChatSessionAction(id);
        try {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
          // Private browsing / storage blocked -- nothing to clean up.
        }
      }
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
      | { type: "auto_applied"; tool: string; input: Record<string, unknown>; description: string }
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
    } else if (event.type === "auto_applied") {
      setMessages((prev) => [...prev, { role: "auto_applied", tool: event.tool, description: event.description }]);
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
