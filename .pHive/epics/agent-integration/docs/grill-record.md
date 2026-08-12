# Grill Record — agent-integration

**Source draft:** .pHive/epics/agent-integration/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 3

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: clean

## Vocabulary mismatches

No findings. "Tool," "Source," "Gig," and "Config" are used consistently
with CONTEXT.md's definitions and standard MCP terminology, with no
mid-document meaning shift.

## Hidden assumptions

- **H1** — §3 step 2's `update_gig_status` tool wraps `setStatus(key,
  status: GigStatus, ...)` directly, but `GigStatus` is a TypeScript
  compile-time type — confirmed by direct code read, `setStatus()` itself
  performs no runtime validation of the `status` value. TS types are
  erased at runtime; once a value crosses an MCP tool-call boundary
  (external JSON input from whatever agent is connected), nothing stops
  an arbitrary string from being written straight into the DB unless the
  MCP tool's OWN input schema restricts it to the real enum values. This
  is the exact same gap already flagged elsewhere in this codebase
  (`updateGigStatusAction` in the Next.js Server Action layer accepts any
  string with no runtime enum check) — the draft doesn't address whether
  this MCP tool inherits that same gap or closes it, and arguably the risk
  is HIGHER here: an LLM-driven agent is more likely to pass a
  slightly-wrong status string (e.g. "in-progress" instead of "interview")
  than a UI dropdown ever would.
  - Draft location: §3 step 2 (`update_gig_status({key, status})`)
  - Why this matters: silent data corruption in the gig's tracked status
    — the exact kind of bug this project has been careful to avoid
    elsewhere (e.g. `saveConfig()`'s validate-before-write discipline).
  - Question for planner: should this tool's input schema (the MCP SDK's
    own JSON-schema-based tool definition) enforce the real `GigStatus`
    enum values, rejecting anything else BEFORE `setStatus()` is ever
    called — independent of whether the pre-existing Server Action gap
    (tracked separately, task #40) ever gets fixed?

- **H2** — §3 step 2's `get_status_summary` tool plans to reuse "the SAME
  computation `src/app/status-strip.ts` already does," which would mean
  `src/mcp/` importing from `src/app/` — an unusual, sideways dependency
  between two separate "client of src/lib" layers (verified by direct
  read: `status-strip.ts` is genuinely framework-free pure TS, so the
  import wouldn't break technically, but the draft never states this
  layering decision explicitly or considers the alternative of moving the
  shared computation somewhere both layers can import cleanly).
  - Draft location: §3 step 2 (`get_status_summary`)
  - Why this matters: an unexamined `src/mcp` → `src/app` import
    direction is a precedent-setting architecture choice for this
    project's very first non-`src/lib`/`src/app` layer — worth a
    deliberate decision, not an implicit one.
  - Question for planner: keep the sideways import (bless it explicitly,
    since it's provably framework-free), or move `computeStatusStrip()`
    and its helpers into `src/lib` so both `src/app` and `src/mcp` import
    from the same neutral location or the `src/mcp -> src/app` import ever happens at all?

## Unresolved tensions

- **U1** — The epic's own §0 north star states the owner wants to "actually
  use a running instance as a tool" — implying HIS OWN Claude Desktop/Code
  setup should end up genuinely connected, not just capable of connecting.
  But §1's "Done" bar only commits to "a user CAN point Claude Desktop... at
  `npm run mcp`" — the epic ships the mechanism but not a one-step,
  copy-pasteable MCP client config example (e.g. the exact JSON snippet
  for Claude Desktop's `claude_desktop_config.json`, or Claude Code's
  `.mcp.json`). This is the same shape of gap this session's grill process
  already caught once before (`profile-overview-ingestion`'s U1 — a
  feature whose own "done" bar wasn't actually met by what was in scope)
  — worth checking deliberately rather than repeating it.
  - Draft location: §0 (north star: "actually use a running instance"),
    §1 ("Done": "a user CAN point... at `npm run mcp`")
  - Tension: "the owner wants to actually use this" vs. "the epic ships a
    mechanism the owner still has to manually wire up themselves, with no
    shipped example of exactly how."
  - Question for planner: should this epic include a documented,
    copy-pasteable MCP client config snippet (in `CLAUDE.md`, a README
    section, or a small `docs/mcp-setup.md`) as part of its own "Done" bar,
    so the owner's own Claude Desktop/Code is genuinely one copy-paste away
    from working, not just theoretically capable?

## Convention violations

No findings. The design's secret-handling approach (never `loadConfig()`
outside `run_scan`), test-isolation pattern (XDG env var overrides), and
dependency choice all match this project's established conventions.

## Posture mismatches

No findings. Stdio-only, no network binding, single-user local posture —
consistent with every prior epic's stated trust boundary.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
