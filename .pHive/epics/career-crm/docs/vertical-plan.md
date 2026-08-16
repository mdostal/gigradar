# Vertical plan: career-crm

Two independently-shippable slices.

## Slice 1 — Prep-packet generation mechanism + storage

`src/lib/store/prep.ts` (new, mirrors `drafts.ts` exactly): `saveInterviewPrep()`/
`getInterviewPrep()`/`listInterviewPrep()`, one row per gig keyed by
`gig_key`, insert-or-replace on regeneration. `interview_prep` table
added to `schema.ts` (mirrors `application_drafts`'s shape).

`src/lib/apply/prep.ts` (new): `generatePrepPacket(gig, profile, applyProfile,
apiKey): Promise<PrepPacketContent>` — ONE forced-tool-use Anthropic call,
BEGIN/END-delimited (`Gig.description` is the untrusted DATA), returning
`{score, rationale, topStrengths, keyGaps, recommendation,
predictedQuestions, starlaStories}`. Reuses `profile-suggest.ts`'s exact
BYOK-apiKey-as-parameter discipline.

## Slice 2 — Server Action + dashboard UI surface

`generatePrepPacketAction(gigKey)` (`src/app/actions.ts`, mirrors the
existing "Generate draft" action's shape exactly) — resolves the gig +
profile + BYOK key, calls `generatePrepPacket()`, persists via
`saveInterviewPrep()`, `revalidatePath("/")`.

Dashboard UI (`src/app/dashboard-client.tsx` or a new per-gig detail
surface, matching whatever the existing "Generate draft" button's own
placement convention is): a "Generate prep packet" button per gig, and a
display of the persisted content (score/rationale/strengths/gaps/
questions/stories) once generated.

## Explicitly deferred (design-discussion.md §2 — not silently dropped)

Weekly checklist, message-template library, strategy-doc library, and the
richer 12-step status pipeline (`PROCESS_STEPS`/`NEXT_ACTION_MAP`) from
the original Career CRM. Real, valuable, but a separate, larger scope —
needs its own owner-prioritization pass before being planned as a
follow-on epic.
