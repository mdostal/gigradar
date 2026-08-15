import { isPortunusAvailable } from "@/lib/auth/session-backend";
import { ConfigSchema } from "@/lib/config/schema";
import { readRawConfig } from "@/lib/config/save";
import type { Config } from "@/lib/types";
import { ConfigClient } from "./config-client";

/**
 * The blank/empty-shaped starting document for first-run setup — never
 * written to disk on its own (the user has to actually submit the form),
 * just what pre-populates the form's controlled inputs. `roleArea` and
 * `schedule` are deliberately absent (not `{}`/`""`), matching their
 * documented "omitted is valid" semantics (src/lib/types.ts) — the form
 * itself renders those sections as disabled/off by default rather than
 * enabled-but-empty.
 */
function blankConfig(): Config {
  return {
    profile: { name: "", roles: [], skills: [], timezone: "" },
    needs: {
      engagementProfiles: [],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [],
  };
}

/**
 * The config-editing UI (`config-editing-ui` story). A Server Component that
 * pre-populates the form by reading config.json RAW — via `readRawConfig()`
 * (config-write-path's `save.ts`) — never via `loadConfig()`
 * (src/lib/config/load.ts), which resolves "env:" references to real secret
 * values. `ConfigSchema.safeParse()` below is pure structural validation
 * (the same schema `saveConfig()` itself validates against before writing);
 * it never reads `process.env` or resolves anything, so any `"env:VAR_NAME"`
 * string in the raw document comes through to the form completely
 * unchanged, exactly as it appears on disk.
 *
 * First-run handling: `readRawConfig()` is ENOENT-tolerant (resolves to
 * `{}` when no config.json exists yet), so `configExists` is false and
 * `ConfigSchema.safeParse({})` naturally fails (an object missing required
 * `profile`/`needs`/`sources`) — in that case (and the defensive case where
 * an existing file fails validation for some other reason) the form falls
 * back to `blankConfig()` rather than rendering an error page.
 */
export default async function ConfigPage() {
  const raw = readRawConfig();
  const configExists = Object.keys(raw).length > 0;
  const parsed = ConfigSchema.safeParse(raw);
  const initial: Config = parsed.success ? parsed.data : blankConfig();

  // Real, live `portunus --version` check (oauth-session-capture-v2 epic,
  // portunus-session-backend story) — the Settings editor's backend picker
  // is shown ONLY when this is true, hidden (not just disabled) otherwise.
  // See session-backend.ts's own doc comment on why "hidden" is the correct
  // posture for OSS users without Portunus installed.
  const portunusAvailable = await isPortunusAvailable();

  let subtitle: string;
  if (!configExists) {
    subtitle = "No config.json found yet — fill in the form below to create one (first-run setup).";
  } else if (parsed.success) {
    subtitle = "Editing your existing config.json.";
  } else {
    subtitle =
      "An existing config.json failed validation, so a blank form is shown below — saving will overwrite the invalid file once the form itself validates.";
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Configure gigradar</h1>
      <p className="text-sm text-slate-500">{subtitle}</p>
      <ConfigClient initial={initial} portunusAvailable={portunusAvailable} />
    </main>
  );
}
