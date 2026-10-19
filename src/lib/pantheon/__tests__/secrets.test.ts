import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PantheonSecretError, injectSecret, parseEnvLine, parseSecretMappings, resolveRunSecrets, withInjectedEnv } from "../secrets.js";

const SECRET = "sk-test-value-that-must-never-leak";
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-pantheon-secrets-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for core-api's facade: writes `KEY=value` where the request asked, like Portunus does. */
function facade(values: Record<string, string>, status = 200) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tags: string; path: string; key: string };
    if (status === 200 && values[body.tags] !== undefined) fs.writeFileSync(body.path, `${body.key}=${values[body.tags]}\n`);
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
  });
}

describe("injectSecret", () => {
  it("asks core-api's facade for a file inject on the shared volume, reads the value, and deletes the file", async () => {
    const fetchImpl = facade({ "provider=anthropic,kind=api-key": SECRET });
    const value = await injectSecret("provider=anthropic,kind=api-key", "ANTHROPIC_API_KEY", {
      coreApiUrl: "http://core-api:3012/",
      sharedSecretsDir: dir,
      fetchImpl,
      generateId: () => "fixed",
    });
    expect(value).toBe(SECRET);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://core-api:3012/api/secrets/inject");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tags: "provider=anthropic,kind=api-key",
      target: "file",
      path: path.join(dir, "gigradar-fixed.env"),
      format: "env",
      key: "ANTHROPIC_API_KEY",
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("defaults to PANTHEON_CORE_API_URL and PANTHEON_SECRETS_SHARED_DIR", async () => {
    const fetchImpl = facade({ t: SECRET });
    await injectSecret("t", "K", { fetchImpl, env: env({ PANTHEON_CORE_API_URL: "http://elsewhere:1", PANTHEON_SECRETS_SHARED_DIR: dir }) });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://elsewhere:1/api/secrets/inject");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).path.startsWith(dir + path.sep)).toBe(true);
  });

  it("throws on a facade error, naming the selector and status but never a value", async () => {
    const err = await injectSecret("provider=x", "K", { sharedSecretsDir: dir, fetchImpl: facade({}, 502) }).catch((e) => e);
    expect(err).toBeInstanceOf(PantheonSecretError);
    expect(err.message).toBe('pantheon secrets: inject for tags "provider=x" failed (HTTP 502)');
  });

  it("throws when the facade answers ok but wrote no file, rather than returning an empty credential", async () => {
    await expect(injectSecret("unknown", "K", { sharedSecretsDir: dir, fetchImpl: facade({}) })).rejects.toThrow(/not readable/);
  });

  it("throws when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(injectSecret("t", "K", { sharedSecretsDir: dir, fetchImpl })).rejects.toThrow(/could not reach core-api: fetch failed/);
  });
});

describe("parseEnvLine", () => {
  it("reads the named key, tolerating export and quotes", () => {
    expect(parseEnvLine('OTHER=1\nexport K="v a l"\n', "K")).toBe("v a l");
    expect(parseEnvLine("K=\n", "K")).toBeUndefined();
  });
});

describe("parseSecretMappings / resolveRunSecrets", () => {
  it("splits each entry on its first '=' so a selector can carry '=' and ','", () => {
    expect(parseSecretMappings(" ANTHROPIC_API_KEY=provider=anthropic,kind=api-key ; BT_KEY=provider=braintrust ;")).toEqual([
      { varName: "ANTHROPIC_API_KEY", tags: "provider=anthropic,kind=api-key" },
      { varName: "BT_KEY", tags: "provider=braintrust" },
    ]);
    expect(parseSecretMappings(undefined)).toEqual([]);
  });

  it("rejects a malformed entry instead of silently dropping it", () => {
    expect(() => parseSecretMappings("no-equals")).toThrow(PantheonSecretError);
    expect(() => parseSecretMappings("BAD NAME=x")).toThrow(PantheonSecretError);
  });

  it("resolves every mapped var through the facade", async () => {
    const fetchImpl = facade({ "provider=a": "one", "provider=b": "two" });
    const resolved = await resolveRunSecrets({
      fetchImpl,
      sharedSecretsDir: dir,
      env: env({ GIGRADAR_PANTHEON_SECRETS: "A_KEY=provider=a;B_KEY=provider=b" }),
    });
    expect(resolved).toEqual({ A_KEY: "one", B_KEY: "two" });
  });

  it("makes no facade call at all when nothing is mapped", async () => {
    const fetchImpl = vi.fn();
    expect(await resolveRunSecrets({ fetchImpl, env: env({}) })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("withInjectedEnv", () => {
  it("overlays process.env only for the call, then restores set and unset vars exactly", () => {
    process.env.GIGRADAR_TEST_PRESET = "from-dotenv";
    delete process.env.GIGRADAR_TEST_ABSENT;
    const seen = withInjectedEnv({ GIGRADAR_TEST_PRESET: "facade", GIGRADAR_TEST_ABSENT: "facade2" }, () => [
      process.env.GIGRADAR_TEST_PRESET,
      process.env.GIGRADAR_TEST_ABSENT,
    ]);
    expect(seen).toEqual(["facade", "facade2"]);
    expect(process.env.GIGRADAR_TEST_PRESET).toBe("from-dotenv");
    expect("GIGRADAR_TEST_ABSENT" in process.env).toBe(false);
    delete process.env.GIGRADAR_TEST_PRESET;
  });

  it("restores even when the call throws", () => {
    expect(() =>
      withInjectedEnv({ GIGRADAR_TEST_THROW: "x" }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect("GIGRADAR_TEST_THROW" in process.env).toBe(false);
  });
});
