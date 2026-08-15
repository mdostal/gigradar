import { KNOWN_SOURCES } from "@/lib/sources/origins";
import { ProfileAssistClient } from "./profile-assist-client";

/**
 * profile-assist epic, profile-assist-persistent-session-manual-mode
 * story. A Server Component only to compute the source picker's option
 * list (browser-session-auth sources only — the assist-session mechanism
 * reuses the SAME storageState/origin-scoping path as every other
 * browser-session-auth flow in this app, so a source with no captured
 * session isn't a meaningful target here). Everything else (starting/
 * ending a session, fetching suggestions) is client-driven Server Actions
 * — see profile-assist-client.tsx.
 */
export default function ProfileAssistPage() {
  const browserSessionSources = KNOWN_SOURCES.filter((s) => s.auth === "browser-session");

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Profile assist</h1>
      <p className="text-sm text-slate-500">
        LLM-assisted help filling out your profile on a job platform — a real browser window opens on your own
        desktop, you stay in control the whole time.
      </p>
      <ProfileAssistClient sources={browserSessionSources} />
    </main>
  );
}
