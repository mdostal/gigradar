# Research Brief: security-hardening

## 1. Summary

Two confirmed, must-fix findings from the pre-launch security audit
(`wf_e55abadc-be0`, run before this repo went public): (1) on Windows,
the vault key and all encrypted data resolve to the SAME default
directory, defeating the encrypted-local-storage epic's core security
property; (2) the profile-ingestion "paste a link" feature has an
unrestricted SSRF hole — fetches any user-supplied URL server-side with
zero validation, no timeout, no size cap, and echoes raw fetch errors
back to the caller (an internal-network probing oracle).

## 2. Key files & confirmed bugs (re-verified by direct code read, not
   re-trusting the audit's summary alone)

- **`src/lib/security/key-path.ts:29-31`** vs. **`src/lib/store/path.ts:24-26`**
  — both Windows fallbacks resolve to `%LOCALAPPDATA%\gigradar\` — the
  IDENTICAL directory (same `LOCALAPPDATA` base, same `APP_DIR_NAME =
  "gigradar"`, no further differentiation). The key file would be
  `%LOCALAPPDATA%\gigradar\key`; the DB `%LOCALAPPDATA%\gigradar\gigs.db`
  — same directory, only the filename differs. On POSIX, this bug does
  NOT exist: `~/.config/gigradar` (key) vs. `~/.local/share/gigradar`
  (data) are genuinely separate parent trees. Only the Windows fallback
  path is broken.
- **`src/lib/profile-ingestion/extract.ts:130-161`**'s
  `fetchAndExtractLink()`: `fetch(url)` (line 133) with zero scheme/host/
  IP validation; a failed fetch's raw `e.message` is returned verbatim in
  the warning (line 135); no `AbortController` timeout; `response.text()`
  (line 159) reads the entire body with no size cap.

## 3. Patterns & conventions

- Both `key-path.ts` and `store/path.ts` already share the identical
  XDG-resolution STRUCTURE (env var → Windows fallback → POSIX fallback)
  by design — the fix must preserve that shared shape while making the
  WINDOWS fallback's actual output genuinely different, not restructure
  the whole resolution pattern.
- `fetchAndExtractLink()` already has a `detectLoginWall()` helper doing
  signature-based checks on the response — the SSRF fix's pre-fetch
  validation is a natural sibling check, same file, same "reject early
  with a specific warning" shape already established there.
- This project's established rule: never surface raw internal error
  detail to a client-visible response (the exact same discipline already
  applied to secret values) — extends naturally to "never surface raw
  network error detail that could reveal internal topology."

## 4. Constraints

- **Must not break the 3 real, live public-board adapters** (fetch(),
  no SSRF risk there since their target URLs are hardcoded constants in
  the adapter files, never user-supplied) — this fix is scoped
  specifically to `fetchAndExtractLink()`'s user-supplied URL path, not a
  blanket restriction on every `fetch()` call in the codebase.
- **DNS resolution, not just literal-string IP parsing.** A hostname like
  a custom DNS entry could resolve to `169.254.169.254` (the cloud
  metadata endpoint) even though the URL's literal string is an
  ordinary-looking hostname — validation must resolve the hostname to its
  real IP(s) and check THOSE, not just pattern-match the URL text.
- **No existing Windows install to migrate** — this bug means no
  Windows user could have had a genuinely working, separated key/data
  split before; fixing the Windows key path's fallback location is not a
  breaking migration for anyone (there's nothing to migrate away from).

## 5. Risks

- **Low — full DNS-rebinding protection (re-validating the IP at the
  exact moment of the actual fetch, not just before it) is real,
  additional complexity** beyond what the audit asked for ("block
  loopback/link-local/RFC1918/non-http(s) targets before fetching"). Full
  TOCTOU-proof protection is a reasonable, explicit scope cut for this
  pass — pre-fetch resolution-based validation is a massive improvement
  over today's zero validation, and matches the audit's own stated bar.
- **Low — `Content-Length` header can be missing or spoofed**, so the
  response-size cap needs a real streaming byte-count enforcement, not
  just trusting that header.

## 6. Open questions

1. What's the exact IP-range blocklist? Leaning: loopback (127.0.0.0/8,
   ::1), link-local (169.254.0.0/16, fe80::/10 — this range specifically
   covers the cloud metadata endpoint), RFC1918 private ranges
   (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), and non-http(s) schemes
   rejected outright.
2. What are the exact timeout/size-cap numbers? Leaning: 10s timeout,
   5MB response cap — both match the audit's own suggested values, no
   reason to deviate without evidence either number is wrong for this
   use case.
