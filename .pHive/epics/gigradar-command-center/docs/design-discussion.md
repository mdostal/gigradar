# gigradar-command-center — design discussion

Owner's real synthesis of the 3 Dashboard concepts published in
`ui-overhaul-via-ui-squads`, expanded well past a single-page redesign
into a real multi-page information architecture — the "big RE-DESIGN
effort" first named (and deferred) in `product-review-followups` Area E,
now finally getting its own `/plan` pass. Owner's own words: "we did
something like this before and it didn't fully land last time... I keep
fucking saying this... we asked all of this to be fully planned and
implemented and we never did."

## 1. Research — what already exists, so this doesn't repeat history

**`ui-theme-system` epic (shipped, PR #67, all 4 stories `status: complete`)**
already built exactly the infrastructure this epic needs: `Config.uiTheme:
"radar"|"editorial"|"terminal"`, a `data-theme` attribute stamped by
`layout.tsx`, one CSS file per theme (`src/app/themes/{name}.css`), and a
`ThemePicker` in Config's Appearance section. **This is real, working,
running infrastructure today** — not a green-field theme system. The gap
isn't "build theming," it's "the 3 existing themes (radar/editorial/
terminal) restyle the CURRENT single-dashboard IA; the owner now wants the
3 NEW concepts as themes too, layered onto a genuinely NEW multi-page IA."

**`product-review-followups` Area E** (design-discussion.md §1E, deferred
"sequence last," apparently never fully delivered despite being marked
shipped under a broader area label) already recorded the exact ask:
row-by-row detail browsing, first-class pipeline views (gigs-to-apply /
applied / interviewing / archived), prep packets visible from WITHIN
applied/interviewing rows, and named "the command center and mdostal.com"
as prior art to check before finalizing IA. That's this epic.

**Legacy gig-radar** (`~/Code/gig-radar` on the hive, SSH-inspected this
session — structural files only, per this repo's own no-personal-data
discipline). "Command center" isn't a separate tool — the legacy
`dashboard.html` is a single h1'd SPA ("🛰️ Gig Radar — dashboard"), so
that's almost certainly the informal name. Two real, richer patterns worth
porting the SHAPE of (never the owner's actual personal content, which
stays off this machine and out of this repo):
  - **Interview-prep doc structure** (`interviews/*.md`) is 7 real
    sections, materially richer than gigradar's current `PrepPacketContent`:
    Snapshot, Your fit (requirement→proof map), Likely questions→answers,
    Questions YOU ask, Rate & structure, Red flags to probe, One-line
    positioning to open with. A `.status.json` sidecar tracks a simple
    `{id, state, engine, finishedAt}` lifecycle.
  - **Per-platform "answer key"** (`application-answer-keys.md`) —
    universal-fields table + per-platform sections, explicitly grounded
    ONLY in the owner's own verified source docs, "no fabrication,"
    "never submit — [owner] reviews," a "STAGED FOR REVIEW" gate before
    anything is ever filled live, with named guardrails (claims never to
    make, figures never to guess). This is the SAME posture
    `graduated-auto-fire-trust`'s trust/approval spec already establishes
    for gigradar's own submit path — this epic's Materials feature reuses
    that posture, not a new one.

**mdostal.com Career CRM** (already fully captured in `career-crm`'s own
`extraction-reference.md` — no re-extraction needed). Real IA worth
learning from: a Dashboard hub (3 AI quick-actions + pipeline-by-stage
summary + weekly-checklist progress), a scoped AI Assistant chat, a
48-item 4-week Weekly Checklist, a Job-Applications list+detail-page
pattern, Strategy Docs, Message Templates, and platform-specific prep
trackers (Toptal's named explicitly — 4-stage funnel with real pass
rates). That doc already flags the real overlaps worth resolving here
(its pipeline vs. `gigs.status`, its AI actions vs. `generateDraft()`,
its templates vs. `ApplyProfileConfig`/draft content) — this epic is where
those get resolved, not re-discovered.

**Current gigradar reality, confirmed by direct inspection**: prep packets
today are one `<details><summary>Full prep packet</summary>` inside a
dashboard row's detail panel — exactly the owner's complaint ("that is a
page in itself, not just a fucking line item"). Zero metrics/analytics
code exists anywhere in `src/lib` or `src/app` — the "weekly metrics
overview... daily throughput" success criterion has been in this
project's OWN founding `project-profile.yaml` since scaffold and has never
been built. Routes today: `/`, `/[group]`, `/config`, `/chat`, `/drafts`,
`/issues`, `/profile-assist`, `/setup` — no `/today`, no `/metrics`, no
per-gig page, no `/interview`.

## 2. Information architecture (owner's synthesis, restated as a real IA)

Four real surfaces, not one redesigned dashboard:

1. **Signal Deck — the main/default page (`/`)**. The "long list" — full
   pipeline, dense, mission-control table, for when there's time to work
   through it properly. This is `ui-overhaul-via-ui-squads`'s Concept A,
   built out as the real `dashboard-client.tsx` replacement.
2. **Daily Shortlist (`/today`)** — the fast daily check-in. Today's
   picks only (green + new, freshly seen), the thing that "keeps us
   moving day to day, getting on it quickly." Concept C's IA.
3. **Metrics (`/metrics`)** — applied/failed/all counts, daily run rate,
   graphs, some real customization. The founding success criterion,
   finally built. New backend rollups needed — nothing to port from
   Concept A/B/C directly (none of the 3 concepts were briefed on this;
   it needs its own design pass, informed by mdostal.com's pipeline-
   summary tile pattern and the legacy tool's own status-history data).
4. **Interview workspace (`/gigs/[key]/interview`, or similar)** — once a
   gig's status is `interview`, it stops being a table row and becomes
   its own page: the full prep packet (already backend-ready via
   `generatePrepPacket()`, just needs this real surface instead of a
   `<details>` tag), a Materials/answer-key section (new — grounded ONLY
   in the owner's real `Profile`/`ApplyProfileConfig`/resume data, never
   fabricated, staged-for-review posture matching `graduated-auto-fire-
   trust`), and the "fire off a full prep packet" action promoted to a
   real primary action on this page.

**Theming**: Concept A (Signal Deck) and Concept C (Daily Shortlist)
become the real page designs for #1 and #2 above — not just themes, real
IA. Concept B (Signal Desk / calm ops) becomes a genuinely new SELECTABLE
theme, extending the EXISTING `Config.uiTheme` architecture (adding to,
not replacing, radar/editorial/terminal — "all 3 now" was the owner's own
prior call on that system, and this repo already carries the "3× the
maintenance surface" tradeoff by design). Open question below on exactly
how far theme-swapping should reach into the two new richer pages
(Metrics, Interview) versus those staying single-look.

## 3. Proposed story breakdown (draft — final sequencing after the owner confirms scope)

1. `signal-deck-main-dashboard` — real `dashboard-client.tsx` replacement using Concept A's verified, bug-fixed HTML as the visual/IA spec.
2. `daily-shortlist-page` — new `/today` route using Concept C's IA.
3. `metrics-page` — new `/metrics` route + backend rollups (applied/failed/run-rate/graphs), informed by mdostal.com's pipeline-tile pattern.
4. `interview-workspace-page` — new `/gigs/[key]/interview` route, real prep-packet surface (promotes existing `generatePrepPacket()`), new Materials/answer-key feature (staged-for-review, zero fabrication).
5. `signal-desk-theme` — Concept B as a 4th selectable `Config.uiTheme` option, extending the existing architecture.

## 4. Resolved (owner, this session)

1. **Signal Deck (mission-control) becomes the new DEFAULT theme**, not
   just the main page's fixed IA — its interaction patterns (inline
   row-expand instead of navigation, radial signal-meter iconography
   instead of a plain tier dot, the scanner-sweep motif) become part of
   the real, structural `dashboard-client.tsx` rewrite (Story 1), used
   regardless of which theme skin is active. Signal Deck's specific
   dark-console palette/type/animation then ships as a NEW theme option
   (additive — `Config.uiTheme` gains a `"signal-deck"` member, default
   changes from `"radar"` to `"signal-deck"`; the existing `radar`/
   `editorial`/`terminal` themes are kept, not deleted, per
   `ui-theme-system`'s own "additive, clean revert" precedent).
2. **Signal Desk (calm ops) becomes a 5th selectable theme** (from the
   first round of answers, not retracted by the Deck/Desk correction) —
   a genuinely new, separate `Config.uiTheme` option alongside radar/
   editorial/terminal/signal-deck.
3. **Metrics and Interview get their own single, dedicated layout** — not
   reskinned per-theme like Dashboard/Config/Issues are — but they DO
   consume the same theme color tokens (not a hardcoded separate
   palette), so whichever theme is active still tints them consistently.
   This is free — the existing token architecture already works this way
   for any new page that uses the shared CSS custom properties instead of
   literal colors.
4. **Ship Signal Deck (main dashboard + new default theme) first**, as
   its own complete, shippable slice — then sequence Daily Shortlist,
   Metrics, Interview workspace, and the Signal Desk theme addition after,
   each its own PR. Daily Shortlist and Signal Deck ship "as is" — the
   already-verified concepts, not redesigned further before landing.
