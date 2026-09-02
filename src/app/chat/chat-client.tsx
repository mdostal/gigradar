"use client";

import { useEffect, useState } from "react";
import { endChatSessionAction, resumeChatSessionAction, startChatSessionAction } from "./actions";
import { ChatConversation } from "./chat-conversation";
import { useChatConversation } from "./use-chat-conversation";

// A real page reload (server restart mid-conversation, or just closing and
// reopening the tab) loses React state entirely -- localStorage is what
// lets the NEXT mount ask for the SAME session id back, so
// resumeChatSessionAction() has something to actually look up. This is
// per-browser-tab-origin, never sent anywhere, and holds nothing but an
// opaque session id (no message content, no secrets).
const SESSION_STORAGE_KEY = "gigradar-chat-session-id";

/**
 * Starts a real chat session on mount, ends it on unmount (idempotent —
 * a fast navigate-away-and-back never leaks a session, and a
 * double-invoke under React StrictMode's dev double-effect is harmless
 * since endChatSession()/startChatSession() are both safe to call
 * more than once). Message rendering + send/approve logic live in
 * ChatConversation/useChatConversation (chat-copilot-self-tuning epic,
 * Slice 2 — shared with the new contextual hover-chat panel).
 */
export function ChatClient() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { messages, setMessages, input, setInput, isSending, error, hasPendingProposal, handleSend, handleResolveProposal } =
    useChatConversation(sessionId);

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

  return (
    <div className="mt-4 flex flex-1 flex-col overflow-hidden">
      <ChatConversation
        messages={messages}
        isSending={isSending}
        error={error}
        sessionId={sessionId}
        hasPendingProposal={hasPendingProposal}
        input={input}
        onInputChange={setInput}
        onSend={() => void handleSend()}
        onResolveProposal={(i, approve) => void handleResolveProposal(i, approve)}
        emptyStateHint="Try: “how many green-tier gigs do I have?” or “what’s my status summary?”"
        inputPlaceholder="Ask about your gigs…"
      />
    </div>
  );
}
