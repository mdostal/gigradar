// gigradar-command-center epic, interview-workspace-page story. Once a
// gig's status is "interview" it gets its own page instead of a table row
// -- this assembles everything that page needs in one server-side read.
// Config is read via readRawConfig() (never loadConfig()) -- Materials only
// ever needs the RAW Profile/ApplyProfileConfig shape, never a resolved
// secret, so this stays on the non-resolving read path CLAUDE.md's
// "Secrets" contract requires by default.
import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";
import { getDraft, getGig, getInterviewPrep } from "@/lib/store";
import type { StoredDraft, StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import type { ApplyProfileConfig, Profile } from "@/lib/types";

export interface InterviewWorkspaceData {
  gig: StoredGig;
  prep: PrepPacketContent | undefined;
  draft: StoredDraft | undefined;
  profile: Profile | undefined;
  applyProfile: ApplyProfileConfig | undefined;
}

/** Returns `undefined` for an unknown key -- the page treats that as a real 404, not an empty workspace. */
export function loadInterviewWorkspaceData(key: string): InterviewWorkspaceData | undefined {
  const gig = getGig(key);
  if (!gig) return undefined;

  const prep = getInterviewPrep(key)?.content;
  const draft = getDraft(key);

  // Tolerant, same posture as dashboard-data.ts's own raw-config reads: an
  // incomplete/never-configured Profile degrades the Materials section to
  // "nothing on file yet" rather than a crashed page.
  const parsedConfig = ConfigSchema.safeParse(readRawConfig());
  const profile = parsedConfig.success ? parsedConfig.data.profile : undefined;
  const applyProfile = parsedConfig.success ? parsedConfig.data.applyProfile : undefined;

  return { gig, prep, draft, profile, applyProfile };
}
