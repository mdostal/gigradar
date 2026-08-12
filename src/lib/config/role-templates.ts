// Five starter `RoleAreaConfig` templates for the config UI's "Start from a
// template" picker (`role-templates` story, `role-templates` epic). Each
// template is a real, thoughtful starting point for a common fractional
// C-suite role — NOT owner-specific criteria (see docs/ARCHITECTURE.md's
// core/user-layer boundary: this file lives in `src/lib`, so it must stay
// generic; a real person's exact titles/keywords belong in their own
// config.json, never here).
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
];
