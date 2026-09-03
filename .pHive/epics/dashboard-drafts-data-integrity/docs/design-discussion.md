# dashboard-drafts-data-integrity: design discussion

## 0. Why this epic exists — a real requirement-loss incident

The `gigradar-command-center` epic's own design-discussion.md (§ "Four real
surfaces, not one redesigned dashboard") specified the owner's synthesized
Signal Deck concept as the spec for `signal-deck-main-dashboard`. What
shipped (PR #110/current `/` route, `dashboard-client.tsx`) built the
giglist/filter/table portion of that concept faithfully, but **dropped the
concept's own topbar entirely** — the live sonar-sweep scope icon, the
Sources/Profile/Last-sweep instrument readout, and the "Sweep now" button.
That topbar is what the owner has been calling "the sonar dish" since. No
story, PR, or memory record ever captured this as a separate deliverable —
it silently fell out between "here's the concept" and "here's what shipped."
Owner's own words, 2026-09-03, on rediscovering this:

> "how do we fucking go through these discussions and then not fucking do
> them?!"

This epic exists to (1) actually build what the Signal Deck concept already
specified and (2) fix a second, separate confusion the owner flagged live —
`/` is labeled "Dashboard" but is really the giglist; the real
metrics/charts page lives at a separate, easy-to-miss `/metrics` nav item —
plus two real data-integrity bugs found live in the same conversation:
drafts showing zero gig context (rate/tier/company) and status
reconciliation covering only 2 of ~13 sources.

Process note for next time: this gap is exactly why `/plan` writes real
story YAMLs with acceptance criteria instead of leaving a concept as a
published Artifact link alone — an Artifact is not itself a tracked
deliverable in this repo's process.

## 1. Recovered spec: the sonar-sweep header ("sonar dish")

Source of truth: Artifact `730c378b-c24c-4ab0-840e-a56185854145`
("Gigradar // Signal Deck"), read in full this session. Exact, verified
markup/behavior (not a description from the screenshot):

- A 52×52 SVG "scope" icon: three concentric static circles + a crosshair
  (dim grid-line stroke `#1c2c25`), sitting to the left of the "Gigradar //
  Signal Deck" wordmark in the topbar.
- A `.sweep` `<g>` — a wedge (`path` with a radial gradient fading from
  `--accent` at 55% opacity to transparent) rotating continuously:
  `animation: spin 4s linear infinite` (`@keyframes spin { to { transform:
  rotate(360deg) } }`), origin at the icon's center. Respects
  `prefers-reduced-motion` (animation off, static wedge left visible).
- 3 pulsing "blip" dots (`.blip`, `@keyframes blip` fading opacity
  `.15 → 1 → .15` over 2.6s ease-in-out, staggered `.9s`/`1.7s` delays via
  `.b2`/`.b3`) at fixed positions on the scope face — green/green/yellow in
  the concept, i.e. tier-colored.
- An "instruments" cluster to the right of the wordmark: **Sources** ("N
  configured (M needs attention)", warn-colored when M>0), **Profile**
  ("Complete"/incomplete state), **Last sweep** (relative time, ticking
  live every 15s off a real timestamp — "12m ago" style, matching
  `formatDate`-style helpers already used elsewhere in this codebase e.g.
  drafts-client.tsx), and a **"Sweep now"** button (small icon + label).
- Clicking "Sweep now" in the concept: shows a toast ("Sweep complete — no
  new signals since last pass" in the mock; the real build triggers an
  actual scan/reconciliation run, see §3), and briefly speeds the sweep
  animation up (`animationDuration` to `0.5s` for ~1.2s, then back to
  `4s`) as a completion cue.

This is a **real-time "is it working" visual**, not decoration — the
owner's own framing. The rotating sweep + pulsing blips signal "gigradar is
alive and scanning" at a glance, exactly the ambient status surface a
background-running local app needs.

## 2. Recovered spec: the real Dashboard (owner's own words, verbatim)

> "keep FULL metrics separate. Make dashboard an overview with a small
> metric component and allow us to customize what shows. Have it do a
> small top 5 for today or a checkmark if all of today is finished/covered
> -- similar, a component view in -- then a view into all gigs and just
> some general metrics and charts ON all gigs and whats been happening --
> maybe the ready to act etc and then go to gigs -- dashboard is a human
> readable dashboard that forwards you along and gives you a look at a
> glance of progress and where we are so we can dig in"

Resolved IA (three distinct surfaces, not two):

1. **`/metrics` — stays exactly as-is.** The full applied/failed/run-rate
   deep-dive with bar-chart graphs (`metrics-client.tsx`). Not touched by
   this epic except as a link target from the new Dashboard.
2. **`/` — becomes the real Dashboard**, replacing today's giglist as the
   landing page. Composition (glance-level, not a full data page):
   - The sonar-sweep header from §1, always present — this IS the
     dashboard's status surface, not a separate widget bolted elsewhere.
   - The 4 Signal-Deck stat tiles that already exist in the recovered
     concept (Ready to act, New signals, In play, Tracked total) —
     these were part of the SAME concept HTML and are cheap to build now
     alongside the header, but keep the tile SET user-customizable
     (owner's explicit ask: "allow us to customize what shows") — a
     picker/toggle over a fixed small library of tile types, not a fixed
     4-tile layout.
   - A "Today" component: either a small top-5-for-today list (newest
     green/yellow matches surfaced today) or, when there's nothing new
     today, a plain checkmark/"today's scan is fully covered" state —
     owner explicitly offered both as acceptable, this epic picks
     whichever is simpler to build well rather than building both, and
     should default to whichever the story's own implementer judges
     clearer once the real data shape is in front of them (flag as an
     open call in the story, not pre-decided here).
   - A compact "general metrics and charts on all gigs" component —
     e.g. one small sparkline/bar summary reusing `metrics-data.ts`'s
     existing aggregation rather than a new computation path — with a
     "See full metrics →" link to `/metrics`.
   - A link/CTA into the full giglist (see next point).
3. **Today's `/` giglist (dashboard-client.tsx, the filter/table UI)
   moves to a new route** — a real "All Gigs" page, distinct from the new
   Dashboard. Reuses the existing component near-verbatim; this is a
   rename/relocate, not a rewrite. Update `nav-header.tsx` accordingly:
   Dashboard (new `/`) · All Gigs (relocated) · Drafts · Metrics · ... .
   `/[group]/page.tsx` (multi-group per-group view) mirrors the same
   split for its own scope.

## 3. Drafts disconnected from gig context — confirmed, reproduced live

`src/app/drafts/page.tsx` calls `getGig(draft.gigKey)` — which returns the
FULL `Gig` record, including `rate: {min, max, unit}` and `tier` — but only
forwards `{title, company, url}` into `DraftListItem`. Verified via full
read of both `drafts/page.tsx` and `drafts-filter.ts`: zero references to
rate/compensation/tier anywhere in the drafts UI (`drafts-client.tsx`).
Reproduced live against the owner's real `gigs.db` (read-only query): the
`builtin` source alone has 120+ near-duplicate "Software Engineer II/III"
postings (the JPMorgan-Chase-style listings the owner flagged), most
missing rate data entirely, several with inconsistent tier for what look
like near-identical reqs. Compounding effect: approving/rejecting 6 drafts
against employers this similar is currently a blind guess.

Fix: thread `rate`, `tier`, and `source_id` through `DraftListItem` (they
already exist on `Gig`, this is plumbing, not new data collection) and
surface them on each `DraftCard` — company, rate/TC, tier badge, source —
visible in the card header, not hidden behind "approved" state the way the
gig URL currently is.

## 4. Status reconciliation covers 2 of ~13 sources — confirmed via code search

Only `src/lib/sources/wellfound-status.ts` and
`src/lib/sources/gofractional-status.ts` implement `reconcile*Statuses()`.
`ateam.ts`, `braintrust.ts`, `fractionalfinders.ts`, `fractionaljobs.ts`,
`fractionus.ts`, `linkedin.ts`, `gmail-digest-source.ts`,
`custom-llm-source.ts`, `custom-source-recipe.ts` have none — an
application made directly on any of those platforms never syncs back to
gigradar, which is the likely real explanation for "I'm sure I applied to
some of these already." Building real reconciliation for every remaining
source in one epic is out of scope here (each source's own DOM/auth shape
is a real, separate research spike per the pattern `gofractional-status.ts`
and `wellfound-status.ts` already establish — that's why only 2 exist after
2 prior dedicated stories). This epic instead closes the immediate gap with
a manual, always-available escape hatch: a "Mark as applied elsewhere" bulk
action from the giglist/drafts views, so untracked-source applications stop
silently masquerading as unapplied duplicates regardless of which source
they came from. Real per-source reconciliation for the highest-value
missing sources (probably `linkedin.ts` and `ateam.ts`, given today's
JPMorgan-Chase example) is flagged as a real, separate follow-on epic, not
silently dropped again — tracked explicitly in this doc so it doesn't
repeat §0's mistake.

## 5. What stays out of scope

- Full per-source reconciliation build-out (§4) — flagged as a follow-on
  epic, not attempted here.
- Any change to `/metrics` itself — stays as shipped.
- Dedup/similarity detection for near-identical postings (the 120+
  builtin-source near-duplicates) — a real, separate data-quality problem
  one layer below this epic's UI-surfacing fix; flagged, not solved here.
- Any new LLM/AI-driven duplicate detection — out of scope, would need its
  own design pass.

## 6. Design process discipline for this epic

Owner's explicit, standing correction this session: "quit using default
claude shit, it produces trash results." The Dashboard and sonar-header
stories in this epic are **not** free-design work — §1's spec is the
recovered, already-owner-approved Signal Deck concept (verbatim markup
above), and §2's composition is the owner's own verbatim direction. The
implementer's job is faithful reconstruction against real app data, not a
fresh creative pass. Where genuine choices remain (the customizable-tile
picker's exact UI, the top-5-vs-checkmark default), keep them small and
flag them in the story rather than inventing new visual language.
