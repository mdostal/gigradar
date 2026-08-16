// Starter `RoleAreaConfig` templates for the config UI's "Start from a
// template" picker (`role-templates` story, `role-templates` epic). Each
// template is a real, thoughtful starting point — NOT owner-specific
// criteria (see docs/ARCHITECTURE.md's core/user-layer boundary: this
// file lives in `src/lib`, so it must stay generic; a real person's exact
// titles/keywords belong in their own config.json, never here). The
// original 5 are fractional C-suite (this session's own owner's search);
// broader, engagement-type-agnostic templates were added 2026-08-16 after
// UAT feedback that a fresh install's ONLY defaults looking like one
// person's executive fractional search isn't representative of most
// people's job search (FTE-focused, individual-contributor/manager level,
// on mainstream boards).
//
// Content must respect `../matching/tiering.ts`'s precedence rules:
//   - `coreTitles` are checked against the gig TITLE only, and WIN GREEN even
//     over a `redKeywords` hit in that same title — so these must be tight,
//     unambiguous synonyms for the role itself (never a broad domain word).
//   - `keywords` are the broader title+description green signal, only
//     consulted once neither `coreTitles` nor `redKeywords` matched.
//   - `redKeywords` are TITLE-only "definitely not this" signals. Per this
//     story's design discussion, each template's redKeywords are genuine
//     same-shape-different-domain traps — real job titles that share the
//     "Chief ___ Officer" (or similar) shape and could superficially
//     keyword-match, but name a different role/domain entirely. They are
//     NOT filler like "junior"/"intern".
//
// Each template's `coreTitles`/`keywords` are verified (see
// `__tests__/role-templates.test.ts`) to share zero entries with that same
// template's own `redKeywords` — a self-contradictory template would
// silently misclassify via tiering.ts's precedence order.
//
// To add a sixth template: append a `RoleTemplate` object to
// `ROLE_TEMPLATES` below with a unique `id`. No other file needs to change —
// `config-client.tsx`'s picker renders this array directly.
import type { RoleAreaConfig } from "../types.js";

export interface RoleTemplate {
  /** Stable, unique key — used as the <option> value in the picker. */
  id: string;
  /** Human-readable label shown in the picker dropdown. */
  label: string;
  config: RoleAreaConfig;
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "fractional-cto",
    label: "Fractional CTO",
    config: {
      coreTitles: ["fractional cto", "interim cto", "chief technology officer", "vp of engineering"],
      keywords: ["technology", "engineering", "software architecture", "technical strategy", "engineering leadership"],
      // Real traps: "Chief Talent Officer" shares the "Chief ___ Officer"
      // shape (and is sometimes even shorthanded "CTO" internally) but is an
      // HR role. "Chief Transformation Officer" is an org-change-management
      // role, not a technology one, despite sounding adjacent.
      redKeywords: ["chief talent officer", "chief transformation officer"],
    },
  },
  {
    id: "fractional-coo",
    label: "Fractional COO",
    config: {
      coreTitles: ["fractional coo", "interim coo", "chief operating officer", "vp of operations"],
      keywords: ["operations", "operational efficiency", "process improvement", "supply chain management"],
      // Real traps: "Chief People Officer" and "VP of People Operations"
      // both use "People"/"Operations" language and share the general
      // ops-leadership shape, but are HR roles, not general operations.
      redKeywords: ["chief people officer", "vp of people operations"],
    },
  },
  {
    id: "fractional-cfo",
    label: "Fractional CFO",
    config: {
      coreTitles: ["fractional cfo", "interim cfo", "chief financial officer", "vp of finance"],
      keywords: ["finance", "fp&a", "financial planning", "accounting"],
      // Real traps: "Chief Fundraising Officer" and "Chief Development
      // Officer" are common nonprofit-sector titles sharing the "Chief
      // ___ Officer" shape and money-adjacent language, but they run
      // fundraising/donor development, not corporate finance/accounting.
      redKeywords: ["chief fundraising officer", "chief development officer"],
    },
  },
  {
    id: "fractional-cmo",
    label: "Fractional CMO",
    config: {
      coreTitles: ["fractional cmo", "interim cmo", "chief marketing officer", "vp of marketing"],
      keywords: ["marketing", "brand strategy", "demand generation", "growth marketing"],
      // Real traps: "Chief Medical Officer" is the classic CMO-abbreviation
      // collision — an entirely unrelated healthcare role. "Chief
      // Membership Officer" (common in associations/nonprofits) shares the
      // "Chief M___ Officer" shape and growth-adjacent language, but is a
      // membership-growth role, not marketing.
      redKeywords: ["chief medical officer", "chief membership officer"],
    },
  },
  {
    id: "fractional-cpo",
    label: "Fractional CPO",
    config: {
      coreTitles: ["fractional cpo", "interim cpo", "chief product officer", "vp of product"],
      keywords: ["product management", "product strategy", "product roadmap", "product-market fit"],
      // Real traps: "Chief Procurement Officer" and "Chief People Officer"
      // are both commonly abbreviated "CPO" too, but name supply-chain/
      // purchasing and HR roles respectively — not product.
      redKeywords: ["chief procurement officer", "chief people officer"],
    },
  },
  // 2026-08-16: broader, engagement-type-agnostic starter templates,
  // requested explicitly ("add a bunch of generic ones, keep my specific
  // fractional C-suite for me and friends") after UAT feedback that the
  // original 5 (all fractional C-suite) don't represent most people's
  // job search — most people are looking at FTE/full-time roles on
  // mainstream boards (LinkedIn, Monster, Dice), not executive fractional
  // work. These are individual-contributor/manager-level, no seniority or
  // engagement-type assumption baked into the titles themselves — the
  // SAME role-area classification works for an FTE listing, a fractional
  // one, or a part-time one; engagement type/rate is a completely
  // separate axis (Needs.engagementProfiles), never mixed into
  // RoleAreaConfig here.
  {
    id: "software-engineer",
    label: "Software Engineer",
    config: {
      coreTitles: ["software engineer", "senior software engineer", "staff software engineer", "backend engineer", "frontend engineer", "full stack engineer"],
      keywords: ["software development", "programming", "system design", "software architecture"],
      // Real traps: "Sales Engineer" is customer-facing technical sales,
      // not development. "Field Service Engineer" is on-site hardware/
      // networking support, not software. Both share "engineer" but name
      // a different discipline entirely.
      redKeywords: ["sales engineer", "field service engineer"],
    },
  },
  {
    id: "product-manager",
    label: "Product Manager",
    config: {
      coreTitles: ["product manager", "senior product manager", "associate product manager", "technical product manager"],
      keywords: ["product management", "product strategy", "product roadmap", "user research"],
      // Real trap: "Program Manager" is the classic "PM" abbreviation
      // collision — a completely different discipline (cross-team
      // execution/coordination, not product ownership) that's easy to
      // mismatch on the shared initials alone.
      redKeywords: ["program manager"],
    },
  },
  {
    id: "data-analytics",
    label: "Data & Analytics",
    config: {
      coreTitles: ["data analyst", "data scientist", "analytics manager", "business intelligence analyst"],
      keywords: ["data analysis", "sql", "analytics", "reporting", "dashboards"],
      // Real trap: "Data Entry" superficially shares the "data" keyword
      // but is a low-skill clerical role, not analysis/science.
      redKeywords: ["data entry"],
    },
  },
  {
    id: "sales-account-exec",
    label: "Sales / Account Executive",
    config: {
      coreTitles: ["account executive", "sales representative", "business development representative", "enterprise account executive"],
      keywords: ["sales", "business development", "quota", "pipeline", "prospecting"],
      // Real trap: "Sales Operations" is an analytics/process role
      // supporting a sales team, not a quota-carrying sales role itself.
      redKeywords: ["sales operations"],
    },
  },
  {
    id: "marketing-professional",
    label: "Marketing Professional",
    config: {
      coreTitles: ["marketing manager", "digital marketing manager", "content marketing manager", "growth marketing manager"],
      keywords: ["marketing", "brand strategy", "campaigns", "content strategy"],
      // Real trap: "Marketing Operations" is a process/tooling/analytics
      // role supporting the marketing org, not day-to-day brand/campaign
      // marketing itself — same "X Operations" adjacent-discipline shape
      // as this file's own sales/HR-ops traps below.
      redKeywords: ["marketing operations"],
    },
  },
  {
    id: "customer-success",
    label: "Customer Success / Support",
    config: {
      coreTitles: ["customer success manager", "customer success specialist", "support specialist", "technical support engineer"],
      keywords: ["customer success", "onboarding", "retention", "customer support"],
      // Real trap: "Help Desk Technician"/"IT Support Specialist" both
      // use "support" but serve INTERNAL employees (fixing their own
      // company's computers), not paying customers — a different
      // audience and function entirely, commonly conflated on title
      // keyword alone.
      redKeywords: ["help desk technician", "it support specialist"],
    },
  },
  {
    id: "operations-manager",
    label: "Operations Manager",
    config: {
      coreTitles: ["operations manager", "operations coordinator", "program operations manager"],
      keywords: ["operations", "process improvement", "logistics", "vendor management"],
      // Real trap: "HR Operations Manager"/"People Operations Manager"
      // share the "Operations" shape but name an HR-specific function
      // (benefits, payroll, employee lifecycle), not general business
      // operations — same "Operations"-abbreviation-collision pattern as
      // this file's fractional-COO template's own redKeywords.
      redKeywords: ["hr operations manager", "people operations manager"],
    },
  },
  {
    id: "general-part-time",
    label: "Part-Time / Hourly Work",
    config: {
      // Deliberately broad, not domain-specific — this template is about
      // catching listings that EXPLICITLY signal flexible/hourly work in
      // their own title, across any field, as a general-purpose starting
      // point. Pair with a part-time-shaped EngagementProfile (Needs
      // section) for the rate/hours side of this — role-area templates
      // here only ever classify WHAT the work is, never how many hours.
      coreTitles: ["part-time", "part time", "hourly", "flexible schedule"],
      keywords: ["part-time", "flexible hours", "contract", "freelance"],
      // Real trap: an unpaid "Volunteer" listing often uses the exact
      // same "flexible schedule" language as a genuine paid part-time
      // role, but names a fundamentally different (unpaid) arrangement —
      // a real mismatch for anyone using this template to find PAID
      // part-time work.
      redKeywords: ["volunteer"],
    },
  },
];
