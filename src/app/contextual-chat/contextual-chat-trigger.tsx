"use client";

// chat-copilot-self-tuning epic, Slice 2. The "hover/interact depending on
// the page you're on" entry point (design-discussion.md §6a) -- a small
// icon button dropped into a Dashboard gig row / Drafts card / Config
// source row that, on click, opens a slide-over chat panel pre-seeded
// with that row's real data (see startContextualChatSessionAction in
// ../chat/actions.ts). Same underlying agent-chat-loop.ts session
// mechanism as the general /chat page -- no second chat engine, just a
// second, context-aware entry point into it.
import { useEffect, useState } from "react";
import type { ContextualChatKind } from "../chat/actions";
import { endChatSessionAction, startContextualChatSessionAction } from "../chat/actions";
import { ChatConversation } from "../chat/chat-conversation";
import { useChatConversation } from "../chat/use-chat-conversation";

export function ContextualChatTrigger({ kind, itemKey, label }: { kind: ContextualChatKind; itemKey: string; label: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title={`Ask about ${label}`}
        aria-label={`Ask about ${label}`}
        className="rounded-md border border-theme-surface-border px-1.5 py-1 text-xs text-theme-text-dim opacity-0 transition-opacity hover:bg-theme-surface-raised hover:text-theme-text group-hover:opacity-100 focus-visible:opacity-100"
      >
        💬
      </button>
      {isOpen && <ContextualChatPanel kind={kind} itemKey={itemKey} label={label} onClose={() => setIsOpen(false)} />}
    </>
  );
}

function ContextualChatPanel({ kind, itemKey, label, onClose }: { kind: ContextualChatKind; itemKey: string; label: string; onClose: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [contextLabel, setContextLabel] = useState(label);
  const [startError, setStartError] = useState<string | null>(null);
  const { messages, input, setInput, isSending, error, hasPendingProposal, handleSend, handleResolveProposal } = useChatConversation(sessionId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await startContextualChatSessionAction(kind, itemKey);
      if (cancelled) return;
      if (!result.ok) {
        setStartError(result.error);
        return;
      }
      setSessionId(result.data.sessionId);
      setContextLabel(result.data.contextLabel);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per mount; kind/itemKey are fixed for the lifetime of this panel instance (a new key from the parent unmounts/remounts it).
  }, []);

  useEffect(() => {
    const id = sessionId;
    return () => {
      if (id) void endChatSessionAction(id);
    };
  }, [sessionId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2 border-b border-slate-200 pb-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Chatting about</p>
            <p className="font-medium text-slate-900">{contextLabel}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close chat" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </div>
        {startError ? (
          <p role="alert" className="text-sm text-red-700">
            {startError}
          </p>
        ) : (
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
            emptyStateHint={`Ask anything about “${contextLabel}” — e.g. “why did this match” or “what should I change?”`}
            inputPlaceholder="Ask about this…"
          />
        )}
      </div>
    </div>
  );
}
