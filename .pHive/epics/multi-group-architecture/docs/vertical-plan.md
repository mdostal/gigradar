# Vertical Plan: Multi-Group Architecture

Minimum cross-stack increments — each slice leaves gigradar in a genuinely working, live-verifiable state. Sequenced so the owner can start actually using a second group as early as Slice 2, well before the full dashboard UI lands.

## Slice 1 — Data model + migration + matching pipeline (foundation, invisible to the user)

**What ships**: `Config.groups[]`, `matched_group_ids` on every gig, group-aware `runRadar()` matching, config migrate-on-read. No UI changes at all — a not-yet-multi-group install (i.e. the owner, until Slice 2) looks and behaves identically to today.

**Working state at the end of this slice**: the real scheduler (already running) picks up the migrated single implicit group, re-evaluates gigs against it on the next real scan cycle, and `matched_group_ids` starts populating on real data — live-verifiable directly against the real 1674-gig database, the same way every other change this session has been verified.

**Why first**: everything else in this epic depends on this layer; nothing here is user-visible or risky to the owner's daily use, so it can be verified thoroughly against real data before any UI work begins.

## Slice 2 — Config UI: real group management

**What ships**: the group picker + per-group Needs/RoleArea editing in `/config`, add/rename/remove a group, per-source `groupIds` scope control.

**Working state at the end of this slice**: the owner can create a real second group (e.g. "Drone Stuff") with its own rate/hours criteria and title keywords, and — even before Slice 3's dashboard work lands — the matching pipeline (Slice 1) is already evaluating every scan against it. This is the first point where the owner's actual multi-specialist use case (software engineer / fractional CTO / drone photographer, evaluated independently, sharing the same underlying gig pool) is real and working, just not yet visually separated in the dashboard.

## Slice 3 — Dashboard UI: `/[group]/` routing and per-group views

**What ships**: the `/[group]/` dynamic route, nav group switcher, group-scoped gig lists. A gig matching multiple groups appears in each one's dashboard — same row, same key, same status.

**Working state at the end of this slice**: the full experience the owner asked for — genuinely separate dashboards per specialty, sharing one gig pool and one "apply once" status per gig.

## Slice 4 — MCP server group support

**What ships**: optional `groupId` filter on `list_gigs`/`get_status_summary`.

**Working state at the end of this slice**: MCP tool consumers can scope queries to one group the same way the dashboard now does. Independently shippable any time after Slice 1 — sequenced last only because it's the lowest-value/lowest-risk piece, not because it depends on Slices 2/3.

## Sequencing notes

- Slices 2 and 3 are independent of each other (per the horizontal plan's dependency graph) and could in principle ship in either order or in parallel — sequenced 2-before-3 here because Slice 2 alone already delivers real value (a second group actually working, matching real gigs) before the larger dashboard UI investment.
- Each slice gets its own PR(s) into `dev`, verify-then-merge per standing process — this is NOT one giant PR at the end.
- Slice 1 is the only one that touches the real production database directly; Slices 2-4 are additive UI/API surface over data Slice 1 already produces.
