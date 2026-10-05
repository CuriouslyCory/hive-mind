import { describe, expect, it } from "vitest";
import { trackerCliAllowed, trackerPageEnabled } from "../src/gate.ts";

describe("trackerPageEnabled", () => {
  it("allows next dev on a loopback host", () => {
    for (const host of [
      "localhost",
      "localhost:3000",
      "127.0.0.1",
      "127.0.0.1:3000",
      "[::1]",
      "[::1]:3000",
    ]) {
      expect(trackerPageEnabled("development", host, undefined), host).toBe(true);
    }
    expect(trackerPageEnabled("development", "localhost:3000", "development")).toBe(true);
  });

  it("refuses other environments", () => {
    for (const nodeEnv of ["production", "test", undefined]) {
      expect(trackerPageEnabled(nodeEnv, "localhost:3000", undefined), String(nodeEnv)).toBe(false);
    }
    for (const vercelEnv of ["production", "preview", ""]) {
      expect(trackerPageEnabled("development", "localhost:3000", vercelEnv), vercelEnv).toBe(false);
    }
  });

  it("refuses hosts that are not exactly a loopback address", () => {
    for (const host of [
      null,
      undefined,
      "",
      "hivemind.curiouslycory.com",
      "localhost.example.com",
      "evil.com:3000@localhost",
      "localhost:3000.example.com",
      "localhost:",
      "127.0.0.2",
      "0.0.0.0:3000",
      "192.168.1.10:3000",
      "::1",
      "LOCALHOST",
    ]) {
      expect(trackerPageEnabled("development", host, undefined), String(host)).toBe(false);
    }
  });
});

describe("trackerCliAllowed", () => {
  it("refuses Vercel production and preview only", () => {
    expect(trackerCliAllowed("production")).toBe(false);
    expect(trackerCliAllowed("preview")).toBe(false);
    expect(trackerCliAllowed("development")).toBe(true);
    expect(trackerCliAllowed(undefined)).toBe(true);
  });
});
