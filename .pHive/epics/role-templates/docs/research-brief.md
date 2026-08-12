# Research Brief: role-templates

## 1. Summary

The smallest, lowest-risk of the four epics queued after `dashboard-config-ui`
(per that epic's own risk assessment: "content-authoring effort more than
technical risk"). The config form already has a `roleArea` section with an
`enabled` toggle and `coreTitles`/`keywords`/`redKeywords` string-array
fields wired to real state (`DraftRoleArea` in `config-client.tsx`) — a
template picker only needs to populate that existing state, not build new
plumbing.

## 2. Key files & surfaces

- `src/lib/types.ts` — `RoleAreaConfig { coreTitles, keywords, redKeywords }`
  (all `string[]`), consumed by `src/lib/matching/tiering.ts`'s precedence
  rules (coreTitles-in-title wins GREEN even over a redKeywords hit;
  keywords is broader title+description GREEN; unmatched is YELLOW, never
  a hard reject).
- `src/app/config/config-client.tsx` — `DraftRoleArea` state
  (`{enabled, coreTitles, keywords, redKeywords}` as UI-editable string
  arrays), the `roleArea.enabled` checkbox, and the three array-editor
  fields — all already real and working (shipped in `dashboard-config-ui`).
- `src/lib/matching/tiering.ts` — the precedence semantics a template's
  keyword lists must respect (word-boundary matching, title-first
  precedence) — template content should be written with this in mind, not
  arbitrary keyword soup.

## 3. Patterns & conventions

- Core/user-layer boundary: template DATA is generic OSS (no owner-specific
  criteria), same discipline as every prior epic's roleArea handling.
- The legacy predecessor tool's own role-area tiering (ported conceptually,
  not literally, in `find-pipeline-foundation`) used title-first,
  word-boundary matching — templates should supply realistic, genuinely
  distinguishing keyword sets per role area, not generic placeholders.

## 4. Constraints

- No new backend/API work — this is UI + static data only. The existing
  `saveConfigAction`/`saveConfig()` write path already handles whatever
  `roleArea` shape a template populates; no changes needed there.
- Must not encode the project owner's own specific criteria as "the"
  template — templates are illustrative starting points for ANY user's
  fractional/full-time search, not a copy of one person's search.

## 5. Risks

- **Low — content quality, not technical risk** (confirmed, not just
  assumed, by re-reading the existing form's real state shape). The risk
  is writing keyword lists that are too narrow (miss real title
  variations) or too broad (false-positive GREEN matches) — a content
  review concern, not an architecture one.

## 6. Open questions

1. How many templates for v1 — the full documented set
   (CTO/COO/CFO/CMO/etc. per north_star) or a smaller starting set that's
   easy to extend later? Leaning toward a focused initial set (a handful
   of the most common fractional C-suite roles) over an exhaustive list,
   given this is genuinely easy to add to later with no architecture
   change.
