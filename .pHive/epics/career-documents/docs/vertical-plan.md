# Vertical Plan: career-documents

Slices 1→2 and 1→4 are dependency chains (mechanism before consumers);
Slice 3 (links) is independent and can ship in parallel with 2/4.

## Slice 1: resume-store (foundation)

`src/lib/documents/resume-store.ts`: `saveResume()`/`loadResume()`/
`deleteResume()`, mirroring `session-capture.ts`'s
`writeStorageStateAtomically()` exactly (atomic temp-file+rename, mode
0600, `encrypt()`-at-rest via the shared vault key). `ApplyProfileConfigSchema`
gains `resumePath?: string`. No UI/upload wiring yet.

**Working state after this slice:** the mechanism exists and is unit-
tested (real encrypt/decrypt round-trip against a temp data dir), not
yet reachable from any upload flow.

## Slice 2: persist-on-upload + /config UI

Extends `extractProfileFromResumeAction` to also call
`saveResume()`/`saveConfig({applyProfile: {...resumePath}})` when a
resume is uploaded. Adds a "Resume" section to `/config` showing whether
one is on file, with a "Remove" action. A user's very next resume upload
is now durable across sessions, not re-required every time.

**Working state after this slice:** upload once, gigradar remembers it.

## Slice 3: persisted links

`ApplyProfileConfig.links?: string[]` + a list editor in `/config`
(reuses the existing `StringListEditor` component). `buildApplicantDataBlock()`
(`draft.ts`) renders `applyProfile.links` when present — the ONE shared
data-block builder every LLM call site (`generateDraft`,
`generatePrepPacket`) already goes through, so this single change is
what makes it real "across the board."

**Working state after this slice:** a user's portfolio/GitHub/personal
site links show up in every draft and prep packet gigradar generates.

## Slice 4: real parseability check (the unlock)

Exports `buildResumeContentBlock()` from `extract.ts` (was module-
private). `generatePrepPacket()` embeds the persisted resume (when
`applyProfile.resumePath` is set) as a native PDF content block in its
existing single call, asking Claude to assess REAL format/parseability
issues against the actual file. `AtsScore` gains `parseabilityIssues:
string[]` — empty/omitted gracefully when no resume is on file yet.

**Working state after this slice:** ats-navigator's originally-deferred
parseability half is real, grounded in an actual resume, not fabricated.

## Explicitly deferred (not this epic, tracked as follow-ups)

- **Multiple/versioned resumes** — design-discussion.md §3 open question 1.
- **Periodic link validation/dead-link detection** — §3 open question 2.
