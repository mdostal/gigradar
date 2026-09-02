"use client";

// chat-copilot-self-tuning epic, Slice 2. Extracted from chat-client.tsx
// so both the full /chat page and the new contextual hover-chat panel
// (contextual-chat-trigger.tsx) share the exact same send/approve logic
// against a given sessionId -- only session ACQUISITION (fresh vs.
// resumed vs. contextual-seeded) differs between the two call sites, and
// that stays owned by each caller.
import { useState } from "react";
import { resolveChatApprovalAction, sendChatMessageAction } from "./actions";
import type { ChatLoopEvent } from "@/lib/chat/agent-chat-loop";
import type { ChatMessage, ChatScreenshot } from "./chat-conversation";

export function useChatConversation(sessionId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A pending proposal blocks new messages -- mirrors agent-chat-loop.ts's
  // own sendMessage() throwing if called while pendingApproval is set;
  // the input is disabled in ChatConversation so a user can never even attempt it.
  const hasPendingProposal = messages.some((m) => m.role === "proposal" && !m.resolved);

  function applyEvent(event: ChatLoopEvent) {
    if (event.type === "message") {
      const screenshots = (event.screenshots ?? []) as ChatScreenshot[];
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: event.text },
        ...screenshots.map((s): ChatMessage => ({ role: "screenshot", sourceId: s.sourceId, dataUrl: s.dataUrl })),
      ]);
    } else if (event.type === "proposal") {
      const screenshots = (event.screenshots ?? []) as ChatScreenshot[];
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

  return { messages, setMessages, input, setInput, isSending, error, hasPendingProposal, handleSend, handleResolveProposal };
}
