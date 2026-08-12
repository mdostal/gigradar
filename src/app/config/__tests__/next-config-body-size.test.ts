// `resume-link-ui` story, AC: "the default 1MB [Server Action body] limit is
// too small for a real resume PDF" — next.config.js needed
// experimental.serverActions.bodySizeLimit raised. Imports the real
// next.config.js module directly (never invokes its `webpack()` function —
// that requires a real webpack `config` object this test doesn't construct)
// so a future accidental revert of this setting fails a test, not just a
// live-browser upload.
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/no-relative-parent-imports -- next.config.js lives at the repo root, outside src/
import nextConfig from "../../../../next.config.js";

function parseSizeToBytes(limit: string | number): number {
  if (typeof limit === "number") return limit;
  const match = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) throw new Error(`test helper: could not parse size string "${limit}"`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }[unit] ?? 1;
  return value * multiplier;
}

describe("next.config.js: Server Action body size limit raised for resume uploads", () => {
  it("sets experimental.serverActions.bodySizeLimit above Next's 1MB default", () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;
    expect(limit).toBeDefined();
    expect(parseSizeToBytes(limit as string | number)).toBeGreaterThan(1024 * 1024);
  });

  it("comfortably covers a realistic resume PDF (a few MB)", () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit as string | number;
    expect(parseSizeToBytes(limit)).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });
});
