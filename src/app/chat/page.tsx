import { ChatClient } from "./chat-client";

// agent-chat epic, chat-loop-core story. A dedicated page (v1 decision,
// design-discussion.md §5) -- not a floating overlay across every page --
// same "real, focused interaction gets its own page" reasoning
// /profile-assist already established.
export default function ChatPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col p-6" style={{ height: "calc(100vh - 2rem)" }}>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Chat</h1>
      <p className="text-sm text-slate-500">
        Ask about your tracked gigs and pipeline status, or ask it to update a status, draft an application, generate a prep packet, or run a scan — every one of those is proposed first and only runs after you click Approve.
      </p>
      <ChatClient />
    </main>
  );
}
