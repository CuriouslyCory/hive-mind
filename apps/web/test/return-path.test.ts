import { describe, expect, it } from "vitest";
import { safeReturnPath, signInPath } from "../src/lib/return-path";

describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/device", "/device"],
    ["/device?user_code=ABCD-EFGH", "/device?user_code=ABCD-EFGH"],
    ["/device?user_code=x#fragment", "/device?user_code=x"],
    ["/projects/abc", "/projects/abc"],
    // Dot segments resolve before the checks, so they cannot hide a path.
    ["/device/../settings", "/settings"],
  ])("keeps %s as %s", (input, path) => {
    expect(safeReturnPath(input)).toBe(path);
  });

  it.each([
    undefined,
    42,
    ["/device"],
    "",
    "device",
    "https://evil.example/device",
    "//evil.example/device",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/device\n//evil.example",
    "/device\t",
    " /device",
    "javascript:alert(1)",
    "/sign-in",
    "/sign-in?returnTo=/device",
    "/api/auth/sign-out",
    "/device/../api/auth/ok",
    `/device?user_code=${"A".repeat(600)}`,
  ])("refuses %j", (input) => {
    expect(safeReturnPath(input)).toBeNull();
  });
});

describe("signInPath", () => {
  it("carries a safe return path", () => {
    expect(signInPath("/device?user_code=ABCDEFGH")).toBe(
      "/sign-in?returnTo=%2Fdevice%3Fuser_code%3DABCDEFGH",
    );
  });

  it("is plain /sign-in for the home page or an unsafe path", () => {
    expect(signInPath("/")).toBe("/sign-in");
    expect(signInPath("//evil.example")).toBe("/sign-in");
  });
});
