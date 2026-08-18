import { KNOWN_SOURCES } from "@/lib/sources/origins";
import { readRawConfig } from "@/lib/config/save";
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
 *
 * The picker list is NOT just KNOWN_SOURCES (the 3 hand-written adapters) —
 * it's KNOWN_SOURCES UNION every CONFIGURED custom-llm source with
 * settings.customAuth: "browser-session" (a source-presets.ts preset like
 * Catalant/Indeed, or a hand-typed custom source), read fresh from
 * readRawConfig() — same "explicitly declared customAuth" predicate
 * config-client.tsx's showsCaptureLogin() already uses for the Capture
 * Login button, so a source only shows here once it's ALSO eligible for
 * Capture Login. A source missing a registered profile-edit URL still
 * appears (never silently hidden) — starting a session for it surfaces
 * assist-session.ts's own actionable "set settings.profileUrl" error
 * rather than pretending the option doesn't exist.
 */
export default function ProfileAssistPage() {
  const knownBrowserSessionSources = KNOWN_SOURCES.filter((s) => s.auth === "browser-session").map((s) => ({
    id: s.id,
    label: s.label,
  }));

  const raw = readRawConfig();
  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const knownIds = new Set(knownBrowserSessionSources.map((s) => s.id));
  const customBrowserSessionSources = rawSources
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .filter((s) => s.kind === "custom-llm")
    .filter((s) => {
      const settings = s.settings;
      return typeof settings === "object" && settings !== null && (settings as Record<string, unknown>).customAuth === "browser-session";
    })
    .filter((s) => typeof s.id === "string" && !knownIds.has(s.id))
    .map((s) => ({ id: s.id as string, label: s.id as string }));

  const browserSessionSources = [...knownBrowserSessionSources, ...customBrowserSessionSources];

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
