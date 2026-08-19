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
// Owner-confirmed list (see design-discussion.md §3 "and etc." --
// resolved, later expanded via a deep-research pass -- see
// .pHive/epics/source-presets-expansion/ for that research). Per-platform
// strategy grounded in REAL research, not a guess:
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
//   - Catalant (gocatalant.com): the owner's own former platform, entirely
//     login-gated (legacy gig-radar's platforms.mjs had it as
//     `scrape: false` -- never actually automated, no reference logic to
//     port). The public site exposes no listings at all (confirmed by
//     research: no /projects, /opportunities, or /marketplace path --
//     everything lives behind app.gocatalant.com once logged in). Per the
//     owner, once authenticated it's BOTH a browsable marketplace of open
//     engagements AND personally-matched opportunities pushed to the
//     account -- the hint below describes both. customAuth defaults to
//     "browser-session"; the settings.url is a best-effort placeholder
//     (the real in-app URL can only be discovered by actually logging in)
//     pending live Capture Login verification against the owner's real
//     account.
//   - Greenhouse, Ashby, Workable: same "ATS vendor, not one site" shape
//     as Zoho Recruit -- each company self-hosts a `{host}/{company}`
//     board. All three have permissive/clean robots.txt (Workable even
//     publishes an explicit `Content-Signal: ai-input=yes`), public, no
//     customAuth. (job-boards.greenhouse.io is the current host --
//     boards.greenhouse.io now 301-redirects there.)
//   - Contra, Landing.jobs: general freelance/tech-job boards with
//     permissive robots.txt (Contra explicitly publishes
//     `Content-Signal: ai-input=yes`) and public listing pages.
//   - Gun.io (gun.io): a curated freelance-developer marketplace, same
//     shape as Catalant -- confirmed by direct research (live `curl`, not
//     assumed): the public gun.io/jobs/ page is a marketing teaser (4
//     example cards, zero per-listing links -- the ONLY link on the whole
//     page is a sign-up CTA), and the real listings live behind
//     app.gun.io, a fully client-rendered SPA (`x-guild-version` response
//     header) requiring login. customAuth defaults to "browser-session";
//     the settings.url is a best-effort placeholder (the real in-app URL
//     can only be discovered by actually logging in), same
//     pending-live-verification caveat as Catalant's own entry above.
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
      loginUrl: "https://secure.indeed.com/auth",
      allowedOrigins: ["indeed.com"],
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
  {
    id: "catalant",
    label: "Catalant",
    description:
      "A fractional/independent-consulting marketplace -- entirely login-gated, both browsable and matched opportunities.",
    settings: {
      url: "https://app.gocatalant.com/",
      hint:
        "Catalant's authenticated expert dashboard, reachable after logging in at app.gocatalant.com/c/_/auth/login/. " +
        "Two kinds of engagement cards can appear: browsable open projects in a marketplace/search area, and " +
        "personally-matched opportunities Catalant has surfaced directly to this account (sometimes labeled " +
        "'recommended' or 'invitations'). Extract BOTH kinds as Gigs. Each card has a project title, client " +
        "industry/description, and often a rate/duration estimate; use each card's own detail-page url as the " +
        "extracted Gig's url, not this dashboard url.",
      customAuth: "browser-session",
      loginUrl: "https://app.gocatalant.com/c/_/auth/login/",
      allowedOrigins: ["gocatalant.com", "catalant.com"],
    },
  },
  {
    id: "gun-io",
    label: "Gun.io",
    description: "A curated freelance-developer marketplace -- entirely login-gated, like Catalant.",
    settings: {
      url: "https://app.gun.io/",
      hint:
        "Gun.io's authenticated freelancer dashboard, reachable after logging in at app.gun.io/sign-up/ (existing " +
        "accounts land on the same login form). Look for a jobs/opportunities area listing open roles matched to " +
        "this account -- each card typically has a title, a one-line description of the engagement, and skill tags " +
        "(e.g. 'Backend Engineer', 'Python', 'LLMs'). Use each card's own detail-page url as the extracted Gig's " +
        "url, not this dashboard url.",
      customAuth: "browser-session",
      loginUrl: "https://app.gun.io/sign-up/",
      allowedOrigins: ["gun.io"],
    },
  },
  {
    id: "greenhouse",
    label: "Greenhouse",
    description: "An ATS many companies self-host their careers board on. Point this at that specific company's Greenhouse board.",
    settings: {
      url: "https://job-boards.greenhouse.io/example-company",
      hint:
        "A Greenhouse job board: postings grouped by department, each row showing a title, department, and location, " +
        "linking to its own posting page at /example-company/jobs/{numeric-id} -- use that posting page's url as each " +
        "extracted Gig's own url. Some companies redirect their Greenhouse board to a custom-branded careers page " +
        "instead of showing job-boards.greenhouse.io directly -- if this url redirects, read the redirected page.",
    },
    suggestsGmailDigest: true,
  },
  {
    id: "ashby",
    label: "Ashby",
    description: "An ATS many companies self-host their careers board on. Point this at that specific company's Ashby board.",
    settings: {
      url: "https://jobs.ashbyhq.com/example-company",
      hint:
        "An Ashby job board (jobs.ashbyhq.com/{company}): a list of open roles, typically grouped by team/department, " +
        "each with a title and location, linking to its own posting page at /{company}/{uuid} -- use that posting " +
        "page's url as each extracted Gig's own url. This is a client-rendered page -- if the initial fetch looks " +
        "empty, wait for the listing to render before extracting.",
    },
  },
  {
    id: "workable",
    label: "Workable",
    description: "An ATS many companies self-host their careers page on. Point this at that specific company's Workable board.",
    settings: {
      url: "https://apply.workable.com/example-company",
      hint:
        "A Workable careers page (apply.workable.com/{company} or jobs.workable.com/{company}): a list of open " +
        "positions with title, department, and location, each linking to its own application page -- use that " +
        "application page's url as each extracted Gig's own url.",
    },
    suggestsGmailDigest: true,
  },
  {
    id: "contra",
    label: "Contra",
    description: "A freelance/independent-work marketplace. Point this at its public opportunities listing.",
    settings: {
      url: "https://contra.com/opportunities",
      hint:
        "Contra's opportunities page: a grid of freelance project/role cards, each with a title, client/company name, " +
        "and often a budget or engagement-length indicator. Each card links to its own detail page -- use that page's " +
        "url as each extracted Gig's own url. This is a client-rendered page -- wait for the grid to render before extracting.",
    },
  },
  {
    id: "landing-jobs",
    label: "Landing.jobs",
    description: "A European (Portugal/EU-centric) tech job board. Point this at its general listing page, not a search/filtered URL.",
    settings: {
      url: "https://landing.jobs/jobs",
      hint:
        "Landing.jobs' general job listing page: a list of tech role cards, each with a title, company name, location, " +
        "and often a remote/hybrid indicator, linking to its own posting page -- use that posting page's url as each " +
        "extracted Gig's own url. Mixed seniority, not exclusively fractional/contract -- expect some full-time listings mixed in.",
    },
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
