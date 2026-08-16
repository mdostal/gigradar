# Design Discussion: career-documents

## 0. Prelude

Owner's exact words (this session, immediately after ats-navigator's
`ats-resume-score` slice shipped with its keyword-overlap-only scope,
explicitly deferring a real resume-format check for lack of any
persisted resume data): "yeah, it needs a resume and we need to have a
way to maintain lists, links, profiles, etc so that it can pull that
info and then tweak it across the board so that i can fetch all my stuff
into gig radar and then have it work with it."

This directly resolves `ats-navigator`'s design-discussion.md §5 open
question 4 ("should gigradar start persisting resume content/structure...
ephemeral-per-call or a new persistent field?") — the owner's answer is:
persistent, and generalize it to a real small "career documents" store
(resume + links) multiple features read from, not a one-off field bolted
onto one story.

## 1. Real research (grounded, not a guess)

Before designing anything, confirmed the exact current state of resume/
link handling:

- **Resume upload today is 100% ephemeral.** `extractProfileFromResumeAction`
  (`src/app/config/actions.ts`) reads an uploaded PDF into a `Buffer`,
  passes it to `extractProfile()` (`profile-ingestion/extract.ts`) for a
  single LLM call, and discards it — "neither the uploaded resume bytes
  nor the extracted result touch disk here" (that file's own doc
  comment). Only the resulting `roles`/`skills` ever reach `Profile`.
- **`extractProfile()` already sends a resume PDF NATIVELY to Claude** as
  a document content block (`buildResumeContentBlock()`, currently
  module-private) — never locally text-extracted. This is the exact
  mechanism a REAL parseability check needs to reuse once a resume is
  persisted: ask Claude to look at the actual file, not fabricate
  structure from thin air.
- **`links` is also ephemeral, input-only.** `ExtractProfileInput.links`
  is fetched once (`fetchAndExtractLink()`, SSRF/login-wall-guarded) to
  give the extraction call more context, then thrown away. There is no
  persisted `links: string[]` anywhere — `ApplyProfileConfig.linkedInUrl`
  is the only durable link field today.
- **The established "file on disk + path reference in config" pattern**
  already exists and is proven: `session-capture.ts`'s
  `writeStorageStateAtomically()` writes JSON through `vault.ts`'s
  `encrypt()` to `getDefaultDataDir()/{sourceId}-session.json` (atomic
  temp-file+rename, mode 0600), and only the resulting PATH is persisted
  into `config.json` via `saveConfig({sources})`
  (`withSessionStatePath()`). `vault.ts`'s `encrypt()`/`decrypt()` are
  string-in/string-out (JSON-envelope on disk) but NOT JSON-config-
  specific — session-state JSON already goes through this exact
  mechanism, confirming it's reusable for any sensitive file, not a
  config.json-only tool. A resume's raw bytes just need base64-wrapping
  into a JSON envelope first, same as any other payload.
- **`getOrCreateKey(hasAnyEncryptedFile)`** (`config/load.js`) is the
  shared "does an encrypted file exist yet, or do we need to mint a new
  key" check every encrypted-file writer already calls — reused as-is,
  not reimplemented.

## 2. Design decisions

### 2.1 Resume storage mechanism

New `src/lib/documents/resume-store.ts`: `saveResume(data: Buffer,
mediaType: string): {path: string}` / `loadResume(path): {data: Buffer,
mediaType: string} | undefined` / `deleteResume(path): void`. Mirrors
`writeStorageStateAtomically()` byte-for-byte: atomic temp-file+rename,
mode 0600, `encrypt()`-at-rest via the SAME vault key every other
encrypted file already uses. On-disk shape: `{mediaType, dataBase64}`
JSON, encrypted, written to `path.join(getDefaultDataDir(), "resume.enc")`
— one resume, not versioned in v1 (see Open Questions). `config.json`
(itself already encrypted end-to-end) stores only the returned path, in
a new `ApplyProfileConfig.resumePath?: string` field — same shape as
`SourceConfig.settings.sessionStatePath`.

### 2.2 Persisted links

`ApplyProfileConfig.links?: string[]` — a new, generalized field
alongside the existing `linkedInUrl` (kept unchanged, no migration/
breaking change). `buildApplicantDataBlock()` (`draft.ts`, already
shared by `generateDraft()` AND `generatePrepPacket()`) gains one new
line rendering `applyProfile.links` when present — ONE code change,
every consumer (draft generation, prep packets, and the new ats-score
work) automatically gains awareness of the user's other links. This is
the literal "tweak it across the board" the owner asked for: a single
shared data-block builder, not N separate wire-ups.

### 2.3 Persist-on-upload, not a separate step

The existing resume-upload flow (`extractProfileFromResumeAction`) is
extended, not duplicated: uploading a resume for extraction ALSO
persists it via `resume-store.ts` and writes `applyProfile.resumePath`
via the existing `saveConfig()` path — "fetch your stuff into gigradar"
IS the act of uploading, not a second explicit save button. A separate
"Remove resume" action clears both the file and the config field.

### 2.4 The real parseability check, finally unlocked

`buildResumeContentBlock()` (currently module-private in `extract.ts`)
is exported and reused — the SAME native-PDF-to-Claude pattern, not a
second implementation, not a new PDF-parsing library dependency (which
would be the alternative — rejected: this codebase already deliberately
chose native-PDF-to-Claude over local parsing for extraction, for the
same "don't lose fidelity" reason a parseability read needs). When
`applyProfile.resumePath` is set, `generatePrepPacket()`'s existing
single call embeds the real resume alongside the gig data and asks
Claude to assess genuine format/structure issues (multi-column, tables,
image-embedded text, non-standard headings) — grounded in the ACTUAL
file this time, not fabricated. `AtsScore` gains `parseabilityIssues:
string[]`, empty when no resume is persisted yet (graceful degradation,
not a hard requirement — a user who hasn't uploaded a resume still gets
the keyword-overlap half ats-navigator already shipped).

## 3. Open Questions

1. **Single resume vs. multiple/versioned resumes** (e.g. a "tech" vs.
   "ops" tailored version). This design ships ONE persisted resume —
   simplest, matches "the" resume the parseability check reads. If the
   owner wants multiple, that's a real follow-up (a small array +
   picker), not assumed here.
2. **Should persisted `links` also get fetched/re-validated periodically**
   (dead-link detection)? Out of scope — this design just persists what
   the user provides, same trust level as `linkedInUrl` today.

## 4. Scale assessment

**Medium.** Four small, independently-shippable slices, every one
plugging into an already-proven mechanism (encrypted file+path pattern,
shared data-block builder, existing single-shot LLM call) — no new
runtime, no new encryption scheme, no new LLM-call shape. Design-
discussion + vertical-plan only, matching this repo's own established
convention for medium-scope epics.
