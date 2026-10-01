import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  creationFingerprint,
  FingerprintInputTooLargeError,
  MAX_FINGERPRINT_INPUT_BYTES,
} from "../src/fingerprint.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and omits undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: "x" }, e: undefined })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}',
    );
  });

  it("rejects numbers JSON cannot represent", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("creationFingerprint", () => {
  it("is a sha256 hex digest independent of key order", () => {
    const fingerprint = creationFingerprint({ title: "Ship", body: "" });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(creationFingerprint({ body: "", title: "Ship" })).toBe(fingerprint);
    expect(creationFingerprint({ body: "", title: "Ship!" })).not.toBe(fingerprint);
  });

  it("rejects inputs over the bound", () => {
    const fits = "x".repeat(MAX_FINGERPRINT_INPUT_BYTES - 2);
    expect(creationFingerprint(fits)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => creationFingerprint(`${fits}x`)).toThrow(FingerprintInputTooLargeError);
  });
});
