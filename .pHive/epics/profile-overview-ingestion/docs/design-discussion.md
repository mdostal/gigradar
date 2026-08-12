# Design Discussion: profile-overview-ingestion

## 0. Prelude

**NORTH STAR**: get the owner (and eventually any downloader) to full,
real use of the tool end to end without hand-editing JSON. This epic
closes two concrete gaps hit during the owner's first real local test run:
no unified view of what's set up, and no way to populate `Profile` from a
resume/link instead of hand-typing skills.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern as every prior query — disregarded).

## 1. What Are We Doing?

Two related, separately-shippable pieces of work:

**(A) Overview navigation.** A shared nav (Dashboard / Config) so the two
existing pages are actually connected, plus a small status strip showing:
sources configured (count, and how many have a valid session/key vs. not),
profile completeness (name/roles/skills/needs present or not), and last
scan time (derived from `MAX(last_seen)` across stored gigs — zero schema
change).

**(B) Resume/link → Profile skills ingestion.** An "Extract from
resume/link" action in `/config`'s Profile section: upload a resume
(PDF or plain text) and/or paste one or more public links (GitHub,
portfolio, personal site). Claude's API reads the content and returns
structured `{ roles: string[], skills: string[] }`. The result populates
DRAFT state in the existing form — exactly like `role-templates`' template
picker — the user reviews and edits it inline, then Saves (or discards)
like any other form edit. Nothing is ever auto-applied.

"Done": the two pages are navigable and show real status at a glance; a
user can upload their actual resume, see extracted skills/roles appear as
an editable draft, adjust anything wrong, and save — never hand-typing a
skills list from scratch, and never having anything silently overwritten.

## 2. What I Found

- `src/app/layout.tsx` is bare; `page.tsx` and `config/page.tsx` have zero
  links to each other (confirmed by direct grep, not assumed).
- `last_seen` (per-gig, bumped every scan) makes `MAX(last_seen)` a
  zero-migration proxy for "last scan time" — no new DB column needed.
- The `role-templates` epic's draft-then-Apply pattern in
  `config-client.tsx` is directly reusable for extracted skills/roles —
  same shape, different source of the draft data.
- Claude's Messages API accepts PDF documents as a native content block —
  no separate PDF-text-extraction dependency needed for the resume-upload
  path.
- The project's existing `env:`-reference secret pattern
  (`src/lib/config/load.ts`'s `resolveEnvString()`) already does everything
  an LLM API key needs — no new secret-storage mechanism required, and it
  inherits v0.8.0's encryption-at-rest for free.
- Zero HTML-parsing or LLM-SDK dependency exists in `package.json` today —
  both are genuinely new for this epic.

## 3. My Proposed Approach

### Part A — Overview navigation

1. **Shared nav** — a small `<NavHeader>` component (new,
   `src/app/nav-header.tsx`) rendered from `layout.tsx`, two links:
   Dashboard (`/`) and Config (`/config`). Minimal, not a redesign of
   either existing page.
2. **Status strip** — a small server-rendered summary at the top of the
   dashboard: "N sources configured (M need attention)", "Profile: complete
   / needs setup", "Last scan: <relative time> / never run".
   **Corrected data-fetching claim (collaborative-review finding)**: only
   "last scan time" (`MAX(last_seen)` across stored gigs) is free from
   `page.tsx`'s existing `listGigs()` call — confirmed by direct code read,
   `page.tsx` does NOT read `config.json` today. "Sources configured" and
   "profile completeness" need one additional `readRawConfig()` call in
   `page.tsx` (the same non-resolving reader `config/page.tsx` already
   uses) — a small, low-risk addition, but a real one, not a free
   byproduct of the existing render.

### Part B — Resume/link ingestion

1. **New dependency**: `@anthropic-ai/sdk` (official SDK). API key
   resolved via the EXISTING `.env` mechanism — `ANTHROPIC_API_KEY` in
   `.env`, read directly via `process.env` inside the new Server Action,
   never a new `Config` schema field (this isn't a per-source setting,
   it's a tool-wide capability, so it doesn't belong on `SourceConfig`).
   **A minimal UI writer for this ONE var (added post-grill, resolves U1
   below)**: a new `src/lib/config/env-store.ts`, `setEnvVar(name, value):
   ActionResult<void>` — reads `.env` raw (decrypt via vault.ts if it's
   already encrypted, else empty-string default for a missing file),
   parses via `dotenv.parse()`, sets/overwrites the given key, re-serializes
   to `KEY=VALUE` lines, calls `getOrCreateKey(hasAnyEncryptedFile)` before
   `encrypt()` (required — `vault.ts` throws otherwise), and atomic-writes
   0600. **Duplicates, does not import, the atomic-write-then-encrypt
   helper (collaborative-review finding)**: `load.ts`'s equivalent helper
   is private, and `save.ts`'s own established precedent for config.json
   is to duplicate rather than import load.ts internals for exactly this
   reason (its header comment explains why) — `env-store.ts` follows the
   same convention rather than exporting new surface from `load.ts` just
   for this. One accepted cosmetic tradeoff: `dotenv.parse()`-then-reserialize
   drops any comments/blank-line formatting from a hand-edited `.env` on
   its first UI-triggered write — a one-time, harmless normalization, not
   a bug. `/config`'s Profile section gets a single password-style input,
   "Anthropic API key," wired to this via a new Server Action — the only
   field in the entire config UI that writes to `.env` instead of
   `config.json`, called out as such in the UI copy.
2. **New module `src/lib/profile-ingestion/extract.ts`**: takes
   `{ resumeFile?: {data: Buffer, mediaType: string}, resumeText?: string,
   links?: string[] }`, fetches each link's content server-side (plain
   `fetch()`, then extracts visible text — no headless browser, no new
   dependency), assembles one Claude API call with the resume (as a native
   PDF document block, or as plain text) plus fetched link text, and a
   prompt asking specifically for `{ roles: string[], skills: string[] }`
   as structured output (Claude's tool-use / structured-output feature,
   not free-text parsing). Returns that structure — nothing more, nothing
   persisted by this module itself.
   **HTML-to-text extraction is NOT a naive tag-strip (added post-grill,
   resolves H1 below)**: `<script>` and `<style>` elements must be removed
   ENTIRELY (tag + their text content) before any general tag-stripping —
   a plain "remove `<...>` markup" regex would leave raw JavaScript/CSS
   source behind as if it were page content, degrading exactly the
   flagship supported case (§3 step 6's GitHub-profile/portfolio pages,
   which routinely have real `<script>` blocks).
3. **In-memory only — resolves research brief open question #2.** The
   uploaded file's bytes and any fetched link content are processed for
   the duration of the one API call and then discarded. Nothing new is
   written to disk by this epic; the ONLY persistence path remains the
   existing `saveConfig()`, and only for whatever the user explicitly
   edits/keeps in the draft and then Saves. This sidesteps an entire new
   sensitive-file-storage design surface (research brief risk item) by
   construction, not by an added safeguard.
4. **New Server Action** (`src/app/config/actions.ts`, extended):
   `extractProfileFromResumeAction(formData)` — accepts a `FormData` upload
   (native Next.js Server Action file-upload support) plus a links
   textarea, calls the module above.
   **The API key is resolved fresh per request, not via `process.env`
   (collaborative-review finding, critical correctness fix)**: the Next.js
   app's request path NEVER populates `process.env` from `.env` today —
   only `apply/runner.ts` (the CLI/cron path) calls `loadConfig()`, which
   is what triggers `.env` loading; the web app's Server Actions never go
   through it (confirmed: `config/actions.ts` never calls `loadConfig()`,
   and `config/page.tsx` deliberately uses the non-resolving `readRawConfig()`
   instead). This action reads and decrypts `.env` directly (reusing
   `env-store.ts`'s read-side helper) and resolves `ANTHROPIC_API_KEY` from
   the parsed result INSIDE the action handler, per call — never at module
   scope (a module-scope-instantiated Anthropic client would permanently
   capture `undefined` on first import) and never by mutating global
   `process.env`. If the key isn't set, the action returns a specific
   `ActionResult` error pointing at the new "Anthropic API key" field
   (§3 step 1), not a generic SDK auth error.
   **Return shape carries per-link partial failure (collaborative-review
   finding)**: `ActionResult<{roles: string[], skills: string[], warnings:
   string[]}>` — a link that fails to fetch (bot-walled, network error,
   non-HTML response) adds one entry to `warnings` (e.g. "couldn't fetch
   https://linkedin.com/... — it may require login") and is simply skipped,
   it does NOT fail the whole action; the resume and every other
   successfully-fetched link still contribute to the result. Only a total
   failure (e.g. the resume itself is unparseable, or the Anthropic API
   call itself errors) returns `ok: false`.
   **Server Action body size**: default Next.js Server Action body limit
   (1MB) is too small for a real resume PDF — `next.config.js` needs
   `experimental.serverActions.bodySizeLimit` raised (e.g. to 10MB) for
   this route.
5. **UI**: `config-client.tsx`'s Profile section gets an "Extract from
   resume/link" control (file input + links textarea + a button). **Reuses
   `role-templates`' draft-then-Apply UI SHAPE only — not its overwrite
   behavior (clarified post-grill, resolves C1 below).** `role-templates`'
   Apply is a deliberate full REPLACE of `roleArea` (its own documented
   design decision: "Applying OVERWRITES the current draft, no
   confirmation"). This feature diverges from that on purpose: extracted
   `roles`/`skills` are MERGED (appended, de-duplicated) into whatever's
   already in the draft, not a replace, because a resume is additive
   enrichment of an existing profile, not a full-profile reset the way
   swapping to a different role template is. What's genuinely reused from
   `role-templates` is the UI PATTERN — draft state populated by an action,
   rendered in the same editable fields the user can already hand-edit,
   nothing persisted until an explicit Save — not its specific
   replace-on-apply semantics.
   **Dedup normalization stated explicitly (collaborative-review
   finding)**: merge comparison is case-insensitive and whitespace-trimmed
   ("React" vs. "react" dedups; "Node.js" vs. "NodeJS" does NOT, since
   that's not a normalization rule, it's two genuinely different strings —
   accepted as a known limit, not solved by this epic). The button shows a
   pending/loading state during the LLM call (a real multi-second
   operation, not instant) and every `warnings` entry from the Server
   Action's result (§3 step 4) renders as a small, per-link inline notice
   next to the links input, so a partial failure is visible, not silent.
6. **Link scope — resolves research brief open question #3.** v1 supports
   plain server-side-fetchable public pages: GitHub profile/READMEs,
   personal portfolio/blog. LinkedIn is explicitly and visibly documented
   as NOT reliably supported (bot-walled against unauthenticated fetches)
   — the UI's link-input help text says this directly, so it's a stated
   limitation, not a silent failure a user discovers by confusion.
   **The bot-wall check is narrow, not a generic length heuristic (added
   post-grill, resolves H2 below)**: a length-based "very short body"
   check risks false-positiving on a legitimately short, valid personal
   page (a common, realistic shape for exactly this epic's target
   audience). Instead: check for KNOWN, SPECIFIC login-wall signatures
   (e.g. LinkedIn's own login-redirect URL pattern and its
   `authwall`-style markers; a generic HTTP 3xx redirect to a `/login` or
   `/signin` path) rather than inferring from content length. A link that
   doesn't match a known signature is processed normally, even if short —
   false negatives (an actual bot-wall slipping through as low-quality
   extracted text) are an acceptable, self-correcting failure mode here
   (the user sees poor extraction results and can just remove them from
   the draft), while false positives (rejecting a valid short page) would
   directly undermine this epic's supported-link-types goal.
7. **Skills/roles only — resolves research brief open question #1.**
   `roleArea` keyword suggestion is explicitly out of scope; the existing
   template picker already covers that need well.

## 4. What Could Go Wrong

- **High — this is gigradar's first outbound call to a third-party API
  with personal data (the resume) in the payload.** For a project whose
  entire posture has been "100% local" until now, this is a real privacy
  posture shift, not just a feature. Mitigation: strictly opt-in and
  explicit per-use (a button the user clicks each time, never automatic or
  scheduled), clearly labeled in the UI ("sends this content to Anthropic's
  API"), and never persisted beyond the single call (§3 step 3).
- **Medium — LinkedIn is the most obvious link a user would paste in, and
  it won't reliably work.** Mitigation: explicit, visible scope statement
  in the UI itself (§3 step 6), not just in this doc.
- **Low-Medium — real API cost** against the user's own key, per click.
  Not mitigated further (an explicit user action IS the appropriate
  consent gate for a cost the user's own key pays for) but worth being
  visible about (a small "this uses your Anthropic API key" note near the
  button).
- **Low — new dependency (`@anthropic-ai/sdk`) and its own transitive
  dependency surface.** Standard, well-maintained official SDK; accepted.

## 5. Dependencies and Constraints

- Depends on `role-templates` (draft-then-Apply UX pattern, reused not
  reinvented), `dashboard-config-ui` (the pages this epic adds nav
  between), `local-secrets-config-storage` / `encrypted-local-storage`
  (the `.env` mechanism the API key rides on, now encrypted at rest for
  free).
- New runtime dependency: `@anthropic-ai/sdk`.
- Requires the user to obtain their own Anthropic API key (an external
  account-creation step this design cannot eliminate), but setting it into
  gigradar is now a UI form field (§3 step 1's `env-store.ts` writer), not
  a hand-edited dotfile — resolving U1. `.env.example` still documents the
  var for anyone who prefers editing it directly.

## 6. Open Questions

1. ~~Skills/roles only, or also roleArea keywords?~~ — **resolved**:
   skills/roles only, §3 step 7.
2. ~~Persist the raw resume file?~~ — **resolved**: no, in-memory only,
   §3 step 3.
3. ~~Which link types are supported in v1?~~ — **resolved**: public,
   fetchable-without-login pages only; LinkedIn explicitly out, §3 step 6.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/profile-overview-ingestion/docs/grill-record.md`,
`unresolved_count: 4`) surfaced 4 findings, all resolved in this revision:

- **U1** (setting the API key required hand-editing `.env`, contradicting
  the epic's own "no hand-editing" north star) — resolved in §3 step 1 and
  §5: a minimal `env-store.ts` writer + a single UI form field make this a
  form field like everything else, not a dotfile edit.
- **H1** (naive HTML tag-stripping would leak `<script>`/`<style>` content
  into extracted text) — resolved in §3 step 2: those elements are removed
  entirely, not just their tags, before general stripping.
- **H2** (undefined, false-positive-prone bot-wall length heuristic) —
  resolved in §3 step 6: replaced with narrow, known-signature detection
  (LinkedIn's specific redirect/authwall pattern) rather than a generic
  short-body heuristic.
- **C1** (claimed to reuse role-templates' "exact" UX while silently
  changing its overwrite semantics to merge) — resolved in §3 step 5: the
  divergence is now stated explicitly, with rationale (additive enrichment
  vs. full-profile-reset), and scoped to what's actually reused (the UI
  shape) vs. what's deliberately different (merge vs. replace).

## 6b. Collaborative Review Findings Addressed

Two independent reviews (backend/security lens, frontend/UX lens), run
against the grill-revised draft, surfaced 8 concrete findings — all
grounded in direct reads of the real current code — all resolved:

- `env-store.ts` must DUPLICATE, not import, the atomic-write-then-encrypt
  helper (following `save.ts`'s own established precedent) — §3 step 1.
- Must call `getOrCreateKey()` before `encrypt()` — §3 step 1.
- The API key must be resolved fresh per-request inside the Server Action,
  never via `process.env`/module scope, since the web app's request path
  never triggers `.env` loading today (only the CLI/cron path does) — a
  critical correctness fix, §3 step 4.
- Server Action body-size limit needs raising for real resume PDFs — §3
  step 4.
- Per-link partial failure needed an explicit return-shape decision
  (`warnings[]`, not all-or-nothing) — §3 step 4.
- Dedup normalization (case-insensitive, trimmed) stated explicitly — §3
  step 5.
- The status strip's "sources configured"/"profile completeness" fields
  need one new `readRawConfig()` call in `page.tsx` — not free, as an
  earlier draft implied — §3 Part A step 2.
- Loading state + per-link warning display added to the UI description —
  §3 step 5.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; @anthropic-ai/sdk (new); native fetch
  Platforms: Node.js / Next.js Server Actions
  Automated: extract.ts unit tests with a MOCKED Anthropic client (no real
    API calls in the automated suite, matching this project's existing
    zero-live-network-calls-in-CI convention) — covers: PDF-document-block
    construction, plain-text-resume path, link-fetch-and-strip-HTML
    (including a fixture page with real <script>/<style> content, per
    grill H1), known-signature bot-wall detection (per grill H2, not a
    length heuristic), structured-output parsing into {roles, skills}, and
    the case-insensitive-trimmed merge/dedup logic against existing draft
    skills/roles. env-store.ts tests: round-trip set/read, first-write on a
    missing .env, first-write migrating an existing legacy-plaintext .env
    (reusing vault-module's isEncryptedEnvelope() the same way load.ts
    does). extractProfileFromResumeAction tests: the mixed-link
    partial-failure case (2 of 3 links succeed, 1 produces a `warnings`
    entry, overall result is still ok:true with partial data — per
    collaborative review) and the per-request (not module-scope, not
    process.env) API-key resolution. Nav-header and status-strip tests:
    rendering with 0 sources / N sources, profile complete/incomplete,
    scan-run/never-run states, and a loading-state test for the extract
    button.
  Manual: a real end-to-end run, using the owner's OWN real resume and a
    real public link (e.g. a GitHub profile), against the real Anthropic
    API with a real key — confirming extracted skills/roles are accurate
    and the draft/Save flow works correctly; also manually confirm a
    LinkedIn URL produces the specific "may require login" warning
    alongside successful results from the other inputs, rather than
    discarding everything or silently producing bad data.
  Not verifying: LinkedIn scraping (explicitly out of scope, §3 step 6);
    .docx/.doc resume formats (explicitly out of scope — PDF and plain
    text only for v1, not previously named as an open question but a
    scope cut worth stating plainly here).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~13-15 (new nav-header.tsx, new
    src/lib/profile-ingestion/extract.ts, new src/lib/config/env-store.ts,
    all three with tests; modifications to layout.tsx, page.tsx,
    config/actions.ts, config-client.tsx, next.config.js
    (bodySizeLimit), package.json/.env.example, docs/ARCHITECTURE.md)
  Subsystems: new profile-ingestion module (LLM integration, genuinely
    new surface), UI navigation/status (additive, low risk), existing
    config Server Action layer (extended, not restructured)
  Migration required: no — purely additive, no existing file format or
    schema changes
  Cross-team coordination: no
  Unknowns: 0 remaining (all three open questions resolved above)

  RECOMMENDATION: Needs H/V planning (Medium)
  RATIONALE: Part A (nav/status) is genuinely low-risk and could ship
    standalone at Small scope. Part B introduces this project's first
    external API dependency and first handling of a new class of
    sensitive input (uploaded personal documents) — real design surface
    even though the "in-memory only, never persisted" decision (§3 step 3)
    keeps it from becoming a full new storage epic. Sequencing the two
    parts as separate stories (nav/status first — fast, unblocks the
    owner's immediate "where's the unified view" complaint — then the
    ingestion module, then the UI wiring) mirrors every prior epic's
    isolate-the-foundation-first pattern. Not Large: no structural
    unknowns remain, and the in-memory-only decision keeps the storage
    surface from expanding.
```
