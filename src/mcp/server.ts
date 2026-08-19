// gigradar's MCP server (agent-integration epic, mcp-server-core story):
// exposes 5 tools over stdio so any MCP client (Claude Desktop, Claude
// Code, another agent) can list/inspect/update gigs and trigger a scan —
// "check my gigs", "mark this one applied", "run a scan" — without
// hand-rolling API calls. `npm run mcp` runs this file directly.
//
// EVERY tool below is a thin wrapper around the EXACT src/lib functions the
// dashboard/CLI already use (src/lib/store/gigs.ts, src/lib/apply/runner.ts,
// src/lib/config/load.ts + save.ts, src/lib/status/status-strip.ts) — no
// parallel logic lives here. See docs/ARCHITECTURE.md for the core/
// user-layer boundary this file sits on the "client of src/lib" side of,
// structurally like src/app's Server Actions but over MCP instead of
// HTTP/RSC (this is why status-strip.ts lives in src/lib/status/, not
// src/app: this module deliberately never imports anything from src/app).
//
// SDK API note (this story's own first sub-task, per the design
// discussion): the exact @modelcontextprotocol/sdk (v1.30.0) shape was
// confirmed by installing the real package and reading its shipped .d.ts
// files before writing anything below — the low-level `Server` class those
// files mark `@deprecated` in favor of `McpServer`, which is what's used
// here. `McpServer.registerTool()` takes a raw-shape-of-zod-schemas
// `inputSchema` (not hand-written JSON Schema) and the SDK itself converts
// that to the wire-protocol JSON Schema AND validates every incoming
// `tools/call` against it BEFORE this file's handler ever runs — confirmed
// live against the installed package: an invalid `update_gig_status.status`
// value comes back as an `isError: true` tool result with the handler never
// invoked, independent of the try/catch below.
//
// Secret-handling boundary (the story's highest-severity risk): only
// run_scan calls loadConfig() (the resolving reader — real scans need real
// credentials to authenticate against sources). Every other tool that
// touches config, get_status_summary, uses readRawConfig() — the same
// non-resolving, ENOENT-tolerant reader src/app/page.tsx's dashboard uses —
// so a resolved secret value can never cross this process's stdio boundary
// except as whatever a source adapter itself decides to do with it over the
// network (unrelated to this file).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { runRadar } from "../lib/apply/runner.js";
import { loadConfig } from "../lib/config/load.js";
import { resolveLlmCredential } from "../lib/config/env-store.js";
import { readRawConfig } from "../lib/config/save.js";
import { computeStatusStrip } from "../lib/status/status-strip.js";
import { getGig, listGigs, setStatus } from "../lib/store/gigs.js";
import type { GigFilter, GigStatus } from "../lib/store/types.js";
import type { Tier } from "../lib/types.js";

// Registers every built-in source's side-effecting registerSource() call —
// runRadar() only ever looks sources up by id (getSource()), so without
// this run_scan would report "no such registered source" for every
// configured source no matter what's in config.json. Mirrors the exact
// registration step src/lib/apply/runner.ts's CLI entrypoint added (see
// that file's `main()` for the same imports, kept in sync by hand) — but
// UNLIKE that file,
// these are plain top-level imports here, at true module/startup scope, not
// deferred inside a function: runner.ts defers them into main() specifically
// because runner.test.ts imports runRadar() directly and registers its own
// network-free test doubles under the SAME source ids (e.g. "braintrust")
// in that same test process — a top-level import there would collide with
// "duplicate source id". This file has no such collision risk: it's a
// separate, standalone long-lived server process (or, in this file's own
// tests, imported on its own with no competing test-double registrations
// under these ids), and source registration only ever needs to happen ONCE
// per process regardless — startup-once, not per-call, is strictly correct
// here (see this story's design_decisions).
import "../lib/sources/ateam.js";
import "../lib/sources/braintrust.js";
import "../lib/sources/builtin.js";
import "../lib/sources/gofractional.js";
import "../lib/sources/fractionaljobs.js";
import "../lib/sources/fractionus.js";
import "../lib/sources/fractionalfinders.js";
import "../lib/sources/wellfound.js";
import "../lib/sources/linkedin.js";

const SERVER_NAME = "gigradar";
const SERVER_VERSION = "0.9.1";

/**
 * GigStatus (src/lib/store/types.ts) is a compile-time-only TS union with
 * zero runtime representation (see that file: "Store-managed... only the
 * user (via setStatus) or the store itself... sets this") — there is
 * nothing to enumerate at runtime except by duplicating the literal values
 * here, which is exactly what update_gig_status's JSON-schema `status`
 * field (and list_gigs's optional status filter) need in order to reject an
 * invalid value at the MCP tool-input-validation boundary, before
 * setStatus() is ever called. `satisfies readonly GigStatus[]` catches this
 * array being wrong (typo'd or too narrow) at compile time; the
 * `_AssertGigStatusValuesExhaustive` type below (unused at runtime, purely
 * a compile-time trip wire) catches the opposite drift — GigStatus gaining
 * a member this array forgets — the next time anyone edits either file.
 */
export const GIG_STATUS_VALUES = [
  "new",
  "applied",
  "interview",
  "archived",
  "ignored",
] as const satisfies readonly GigStatus[];
type AssertNever<T extends never> = T;
// Compile-time-only exhaustiveness trip wire (no eslint in this repo to
// silence — this type alias is never instantiated, tsc just needs it to
// exist and resolve): see doc comment above.
type _AssertGigStatusValuesExhaustive = AssertNever<Exclude<GigStatus, (typeof GIG_STATUS_VALUES)[number]>>;

/** Same rationale as GIG_STATUS_VALUES above, for Tier (src/lib/types.ts) — used by list_gigs's optional tier filter. */
export const GIG_TIER_VALUES = ["green", "yellow", "red"] as const satisfies readonly Tier[];
// Compile-time-only exhaustiveness trip wire, mirrors GigStatus's above.
type _AssertTierValuesExhaustive = AssertNever<Exclude<Tier, (typeof GIG_TIER_VALUES)[number]>>;

/** Successful tool result: JSON-serializes `data` into the single text content block every tool here returns. */
function toolOk(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Error boundary's shared shape: every tool handler below funnels its catch
 * block through this, so a thrown src/lib error (missing config, unknown
 * gig key, a source's network error, ...) always becomes a clean MCP
 * `isError: true` tool result — never an uncaught exception that could
 * crash the stdio process. Only `e.message` is surfaced (never the raw
 * value/object thrown) — matches this codebase's existing convention
 * (e.g. src/lib/config/load.ts's own error messages) of naming what went
 * wrong without ever including a resolved secret.
 */
function toolError(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export interface ListGigsArgs {
  tier?: Tier;
  status?: GigStatus;
  search?: string;
}

/**
 * Wraps listGigs() (src/lib/store/gigs.ts). `status` is passed straight
 * through to listGigs()'s own GigFilter (server-side, in the SQL WHERE
 * clause) since that's a filter the store already supports natively.
 * `tier` and `search` have no store-side equivalent (GigFilter has neither
 * field — see its doc comment) so, exactly like the dashboard's own
 * client-side filtering (src/app/dashboard-filter.ts, a src/app-only module
 * this file deliberately never imports — see this file's header comment on
 * why), they're applied here, in-memory, over listGigs()'s already-fetched
 * result. `search` matches dashboard-filter.ts's own semantics
 * byte-for-byte (case-insensitive substring over `${title} ${company}`) —
 * reimplemented rather than imported, since importing it would be exactly
 * the src/mcp -> src/app sideways dependency this story avoided for
 * status-strip.ts (grill finding H2).
 */
export async function handleListGigs(args: ListGigsArgs): Promise<CallToolResult> {
  try {
    const filter: GigFilter = {};
    if (args.status) filter.status = args.status;
    let gigs = listGigs(filter);
    if (args.tier) gigs = gigs.filter((g) => g.tier === args.tier);
    const term = args.search?.trim().toLowerCase();
    if (term) gigs = gigs.filter((g) => `${g.title} ${g.company ?? ""}`.toLowerCase().includes(term));
    return toolOk(gigs);
  } catch (e) {
    return toolError(e);
  }
}

export interface GetGigArgs {
  key: string;
}

/** Wraps getGig() (src/lib/store/gigs.ts). A missing key is a clean tool error, not a thrown exception or a bare `undefined`. */
export async function handleGetGig(args: GetGigArgs): Promise<CallToolResult> {
  try {
    const gig = getGig(args.key);
    if (!gig) return toolError(new Error(`get_gig: no gig found with key "${args.key}"`));
    return toolOk(gig);
  } catch (e) {
    return toolError(e);
  }
}

export interface UpdateGigStatusArgs {
  key: string;
  status: GigStatus;
}

/**
 * Wraps setStatus() (src/lib/store/gigs.ts). `status`'s invalid-value
 * rejection happens BEFORE this function ever runs — see the `status: z.enum(...)`
 * tool schema in createServer() below and this file's header comment on
 * the SDK confirming that validation order live. setStatus() itself throws
 * on an unknown key (see its doc comment) — caught here like every other
 * src/lib call.
 */
export async function handleUpdateGigStatus(args: UpdateGigStatusArgs): Promise<CallToolResult> {
  try {
    setStatus(args.key, args.status);
    const gig = getGig(args.key);
    return toolOk(gig);
  } catch (e) {
    return toolError(e);
  }
}

/**
 * Sources configured / profile complete / last scan time — wraps the
 * relocated computeStatusStrip() (src/lib/status/status-strip.ts), fed by
 * readRawConfig() (src/lib/config/save.ts) and listGigs(), EXACTLY like
 * src/app/page.tsx's dashboard. Deliberately readRawConfig(), never
 * loadConfig(): this tool only ever needs presence/shape/count information,
 * never a resolved secret value — the single highest-severity risk this
 * story names. readRawConfig() is also ENOENT-tolerant (`{}` on first run,
 * no config.json yet), so this tool never throws on "no config configured
 * yet" the way run_scan's loadConfig() does.
 */
export async function handleGetStatusSummary(): Promise<CallToolResult> {
  try {
    const gigs = listGigs();
    const rawConfig = readRawConfig();
    const status = computeStatusStrip(gigs, rawConfig);
    return toolOk(status);
  } catch (e) {
    return toolError(e);
  }
}

/**
 * Wraps runRadar(loadConfig()) (src/lib/apply/runner.ts) — the ONE tool
 * allowed to call loadConfig() (the resolving reader), since a real scan
 * genuinely needs resolved secrets to authenticate against sources. Its
 * result summary is counts and per-source `{sourceId, message}` error
 * strings ONLY (runRadar()'s own return shape) — never a resolved secret,
 * matching this story's explicit requirement. loadConfig() throwing (no
 * config.json yet) is caught exactly like every other tool's src/lib call —
 * a clean tool error, not a crashed process; a subsequent tool call on this
 * same server works fine afterward (see this story's acceptance criteria).
 */
export async function handleRunScan(): Promise<CallToolResult> {
  try {
    const config = loadConfig();
    const { passed, errors } = await runRadar(config, {}, { credential: resolveLlmCredential() });
    return toolOk({ passedCount: passed.length, errors });
  } catch (e) {
    return toolError(e);
  }
}

/**
 * Builds the MCP server and registers all 5 tools. Exported (rather than
 * only constructed inside main()) so tests can connect it to an
 * InMemoryTransport-backed Client and exercise the real tool-registration /
 * input-validation path — not just call the handleXxx() functions above
 * directly — without spawning a real stdio subprocess.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "list_gigs",
    {
      description:
        "List tracked gigs, optionally filtered by role-area tier, pipeline status, and/or a case-insensitive text search over title+company. Returns the same gig objects the dashboard shows, each including its opaque `key` (pass that to get_gig / update_gig_status).",
      inputSchema: {
        tier: z.enum(GIG_TIER_VALUES).optional().describe("Role-area filter: green, yellow, or red. Omit to include every tier."),
        status: z
          .enum(GIG_STATUS_VALUES)
          .optional()
          .describe("Pipeline-status filter. Omit to include every status."),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring search over the gig's title and company. Omit for no text filter."),
      },
    },
    (args) => handleListGigs(args),
  );

  server.registerTool(
    "get_gig",
    {
      description: "Fetch a single tracked gig by its key.",
      inputSchema: {
        key: z
          .string()
          .describe(
            "The opaque `key` field from list_gigs's output, identifying one specific gig. Always copy this value verbatim from a prior list_gigs call's result — never construct it yourself.",
          ),
      },
    },
    (args) => handleGetGig(args),
  );

  server.registerTool(
    "update_gig_status",
    {
      description: "Set a tracked gig's pipeline status (e.g. mark it 'applied' after you apply).",
      inputSchema: {
        key: z
          .string()
          .describe(
            "The opaque `key` field from list_gigs's output, identifying one specific gig. Always copy this value verbatim from a prior list_gigs call's result — never construct it yourself.",
          ),
        status: z
          .enum(GIG_STATUS_VALUES)
          .describe(`The new status. Must be exactly one of: ${GIG_STATUS_VALUES.join(", ")}.`),
      },
    },
    (args) => handleUpdateGigStatus(args),
  );

  server.registerTool(
    "get_status_summary",
    {
      description:
        "A glance-level dashboard status: how many sources are configured (and how many need attention), whether the profile is complete, and when the last scan ran. Never includes a resolved secret value — presence/shape/count information only.",
    },
    () => handleGetStatusSummary(),
  );

  server.registerTool(
    "run_scan",
    {
      description:
        "Runs one radar scan across every enabled, configured source: fetches current listings, gates them against your needs, tiers them by role-area fit, and persists the results. Slow and network-bound (it makes real HTTP requests to every enabled source) — don't call it repeatedly in a tight loop. Returns a passed-count and any per-source errors, never a secret value.",
    },
    () => handleRunScan(),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when invoked directly (`npm run mcp`), not when imported by
// tests that just need createServer()/handleXxx() — mirrors
// src/lib/apply/runner.ts's identical process.argv[1] guard around its own
// main().
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main().catch((e) => {
    console.error("gigradar mcp: fatal error starting server:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
