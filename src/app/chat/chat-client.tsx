"use client";

import { useEffect, useRef, useState } from "react";
import { endChatSessionAction, sendChatMessageAction, startChatSessionAction } from "./actions";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

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

  async function handleSend() {
    const text = input.trim();
    if (!text || !sessionId || isSending) return;

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
    const event = result.data;
    if (event.type === "message") {
      const text = event.text;
      setMessages((prev) => [...prev, { role: "assistant", text }]);
    } else if (event.type === "turn_limit_reached") {
      setMessages((prev) => [...prev, { role: "system", text: "Hit the turn limit for this message — try asking again, or more specifically." }]);
    }
  }

  return (
    <div className="mt-4 flex flex-1 flex-col overflow-hidden rounded-md border border-slate-200">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Try: &ldquo;how many green-tier gigs do I have?&rdquo; or &ldquo;what&apos;s my status summary?&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
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
        ))}
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
          placeholder={sessionId ? "Ask about your gigs…" : "Starting chat…"}
          disabled={!sessionId || isSending}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!sessionId || isSending || !input.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
