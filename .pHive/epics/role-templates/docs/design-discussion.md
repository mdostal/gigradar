# Design Discussion: role-templates

## 0. Prelude

**NORTH STAR**: generic OSS, any user configures their own roles/criteria;
built-in templates for common role types (fractional COO/CFO/etc.) plus
full custom configuration, per the original kickoff conversation.

No relevant prior decisions (global-KG query noise pattern from prior
epics not repeated this time — a clean, on-topic zero-result check).

## 1. What Are We Doing?

The last of the two items deliberately cut from `dashboard-config-ui` to
keep that epic honestly sized. A "start from template" picker in the
existing `/config` roleArea section: selecting a preset (e.g. "Fractional
CTO") populates `coreTitles`/`keywords`/`redKeywords` with a real,
tiering-aware starting set, still fully editable afterward — never a
locked-in choice.

"Done": the config form's roleArea section has a template dropdown/picker;
selecting one populates the three fields with real content respecting
`tiering.ts`'s precedence semantics; the user can still hand-edit anything
after picking.

## 2. What I Found

- The `roleArea` form state (`DraftRoleArea` in `config-client.tsx`) and
  its `enabled` toggle + three array fields already exist and work — this
  epic populates existing state, it doesn't build new form plumbing.
- `tiering.ts`'s precedence rules (coreTitles-in-title beats a
  redKeywords hit in that same title; keywords is the broader
  title+description signal; unmatched is YELLOW, never rejected) mean
  template content has real semantic weight — a template's `coreTitles`
  should be tight, unambiguous title synonyms, not a keyword dump.

## 3. My Proposed Approach

1. **Template data** (`src/lib/config/role-templates.ts` — new): a small,
   focused starting set of five — Fractional CTO, COO, CFO, CMO, and CPO
   (team-review finding — ui-designer: an earlier draft's fifth slot was
   a generic "Full-time Engineering Leadership" template, breaking C-suite
   parallelism and, worse, omitting CPO/Chief Product Officer, at least as
   common in fractional/startup contexts as CMO — CPO fills the fifth
   slot instead, keeping a clean, consistent C-suite set for v1) — each a
   `{id, label, config: RoleAreaConfig}`.
   `coreTitles` are tight, unambiguous title synonyms (e.g. CFO:
   "fractional cfo", "interim cfo", "chief financial officer", "vp of
   finance"); `keywords` broader (e.g. finance's "finance", "fp&a",
   "financial planning"). **`redKeywords`, corrected example** (grill H2:
   an earlier draft's CTO example was confused — "chief technology
   officer" IS the role, not a trap, and "cto of sales" isn't a real
   title): a real same-shape-different-domain trap for CTO is "Chief
   Talent Officer" — shares the "Chief ___ Officer" shape and could
   surface in a loose title-keyword match, but is a completely different
   role (HR/people, not technology). Each template's redKeywords should
   be genuine confusable titles like this, not filler.
2. **Picker UI, discoverability specified** (extend `config-client.tsx`'s
   existing roleArea section — team-review finding, ui-designer: an
   earlier draft under-specified this as just "a dropdown/select,"
   leaving real discoverability risk for a bare unlabeled control dropped
   into an already-familiar form section existing users won't expect new
   UI in): an explicitly labeled "Start from a template" dropdown/select,
   positioned immediately ABOVE the three `coreTitles`/`keywords`/
   `redKeywords` fields it populates (not buried elsewhere in the
   section), listing the five templates by label, plus an "Apply" action
   that sets `draft.roleArea` to the selected template's `config` (and
   `enabled: true`) — client-side state update only, no new Server Action
   needed (the existing save path already handles whatever `roleArea`
   shape results). Applying a template OVERWRITES the current roleArea
   draft (not merged) — the picker is a starting point, and a silent
   partial-merge would be more confusing than a clean overwrite a user
   can then edit.
3. **No backend changes.** `saveConfig()`/`ConfigSchema` already validate
   whatever `RoleAreaConfig` shape results — templates just populate form
   state with data that's already a valid instance of the existing type.

## 4. What Could Go Wrong

- **Low — template content quality is the only real risk**, and it's a
  content-review concern, not a technical one (confirmed by research, not
  assumed). Mitigated by review step attention to realistic
  title/keyword accuracy, not code correctness.
- **Low — applying a template overwrites existing hand-edited roleArea
  content.** **Decided (grill H1: an earlier draft suggested a
  confirmation safeguard in this risks section without committing to it
  in §3, leaving the actual spec ambiguous)**: NO confirmation dialog for
  v1 — a silent overwrite is acceptable given the field is trivially
  re-editable (nothing is saved to disk until the user hits Save, and the
  prior values were either empty or something they can retype). A
  confirmation step is a reasonable future enhancement, not a v1
  requirement.

## 5. Dependencies and Constraints

- Depends on `dashboard-config-ui`'s config form (merged) — extends it,
  doesn't modify its save path.
- Core/user-layer boundary: template content is generic, illustrative —
  never the project owner's own specific search criteria.

## 6. Open Questions

1. ~~How many templates for v1~~ — **resolved**: 5 (CTO/COO/CFO/CMO +
   generic Full-time Engineering Leadership), per §3 step 1.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest
  Platforms: Node.js (template data validation) + a real browser for
    manual UI verification
  Automated: each template's RoleAreaConfig validates against
    RoleAreaConfigSchema (schema-drift guard, matching the
    config.example.json pattern from local-secrets-config-storage);
    a test confirming each template's coreTitles/keywords don't
    accidentally overlap with its OWN redKeywords (a self-contradictory
    template would silently misclassify).
  Manual: selecting each template in a real browser, confirming the form
    fields populate correctly, confirming a subsequent save persists
    correctly, confirming the overwrite-confirmation safeguard (if
    implemented) fires when expected.
  Not verifying: automated E2E browser testing (same gap as every prior
    UI story in this project — manual verification only).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~3-4 (new role-templates.ts + tests, config-client.tsx
    extension)
  Subsystems: template content (new, small), config UI (extension of
    existing, shipped work)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 0 remaining (the one open question is resolved above)

  RECOMMENDATION: Proceed directly to stories (Small)
  RATIONALE: No new backend/API surface, no new architectural pattern —
    confirmed by research, not just assumed, since the form state and
    save path this epic uses already exist and already work. This is
    genuinely the smallest epic in the project so far.
```
