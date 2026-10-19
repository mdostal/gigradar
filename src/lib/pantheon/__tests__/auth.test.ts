import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorize, getOperatorToken, resetOperatorTokenCache, type AuthDeps } from "../auth.js";

const TOKEN = "operator-token-value";
const quiet = { warn: vi.fn() };

function deps(readFile: () => Promise<string>, overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
    readFile,
    deleteFile: async () => {},
    sharedSecretsDir: "/pantheon-secrets",
    logger: quiet,
    ...overrides,
  };
}

beforeEach(() => {
  resetOperatorTokenCache();
  quiet.warn.mockReset();
});

describe("authorize", () => {
  it("accepts the operator token the facade resolves", async () => {
    expect(await authorize(TOKEN, deps(async () => `PANTHEON_OPERATOR_TOKEN=${TOKEN}\n`))).toEqual({ ok: true });
  });

  it("asks the facade with Pantheon's own operator-token selector", async () => {
    const d = deps(async () => `PANTHEON_OPERATOR_TOKEN=${TOKEN}\n`);
    await authorize(TOKEN, d);
    const body = JSON.parse(String((d.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body));
    expect(body).toMatchObject({ tags: "provider=pantheon,kind=operator-token", target: "file", format: "env", key: "PANTHEON_OPERATOR_TOKEN" });
  });

  it("401s a missing or wrong token", async () => {
    const d = deps(async () => `PANTHEON_OPERATOR_TOKEN=${TOKEN}\n`);
    expect(await authorize(null, d)).toMatchObject({ ok: false, status: 401 });
    expect(await authorize("wrong", d)).toMatchObject({ ok: false, status: 401 });
    expect(await authorize(`${TOKEN}x`, d)).toMatchObject({ ok: false, status: 401 });
  });

  it("fails closed (503) when the token has never resolved — never lets a request through unauthenticated", async () => {
    const d = deps(async () => "", { fetchImpl: vi.fn(async () => new Response("{}", { status: 502 })) });
    expect(await authorize(TOKEN, d)).toMatchObject({ ok: false, status: 503 });
    expect(await authorize(undefined, d)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("getOperatorToken", () => {
  it("caches for a minute, then keeps the last good token when a refresh fails", async () => {
    let now = 0;
    let readFile = async () => `PANTHEON_OPERATOR_TOKEN=${TOKEN}\n`;
    const d = deps(() => readFile(), { now: () => now });
    expect(await getOperatorToken(d)).toBe(TOKEN);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);

    now = 30_000;
    await getOperatorToken(d);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);

    now = 61_000;
    readFile = async () => "";
    expect(await getOperatorToken(d)).toBe(TOKEN);
    expect(d.fetchImpl).toHaveBeenCalledTimes(2);
    expect(quiet.warn).toHaveBeenCalledOnce();
  });

  it("picks up a rotated token on refresh", async () => {
    let now = 0;
    let value = TOKEN;
    const d = deps(async () => `PANTHEON_OPERATOR_TOKEN=${value}\n`, { now: () => now });
    await getOperatorToken(d);
    value = "rotated";
    now = 61_000;
    expect(await getOperatorToken(d)).toBe("rotated");
  });
});
