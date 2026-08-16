// ats-navigator epic, source-presets story. A small curated list of
// ready-made `custom-llm-source` settings objects a user can pick from --
// mirrors config/role-templates.ts's exact shape (id/label/description +
// a real, non-empty config), one layer over: role-templates.ts pre-fills
// a RoleAreaConfig, this file pre-fills a custom-llm-source SourceConfig's
// `settings`. Consumed by the config UI's "Add a source" preset dropdown
// (config-add-source-presets story) and agent-chat's add_source tool
// (chat-guided-source-onboarding story) -- ONE array, two front doors,
// never two divergent preset lists.
//
// Owner-confirmed closed list of three (see design-discussion.md §3 "and
// etc." -- resolved): Indeed, Welcome to the Jungle, Zoho Recruit. Per-
// platform strategy grounded in REAL robots.txt research (design-
// discussion.md §3), not a guess:
//   - Indeed: robots.txt explicitly disallows /viewjob?, /applystart, and
//     singles out AI bots -- an EXPLICIT, owner-overridden exception
//     ("i don't give a shit about indeed and their robots"), same posture
//     as linkedin.ts's own documented exception. customAuth defaults to
//     "browser-session" given Indeed's likely-aggressive bot detection.
//   - Welcome to the Jungle: robots.txt only disallows search-query pages,
//     not listing pages -- no exception needed, public (customAuth unset).
//   - Zoho Recruit: not one site, an ATS vendor every company self-hosts
//     -- the generic mechanism's whole reason to exist. Public by default;
//     a login-gated company page still works via the existing Capture
//     Login flow, just not pre-filled by this preset.
//
// `suggestsGmailDigest` flags presets whose platform typically notifies
// application status/interview invites by email -- consumed by
// chat-guided-source-onboarding's add_source tool to offer connecting
// Gmail (the ALREADY-BUILT start_gmail_connect tool) in the same
// onboarding turn, never a second email-parsing mechanism.
import type { SourceConfig } from "../types.js";

export interface SourcePreset {
  /** Stable, unique key -- used as the default SourceConfig.id and the <option> value in the picker. */
  id: string;
  /** Human-readable label shown in the picker dropdown. */
  label: string;
  /** One-sentence description of the platform, shown alongside the label. */
  description: string;
  /** Pre-filled custom-llm-source settings -- assigned directly into SourceConfig["settings"]. */
  settings: NonNullable<SourceConfig["settings"]>;
  /** True when this platform typically notifies candidates by email (application status, interview invites) -- see file header. */
  suggestsGmailDigest?: boolean;
}

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    id: "indeed",
    label: "Indeed",
    description: "A large, centralized job board. Point this at one company's Indeed jobs page, not a keyword search.",
    settings: {
      url: "https://www.indeed.com/cmp/Example-Company/jobs",
      hint:
        "Indeed company jobs page: a vertical list of job cards, each with a title, the company name (repeated per card), " +
        "a location, and a short snippet of the description. Clicking a card opens the full posting at a /viewjob?jk=... URL " +
        "-- use THAT url as each extracted Gig's own url, not this listing page's url.",
      customAuth: "browser-session",
    },
    suggestsGmailDigest: true,
  },
  {
    id: "welcome-to-the-jungle",
    label: "Welcome to the Jungle",
    description: "A centralized European job board. Point this at one company's Welcome to the Jungle jobs page.",
    settings: {
      url: "https://www.welcometothejungle.com/en/companies/example-company/jobs",
      hint:
        "Welcome to the Jungle company jobs page: a grid or list of job cards, each with a title, contract type " +
        "(CDI/CDD/Freelance/etc), and location. Each card links to its own full posting page -- use that page's url " +
        "as each extracted Gig's own url.",
    },
  },
  {
    id: "zoho-recruit",
    label: "Zoho Recruit",
    description: "An ATS many companies self-host their careers page on. Point this at that specific company's careers page.",
    settings: {
      url: "https://example.zohorecruit.com/jobs/Careers",
      hint:
        "A Zoho Recruit careers page: a simple list of open positions, usually just a title, department, and location " +
        "per row, each linking to its own application page -- use that application page's url as each extracted Gig's own url. " +
        "Layout varies more company-to-company than most job boards, since each company configures its own Zoho Recruit portal.",
    },
    suggestsGmailDigest: true,
  },
];

/**
 * Builds a real, ready-to-save `SourceConfig` from a preset -- the ONE
 * conversion both `/config`'s "Add from a preset" UI (config-add-source-
 * presets story) and agent-chat's `add_source` tool (chat-guided-source-
 * onboarding story) call, so there is exactly one preset-to-SourceConfig
 * code path, not two. `existingIds` is whatever source ids the caller
 * already has configured -- the returned SourceConfig's `id` is uniqued
 * against that set (an incrementing numeric suffix) rather than silently
 * colliding with/overwriting an already-configured source.
 */
export function sourceConfigFromPreset(preset: SourcePreset, existingIds: Iterable<string>): SourceConfig {
  const taken = new Set(existingIds);
  let id = preset.id;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${preset.id}-${suffix}`;
    suffix += 1;
  }
  return { id, enabled: true, kind: "custom-llm", settings: preset.settings };
}
