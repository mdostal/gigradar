# Design Discussion: security-hardening

## 0. Prelude

**NORTH STAR**: the repo is now public — these two findings were the
security audit's own explicit "must land first (blocking)" items for
responsible public launch, not a someday-nice-to-have.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

Two independent, confirmed security fixes:

1. **Windows key/data colocation** — give the vault key's Windows
   fallback path a genuinely separate directory from the data it
   protects, closing the gap between POSIX (already correctly separated)
   and Windows (currently identical).
2. **SSRF hardening in `fetchAndExtractLink()`** — block
   loopback/link-local/RFC1918/non-http(s) targets (resolved via real DNS
   lookup, not literal string matching) before fetching, add a timeout
   and a real streaming response-size cap, and stop echoing raw fetch
   error detail to the caller.

"Done": a dedicated test proves `getKeyConfigDir() !== getDefaultDataDir()`
on every platform (so this can't silently regress), and
`fetchAndExtractLink()` refuses to reach internal/private network targets
regardless of how they're disguised (literal IP, DNS-resolved hostname,
or redirect), with bounded time and response size.

## 2. What I Found

- Confirmed by direct code read (not re-trusting the audit summary
  alone): both Windows fallbacks resolve to the literal same directory —
  `%LOCALAPPDATA%\gigradar\` — differing only by filename
  (`key` vs `gigs.db`). POSIX paths are already correctly separated.
- Confirmed: `fetchAndExtractLink()` has zero URL validation, returns raw
  `e.message` in its warning, has no timeout, and reads the full response
  body with no size cap.
- `detectLoginWall()` (same file) already establishes the "reject early,
  specific warning" shape the SSRF check should follow — a natural
  sibling, not a new pattern.

## 3. My Proposed Approach

1. **`src/lib/security/key-path.ts`'s Windows fallback changes** from
   `path.join(base, "gigradar")` to `path.join(base, "gigradar-config")`
   — a genuinely distinct sibling directory from `store/path.ts`'s
   `path.join(base, "gigradar")`, mirroring the POSIX split's intent
   (`~/.config/gigradar` vs `~/.local/share/gigradar` — different parent
   roots) without needing Windows to have a first-class config/data
   distinction. `store/path.ts`'s data path is UNCHANGED (no migration
   needed for the DB/config.json/.env/session files — only the never-yet-
   correctly-separated key path moves). Resolves research brief open
   question #1's IP/directory-naming specifics for this half of the epic.
2. **New shared test**: `getKeyConfigDir() !== getDefaultDataDir()`,
   run for the real current platform AND with explicit `XDG_CONFIG_HOME`/
   `XDG_DATA_HOME` env var overrides simulating each platform's fallback
   path — so a future CODE change to either file's fallback logic that
   reintroduces the collision fails a test immediately, not silently.
   **Scope stated explicitly (added post-grill, resolves H2 below)**:
   this guarantee covers the fallback code path only. If a user
   explicitly sets `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to the SAME
   value themselves, the key and data directories would still collide —
   via the user's own configuration, not a code bug. Decided: out of
   scope for a hard failure (a user's deliberate env var choice isn't
   this epic's concern to override), but `getOrCreateKey()` logs a
   one-time warning if it ever detects the resolved key and data
   directories are identical, REGARDLESS of why — cheap, non-blocking,
   and catches this case too without pretending the fallback-only fix
   covers every possible cause of collision.
3. **`src/lib/profile-ingestion/extract.ts`'s `fetchAndExtractLink()`**
   gets a new pre-fetch validation step, resolving research brief open
   questions #1 and #2:
   - Parse the URL; reject anything not `http:`/`https:` outright.
   - Resolve the hostname via `dns.lookup()` (real DNS resolution, not
     literal-string matching — a hostname could resolve to a blocked
     range even if it doesn't look like one) and reject if any resolved
     address falls in: loopback (`127.0.0.0/8`, `::1`), link-local
     (`169.254.0.0/16`, `fe80::/10` — this range specifically covers the
     cloud metadata endpoint `169.254.169.254`), or RFC1918 private
     ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
     **IPv4-mapped IPv6 addresses normalized first (added post-grill,
     resolves H1 below)**: an address like `::ffff:127.0.0.1` embeds a
     blocked IPv4 address in IPv6 form — a well-known SSRF bypass if
     IPv4/IPv6 ranges are checked as two unrelated cases without
     unwrapping the mapped form first. The validation unwraps any
     `::ffff:a.b.c.d`-form address to its embedded IPv4 address before
     range-checking, so one blocklist check covers both representations.
   - A blocked target returns the same `LinkFetchResult` warning shape
     `detectLoginWall()` already uses — a specific, generic message
     ("this link points to a private/internal address and can't be
     fetched"), never the raw resolved IP or DNS detail.
   - `AbortController` with a 10-second timeout wraps the `fetch()` call.
   - The response body is read via its stream with a hard 5MB cap
     (`response.body`'s reader, not `response.text()` directly, and not
     trusting `Content-Length` alone since it can be missing or spoofed)
     — exceeding the cap aborts and returns a specific "response too
     large" warning.
   - **Raw error detail never returned to the caller** — the catch
     block's `e.message` is logged server-side only (`console.error`,
     matching this project's existing "detail server-side, generic
     message to the client" pattern already used for secret-adjacent
     errors); the returned warning becomes a fixed, generic
     "couldn't fetch this link" message, never the raw exception text.

## 4. What Could Go Wrong

- **Low — full DNS-rebinding protection (re-checking the IP at the exact
  fetch moment, not just before it) is explicitly NOT built here** — a
  reasonable, stated scope cut matching the audit's own bar ("block...
  before fetching"), not a silent gap. **Reconciled explicitly with the
  "blocking for launch" framing (added post-grill, resolves U1 below)**:
  this residual gap doesn't undermine that bar, because exploiting it
  requires an attacker to both control DNS infrastructure for the target
  hostname AND time a DNS record change to land between this validation
  step and the actual `fetch()` call milliseconds later — a materially
  harder, more targeted attack than today's zero-validation state, which
  any casual `localhost`/`169.254.169.254` paste already exploits
  trivially. Closing the easy case is what "blocking for launch" means
  here; closing the hard, narrow, precisely-timed case is legitimately
  separate, deferred scope, not a reason to withhold this fix.
- **Low — the Windows fix is unverifiable on this development machine**
  (macOS) — the new test simulates the Windows fallback path logic
  directly (by checking the function's OUTPUT given a simulated
  `process.platform`/env state) rather than requiring an actual Windows
  machine, matching how this project already tests XDG resolution
  without needing every real OS.
- **Low — the 5MB/10s limits are reasonable defaults, not
  empirically-tuned** — accepted, matches the audit's own suggested
  values; can be revisited if a real legitimate profile/portfolio page
  ever turns out to exceed them (unlikely for HTML text content).

## 5. Dependencies and Constraints

- No new dependencies — `node:dns` (built-in) for hostname resolution,
  `AbortController` (built-in, Node 18+) for the timeout, and the
  existing `Response.body` stream API for the size cap.
- Scoped ONLY to `fetchAndExtractLink()`'s user-supplied URL path — the 3
  live source adapters' `fetch()` calls target hardcoded constant URLs,
  never user input, and are out of scope for this fix.
- Depends on nothing else changing — both fixes are self-contained,
  isolated corrections to already-shipped code.

## 6. Open Questions

1. ~~Exact IP-range blocklist?~~ — **resolved**: loopback, link-local
   (covers cloud metadata), RFC1918 — §3 step 3.
2. ~~Exact timeout/size-cap numbers?~~ — **resolved**: 10s / 5MB, matching
   the audit's own suggested values — §3 step 3.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/security-hardening/docs/grill-record.md`,
`unresolved_count: 3`) surfaced 3 findings, all resolved:

- **H1** (IPv4-mapped IPv6 addresses could bypass the blocklist) —
  resolved in §3 step 3: such addresses are normalized/unwrapped to their
  embedded IPv4 form before range-checking.
- **H2** (the "can't silently regress" test claim didn't cover a user
  setting both XDG vars identically) — resolved in §2: scope stated
  explicitly, plus a non-blocking one-time warning if the collision is
  ever detected for ANY reason, not just the fallback code path.
- **U1** (unreconciled tension between "blocking for launch" and an
  accepted residual DNS-rebinding gap) — resolved in §4: the reasoning
  for why the partial fix is still adequate is now stated explicitly,
  not just the gap itself named.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; node:dns (built-in)
  Platforms: Node.js
  Automated: getKeyConfigDir() !== getDefaultDataDir() test across
    simulated platform/env-var states (not just the real current OS);
    fetchAndExtractLink() tests against a local test HTTP server for the
    timeout and size-cap paths (no real network dependency), and mocked
    dns.lookup() resolutions covering: a hostname resolving to 127.0.0.1
    (blocked), 169.254.169.254 (blocked, the actual cloud metadata IP),
    a private 10.x/172.16.x/192.168.x address (blocked), and a normal
    public IP (allowed) — proving the check is resolution-based, not
    literal-string-based, by using a hostname that doesn't LOOK internal
    but resolves to a blocked range. A dedicated test confirms a thrown
    fetch error's raw message never appears in the returned warning.
  Manual: none required beyond the automated suite — both fixes are
    fully testable without live network dependencies or a real Windows
    machine.
  Not verifying: full DNS-rebinding (TOCTOU) protection — explicitly
    scoped out, §4.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~4-6 (key-path.ts, extract.ts, their test files, a new
    shared path-separation test)
  Subsystems: security/vault path resolution, profile-ingestion link
    fetching — two isolated, unrelated files, no shared code between them
  Migration required: no — the Windows key path was never correctly
    separated, so there's nothing to migrate away from; the SSRF fix only
    adds validation, doesn't change any existing valid link's behavior
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Small, two independent stories, skip H/V
  RATIONALE: Both fixes are narrow, well-understood corrections to
    already-shipped, already-identified bugs — not new feature design.
    No structural unknowns remain. Two stories (one per fix) rather than
    one, since they touch completely unrelated files and either could
    ship independently if only one review pass is wanted first.
```
