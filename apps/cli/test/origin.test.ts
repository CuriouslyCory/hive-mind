import { describe, expect, it } from "vitest";
import { PRODUCTION_ORIGIN } from "../src/build-info.ts";
import { CliError } from "../src/errors.ts";
import { checkOrigin, resolveOrigin } from "../src/origin.ts";

describe("checkOrigin", () => {
  it.each([
    ["https://hive.example", "https://hive.example"],
    ["https://hive.example/", "https://hive.example"],
    ["HTTPS://Hive.EXAMPLE", "https://hive.example"],
    ["https://hive.example:443", "https://hive.example"],
    ["https://hive.example:8443", "https://hive.example:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://LOCALHOST:80", "http://localhost"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    [PRODUCTION_ORIGIN, PRODUCTION_ORIGIN],
  ])("normalizes %s", (input, expected) => {
    expect(checkOrigin(input)).toEqual({ ok: true, origin: expected });
  });

  it.each([
    ["hive.example", "absolute URL"],
    ["ftp://hive.example", "only https"],
    ["http://hive.example", "plain http"],
    ["http://127.0.0.2:3000", "plain http"],
    ["http://foo.localhost:3000", "plain http"],
    ["https://user@hive.example", "user name"],
    ["https://user:pw@hive.example", "user name"],
    ["https://@hive.example", "user name"],
    ["https://hive.example/api", "path"],
    ["https://hive.example//", "path"],
    ["https://hive.example?", "query"],
    ["https://hive.example/?a=1", "query"],
    ["https://hive.example#", "fragment"],
    ["https://hive.example.", "dot"],
    [" https://hive.example", "whitespace"],
    ["https://hive.example\n", "whitespace"],
    ["https://hive\t.example", "whitespace"],
    ["https:\\\\hive.example", "backslash"],
    ["", "absolute URL"],
  ])("rejects %j", (input, reason) => {
    const result = checkOrigin(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("resolveOrigin", () => {
  const env = { HIVEMIND_URL: "https://env.example" };

  it("prefers --server, then HIVEMIND_URL, then the default", () => {
    expect(resolveOrigin({ flag: "https://Flag.example:443/", env })).toEqual({
      origin: "https://flag.example",
      source: "flag",
    });
    expect(resolveOrigin({ env })).toEqual({ origin: "https://env.example", source: "env" });
    expect(resolveOrigin({ env: { HIVEMIND_URL: "" } })).toEqual({
      origin: PRODUCTION_ORIGIN,
      source: "default",
    });
    expect(resolveOrigin({ env: {}, defaultOrigin: "http://localhost:3000" })).toEqual({
      origin: "http://localhost:3000",
      source: "default",
    });
  });

  it("fails on an invalid value instead of falling through, without echoing it", () => {
    const secretish = "https://hm_token_value@hive.example";
    for (const attempt of [
      () => resolveOrigin({ flag: secretish, env }),
      () => resolveOrigin({ env: { HIVEMIND_URL: secretish } }),
    ]) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("INVALID_SERVER");
      expect((thrown as CliError).exitCode).toBe(1);
      expect((thrown as CliError).message).not.toContain("hm_token_value");
    }
  });
});
