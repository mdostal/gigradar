# Design discussion: consistent-gig-detail-access

## 0. Trigger

Owner, 2026-09-07, from a real screenshot of the Today page's "Today's
Picks" section: "and how do we get to the actual listing? from today --
i get a generate draft and analyze -- i see analyze did something which
is good, but wtf, where is the link, where is the extension, where is
seeing it? a modal, SOMETHING! -- do planning and executions on this and
a FULL DESIGN."

## 1. Real inventory (evidence-based, not assumed)

| Surface | External link | Detail view |
|---|---|---|
| `dashboard-client.tsx` (`/gigs` table) | Yes -- title link via `useOpenExternalLink()` | Yes -- `<GigDetailPanel>` opens on row click |
| `today/today-client.tsx` -- Today's Picks cards | **No** | **No** |
| `today/today-client.tsx` -- Full Roster rows | Not yet independently confirmed, same file/gap presumed | **No** |
| `drafts/drafts-client.tsx` | Yes (shipped earlier today) | No `GigDetailPanel` -- shows full draft content inline instead, which is the correct design for THAT page (a draft already needs to show its own generated content in full) |
| `gigs/[key]/interview/interview-workspace-client.tsx` | Yes | N/A -- already a full-page detail view |

**The real gap is narrow and specific**: only Today's Picks and Full
Roster have neither affordance. Every other real gig-card surface in the
app already has at least the external link, and the Dashboard already has
the full pattern (link + modal).

## 2. `GigDetailPanel` is already the app's real, reusable modal -- confirmed, not assumed

Read in full: `src/app/gig-detail-panel.tsx` is a real `fixed inset-0 z-20`
overlay (`role="dialog" aria-modal="true"`, backdrop-click-to-dismiss) --
this **is** the app's one and only existing modal pattern (grep for
`role="dialog"`/`fixed inset-0` across `src/app` returns only this file).
It already has `useOpenExternalLink()` and the profile-assist deep link
wired inside it. Its only real usage site in the entire app today is
`dashboard-client.tsx:1451` -- zero other call sites exist, despite being
generically reusable (its props: `gig: StoredGig`, `position`,
`onClose`/`onPrev`/`onNext`/`canPrev`/`canNext`, `groupId`, plus three
caller-injected render-prop slots for status-change/draft/prep actions,
letting each caller supply its own action UI while the panel owns the
shared shell/chrome/external-link/apply-assist plumbing).

**Real, load-bearing finding**: `today-client.tsx` already receives
`gigs: StoredGig[]` -- the exact same full type `dashboard-client.tsx`
already passes into `GigDetailPanel`. Wiring the panel into Today's page
needs **zero new data plumbing** -- it is purely a matter of mounting the
same component the same way `dashboard-client.tsx` already does.

## 3. The design decision

Rather than inventing a new detail surface, a new modal, or a bespoke
Today-specific solution: **mount the EXISTING `GigDetailPanel` in
`today-client.tsx`**, following the exact same pattern already proven in
`dashboard-client.tsx` (a `selectedGigKey` state, a click handler on the
card/row, and the panel rendered conditionally with `onClose`/`onPrev`/
`onNext` wired to the current filtered/sorted list). This is the "real,
consistent pattern" the owner asked for -- not a new one invented for this
story, but the one that ALREADY exists elsewhere in the app, finally
applied consistently.

The `statusChangeSection`/`draftSection`/`prepSection` render-prop slots
should reuse Today's own existing action logic (its own "Generate draft"/
"Analyze" buttons and `prepByKey` state, already fixed to render correctly
on the Picks card earlier today) rather than `dashboard-client.tsx`'s own
separate `renderDraftSection()`/`renderPrepSection()` helpers, which may
have different data wiring specific to that page. A real implementation
decision for whoever builds this: reuse Today's own action components
inside the panel's slots, don't duplicate dashboard's.

## 4. Scope

One real, well-scoped story: wire `GigDetailPanel` into `today-client.tsx`
for both Today's Picks cards and Full Roster rows (clicking a card/row
title opens the same shared modal Dashboard already uses), each card ALSO
keeping a direct external-link affordance on the title itself (matching
Dashboard's own "both a title link AND a View→ style entry into the
modal" pattern, or whatever the implementer finds cleanest given Today's
own existing card layout) so a user never has to open the modal just to
reach the real posting.

Out of scope for this story (real, but separate): Full Roster's own
row-level behavior should be independently confirmed (not assumed
identical to Picks) as part of implementation, not pre-decided here.
