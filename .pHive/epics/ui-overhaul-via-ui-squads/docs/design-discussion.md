# ui-overhaul-via-ui-squads — design discussion

Follow-on epic 5 of 4 (platform-aware drafting, embedded browser/focus,
deep memory, **UI overhaul**) scoped in
`deep-dive-audit-and-testing-framework`'s own design-discussion.md as: "A
genuinely separate visual/UX epic — dashboard, config, and chat surface
redesign, run through the owner's own parallel-independent-design-agent
pattern (N agents, one orthogonal creative direction each, real
render+screenshot verification, all N published for the owner's own
synthesis to become the spec — not an assistant pick)."

## Why this epic is structurally different from Epics 2-4

Epics 2-4 were scoped, implemented, tested, and merged end-to-end without
an owner gate in the middle, because each was a well-understood, low-risk
extension of an existing pattern. This epic is NOT that shape — the
owner's own playbook (captured verbatim in this session, see project
memory `feedback` on the N-parallel-blind-design-agents pattern) makes the
owner's synthesis the actual spec-authoring step, deliberately never an
assistant pick. There is no way to "finish" this epic without that human
step — this is the exact kind of decision the standing "keep iterating,
stopping only to ask necessary questions" instruction carves out for a
real pause, not a failure to iterate further.

## Scope for this pass

Redesigning dashboard + config + chat surfaces all at once in one pass
would violate the same "slices" discipline every other epic here has
followed, and would triple the design agents' own effort and the owner's
review burden in one sitting. **This pass scopes to the Dashboard only**
(`src/app/page.tsx` / `dashboard-client.tsx`) — the single most-trafficked
page, and the one the owner's own original complaint ("I click and
nothing happens... the green seems to have any position possible") was
about. Config and chat surfaces are real, separate follow-on slices once
the Dashboard's synthesis lands and a first real design system exists to
carry forward.

## Process (owner's own playbook, applied verbatim)

1. Real data shape and real sample data assembled from the actual
   `DashboardData`/`StoredGig`/`StatusStripView` types (`dashboard-data.ts`,
   `store/types.ts`, `status/status-strip.ts`) — never lorem ipsum.
2. 3 parallel, genuinely independent `Agent` calls (not `fork` — a fork
   inherits this session's own context/bias, defeating the point of
   getting distinct takes), each given the SAME structural brief + real
   sample data, and a DIFFERENT one-line creative direction:
   - **Mission-control / signal-radar** — leans into the product's own
     name; a monitoring/scanning aesthetic.
   - **Calm operations dashboard** — a clean, boring-in-a-good-way SaaS
     analytics surface; optimized for fast daily scanning, not delight.
   - **Curated shortlist / editorial** — feels like a personally-curated
     short list of real opportunities, warmer and less clinical than a
     typical dashboard.
3. Each agent loads the `artifact-design` skill and produces ONE
   self-contained HTML file to the scratchpad — no shared code, no seeing
   each other's output.
4. Before showing the owner anything: each file is actually rendered
   (local HTTP server, screenshotted) and checked for real bugs (overflow,
   truncation, broken interactions) — trust-but-verify on the agents' own
   self-reports, exactly like the earlier UI-decision precedent this
   playbook comes from.
5. All 3 published as Artifacts, presented unfiltered, no assistant
   pre-selection or "here's my favorite."
6. The owner's synthesis — not a pick of A/B/C, an actual synthesis of
   specific elements across all 3 — becomes the real spec for the next
   implementation pass. That next pass (turning the synthesis into a real
   `dashboard-client.tsx` implementation) is deliberately NOT started in
   this pass — it depends on input only the owner can provide.

## Outcome of this pass (2026-09-02)

All 3 concepts built, rendered, and verified. Two REAL bugs found and
fixed directly (not left for the owner to trip over) before publishing:

- **Concept A (Signal Deck / mission-control)**: the table's header row and
  every data row were missing `display:grid` on the actual grid container
  element (only a non-participating wrapper div had the grid declaration)
  — the whole table rendered as a collapsed vertical stack instead of
  aligned columns. Fixed by moving the grid declaration onto `.thead` and
  `.row` directly.
- **Concept B (Signal Desk / calm ops)**: `.table-wrap { overflow-x: auto }`
  with no `overflow-y` triggers a real CSS spec quirk — an unset
  `overflow-y` computes to `auto` too whenever `overflow-x` isn't
  `visible`, silently creating an unintended vertical scroll container.
  Attempted fix (explicit `overflow-y: visible`, which the spec still
  forces to `auto` when paired with `overflow-x: auto`) did not resolve a
  visual artifact observed in headless-browser screenshots (a partial
  duplicate row rendering above the sticky header). Extensive DOM
  verification (`getBoundingClientRect`, `elementFromPoint`, disabling
  `position: sticky` entirely) proved the actual layout geometry is
  correct with zero element duplication — this looks like a headless
  Chrome screenshot-compositing artifact specific to this session's
  testing tool, not a real bug reaching an actual browser. Flagged here
  for the record in case it turns out to reproduce in a real browser too.
- **Concept C (The Daily Shortlist / curated editorial)**: no bugs found —
  clean render top to bottom.

Published as Artifacts:
- Concept A: https://claude.ai/code/artifact/730c378b-c24c-4ab0-840e-a56185854145
- Concept B: https://claude.ai/code/artifact/faf01b62-a21e-4fce-991b-334c514984c8
- Concept C: https://claude.ai/code/artifact/966edc31-0aa8-4ed8-b068-febfee5ad5a0

**This epic is now paused, waiting on the owner's synthesis** — the actual
spec-authoring step this whole process exists to produce. The next pass
(a `synthesize-dashboard-redesign` story, not yet created) turns that
synthesis into a real `dashboard-client.tsx` implementation once it
lands.
