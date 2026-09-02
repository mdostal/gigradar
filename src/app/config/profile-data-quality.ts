// deep-dive-audit-and-testing-framework epic, clean-and-guard-profile-data-
// quality story. Live-verified, 2026-09-02: the owner's real profile.skills
// contained "Fractional CTO"/"Principal Architect" -- literal duplicates of
// entries in profile.roles. Job titles sitting in the Skills field, with no
// code path that would ever have caught it. This is a WARNING surface, not
// a hard validation error -- a title-like phrase genuinely being both a
// role and a real skill is rare but possible, so saving is never blocked;
// the owner decides what to do with the warning.

/** Case-insensitive, trimmed exact-match overlap between roles and skills, in the order they appear in `skills`. */
export function findRoleSkillOverlap(roles: string[], skills: string[]): string[] {
  const normalizedRoles = new Set(roles.map((r) => r.trim().toLowerCase()).filter((r) => r.length > 0));
  const seen = new Set<string>();
  const overlap: string[] = [];
  for (const skill of skills) {
    const normalized = skill.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    if (normalizedRoles.has(normalized)) {
      overlap.push(skill);
      seen.add(normalized);
    }
  }
  return overlap;
}
