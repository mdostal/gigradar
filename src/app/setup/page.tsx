import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";
import type { Config } from "@/lib/types";
import { SetupWizardClient } from "./setup-wizard-client";

// product-review-followups epic, setup-wizard story. Owner's own words:
// "Feed in my local resume and all of my data and whatever we need and
// let's walk through the setup (put an easy profile and wizard together
// for setup and changing preferences and nailing out the gigs we are
// aiming for)." A guided SUBSET of /config's full raw-form editing --
// intentionally not a replacement for it (the full Settings editor stays
// the place for anything this wizard doesn't cover: custom sources,
// per-source settings, auto-fire rules, etc.).
//
// Same "read fresh every request" reasoning as /config's own page.tsx --
// re-enterable later for "changing preferences," not just first-run, so a
// stale prerendered snapshot would show wrong pre-filled values on a
// second visit.
export const dynamic = "force-dynamic";

export default function SetupPage() {
  const raw = readRawConfig();
  const parsed = ConfigSchema.safeParse(raw);
  // First-run (no config.json yet, or one that doesn't parse) starts the
  // wizard fully blank -- never guesses. A re-entry (parsed.success) pre-
  // fills every step from the REAL current config, so "changing
  // preferences" genuinely edits what's already there, not a fresh blank
  // slate that would silently blow away real settings.
  const existing: Config | null = parsed.success ? parsed.data : null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <SetupWizardClient existing={existing} />
    </main>
  );
}
