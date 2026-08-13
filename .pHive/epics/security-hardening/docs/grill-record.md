# Grill Record — security-hardening

**Source draft:** .pHive/epics/security-hardening/docs/design-discussion.md
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

No findings. "SSRF," "loopback," "link-local," "RFC1918" are used
consistently with their standard security meanings, no mid-document shift.

## Hidden assumptions

- **H1** — §3 step 3's IP-range blocklist names `127.0.0.0/8`, `::1`,
  `169.254.0.0/16`, `fe80::/10`, and the RFC1918 ranges, but never
  addresses IPv4-mapped IPv6 addresses (e.g. `::ffff:127.0.0.1` or
  `::ffff:169.254.169.254`) — a well-known SSRF bypass technique where an
  IPv6 address literally embeds a blocked IPv4 address in a form that
  naive separate IPv4/IPv6 range checks can miss if the address isn't
  normalized/unwrapped first.
  - Draft location: §3 step 3 (the blocklist)
  - Why this matters: this is exactly the class of bypass a real attacker
    would try first against a newly-added IP-range check — if the
    implementation checks IPv4 and IPv6 ranges as two separate, unrelated
    checks without unwrapping mapped addresses, the protection has a
    known hole on day one.
  - Question for planner: should the validation logic explicitly
    normalize/unwrap IPv4-mapped IPv6 addresses to their embedded IPv4
    form before range-checking, so one blocklist check covers both
    representations?

- **H2** — §2's "new shared test" claims `getKeyConfigDir() !==
  getDefaultDataDir()` "can't silently regress" — but the design's fix
  only addresses the WINDOWS FALLBACK code path (when neither
  `XDG_CONFIG_HOME` nor `XDG_DATA_HOME` is set). If a user explicitly sets
  BOTH `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to the same value (an
  unusual but real possible user misconfiguration, not a code bug), the
  key and data paths would still collide — via the user's own env, not
  via the fallback logic this fix touches. The draft's "can't silently
  regress" framing doesn't distinguish "the code is correct" from "the
  guarantee holds regardless of user configuration."
  - Draft location: §2 ("New shared test... so a future change... fails a
    test immediately, not silently")
  - Why this matters: the epic's own "Done" bar implies a strong
    guarantee; if that guarantee only holds for the no-env-vars-set
    default case, that scope limit should be stated, not implied away by
    a testing claim that sounds broader than what's actually tested.
  - Question for planner: is the user-sets-both-XDG-vars-identically case
    explicitly out of scope (the user's own deliberate choice, not this
    epic's concern) — in which case say so — or should `getOrCreateKey()`/
    startup logic emit a warning (not a hard failure) if it ever detects
    the resolved key and data directories are identical, regardless of
    why?

## Unresolved tensions

- **U1** — §0's north star frames both fixes as the security audit's own
  "must land first (blocking)" items for public launch. But §4 explicitly
  accepts a residual SSRF gap (no DNS-rebinding/TOCTOU protection) as
  out of scope for this pass. The draft doesn't reconcile "blocking for
  launch" with "a known bypass technique is knowingly left unaddressed" —
  even though the bypass being deferred is meaningfully harder to exploit
  than what's being fixed (an attacker would need to control DNS
  infrastructure and time the request precisely), the draft never states
  that reasoning explicitly as why the partial fix is still an adequate
  launch-blocker resolution.
  - Draft location: §0 (north star: "must land first (blocking)"), §4
    ("full DNS-rebinding protection... explicitly NOT built here")
  - Tension: "blocking for launch" vs. "a known, real bypass class is
    deliberately left open."
  - Question for planner: should §4 explicitly state WHY the accepted
    residual risk (DNS rebinding, requiring attacker-controlled DNS +
    precise timing) doesn't undermine the "adequate for launch" claim —
    i.e., make the risk-acceptance reasoning explicit rather than just
    naming the gap?

## Convention violations

No findings. The SSRF fix's "reject early with a specific warning" shape
matches `detectLoginWall()`'s existing pattern in the same file, and the
Windows key-path fix preserves the existing shared XDG-resolution
structure across both files.

## Posture mismatches

No findings. Both fixes stay fully local, no new network exposure or
telemetry, consistent with every prior epic's posture.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
