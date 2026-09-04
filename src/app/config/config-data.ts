// config-dashboard-and-section-pages story: shared data-loading logic for
// both the new dashboard home (page.tsx) and every /config/[section] page
// -- extracted from the old single-page config/page.tsx verbatim (same
// readRawConfig()/ConfigSchema.safeParse()/blankConfig() fallback,
// isPortunusAvailable(), per-source checkSessionReadiness(), open-issues
// set), so every config route assembles its props identically. No logic
// changed, only relocated -- see dashboard-data.ts's own loadDashboardData()
// for the established "one shared loader, every route calls it" precedent
// this mirrors.
import { cache } from "react";
import { isPortunusAvailable } from "@/lib/auth/session-backend";
import { checkSessionReadiness, type SessionReadiness } from "@/lib/auth/session-readiness";
import { ConfigSchema } from "@/lib/config/schema";
import { readRawConfig } from "@/lib/config/save";
import { listIssues } from "@/lib/notify/issues";
import type { Config } from "@/lib/types";

/**
 * The blank/empty-shaped starting document for first-run setup — never
 * written to disk on its own (the user has to actually submit the form),
 * just what pre-populates the form's controlled inputs. `roleArea` and
 * `schedule` are deliberately absent (not `{}`/`""`), matching their
 * documented "omitted is valid" semantics (src/lib/types.ts) — the form
 * itself renders those sections as disabled/off by default rather than
 * enabled-but-empty.
 */
export function blankConfig(): Config {
  return {
    profile: { name: "", roles: [], skills: [], timezone: "" },
    groups: [
      {
        id: "default-search-1",
        label: "Default Search 1",
        needs: {
          engagementProfiles: [],
          freshStageOnly: false,
          remoteOnly: false,
        },
      },
    ],
    sources: [],
  };
}

export interface ConfigPageData {
  initial: Config;
  configExists: boolean;
  parsedSuccessfully: boolean;
  portunusAvailable: boolean;
  sessionReadiness: Record<string, SessionReadiness>;
  sourcesWithOpenIssues: string[];
  subtitle: string;
}

/**
 * Reads config.json RAW — via `readRawConfig()`, never `loadConfig()`
 * (which resolves "env:" references to real secret values). First-run
 * handling: `readRawConfig()` is ENOENT-tolerant (`{}` when no config.json
 * exists yet), so `configExists` is false and `ConfigSchema.safeParse({})`
 * naturally fails — that case (and an existing-but-invalid file) both fall
 * back to `blankConfig()` rather than an error page.
 */
/**
 * `cache()`-wrapped: both config/layout.tsx (the sidebar's data) and
 * whichever page.tsx it wraps (the dashboard home, or a /config/[section]
 * page) call this same function during the SAME request — React's
 * per-request memoization (the standard Next.js App Router pattern for
 * exactly this "layout and page both need the same server data" case)
 * ensures the real, non-trivial cost here (a live `portunus --version`
 * spawn, a per-source session-readiness check loop) runs once per
 * request, not twice.
 */
export const loadConfigPageData = cache(async function loadConfigPageData(): Promise<ConfigPageData> {
  const raw = readRawConfig();
  const configExists = Object.keys(raw).length > 0;
  const parsed = ConfigSchema.safeParse(raw);
  const initial: Config = parsed.success ? parsed.data : blankConfig();

  // Real, live `portunus --version` check — the Settings editor's backend
  // picker is shown ONLY when this is true, hidden (not just disabled)
  // otherwise.
  const portunusAvailable = await isPortunusAvailable();

  // Sequential by design (not Promise.all) — a prior attempt at
  // parallelizing this exact loop caused a real, reproduced hang specific
  // to how the packaged Tauri sidecar spawns this process (root cause
  // still not understood; a plain `node server.js` run of the identical
  // parallel code never hung). Reverted once already this session under a
  // live incident — do not re-parallelize without first understanding
  // that mechanism, this is a deliberate, cautious choice, not an
  // oversight.
  const sessionReadiness: Record<string, SessionReadiness> = {};
  for (const source of initial.sources) {
    sessionReadiness[source.id] = await checkSessionReadiness(source);
  }

  // A "Connected" badge shows a lighter secondary note when its source has
  // an open issue — structured match on the issue's own context.sourceId
  // field (raiseIssue() already sets this for every source-scoped issue),
  // never a keyword-match on the issue's message text.
  const sourcesWithOpenIssues = [
    ...new Set(
      listIssues({ open: true })
        .map((issue) => issue.context?.sourceId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  let subtitle: string;
  if (!configExists) {
    subtitle = "No config.json found yet — fill in Profile, Sources, and Groups to create one (first-run setup).";
  } else if (parsed.success) {
    subtitle = "Editing your existing config.json.";
  } else {
    subtitle =
      "An existing config.json failed validation, so a blank form is shown below — saving will overwrite the invalid file once the form itself validates.";
  }

  return { initial, configExists, parsedSuccessfully: parsed.success, portunusAvailable, sessionReadiness, sourcesWithOpenIssues, subtitle };
});
