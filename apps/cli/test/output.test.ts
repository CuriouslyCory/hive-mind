import { anyCliEnvelopeSchema } from "@hivemind/contract";
import { afterEach, describe, expect, it } from "vitest";
import { errorEnvelopeFor, escapeTerminal, writeSuccess } from "../src/output.ts";
import { clearRegisteredSecrets, redact, registerSecret } from "../src/redact.ts";
import { HOSTILE } from "./fixtures/test-commands.ts";

afterEach(() => clearRegisteredSecrets());

describe("escapeTerminal", () => {
  it("makes every control character visible", () => {
    expect(escapeTerminal(HOSTILE)).toBe("name\\x1b]0;pwned\\x07\\x1b[2J\\r\\nforged line\\u202e");
    expect(escapeTerminal("tab\there\u0000\u007f\u009b")).toBe("tab\\there\\x00\\x7f\\x9b");
    expect(escapeTerminal(" ⁦")).toBe("\\u2028\\u2066");
  });

  it("leaves ordinary text, including non-ASCII, unchanged", () => {
    const text = 'Projekt Bücher – 日本語 🐝 "quoted" \\ back';
    expect(escapeTerminal(text)).toBe(text);
  });

  it("leaves no raw control character behind", () => {
    let all = "";
    for (let code = 0; code < 0x2100; code++) all += String.fromCharCode(code);
    const escaped = escapeTerminal(all);
    for (const char of escaped) {
      const code = char.charCodeAt(0);
      expect(
        code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e),
      ).toBe(false);
    }
  });
});

describe("redact", () => {
  it("replaces registered secrets and bearer/authorization shapes", () => {
    registerSecret("hm_registered_secret_value");
    expect(redact("token hm_registered_secret_value leaked")).toBe("token [REDACTED] leaked");
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: [REDACTED]");
    expect(redact('{"authorization":"xyz"}')).toBe('{"authorization":"[REDACTED]"}');
    expect(redact("sent bearer xyz123 to server")).toBe("sent bearer [REDACTED] to server");
  });

  it("ignores values too short to be tokens", () => {
    registerSecret("abc");
    expect(redact("abc")).toBe("abc");
  });
});

describe("--json output", () => {
  it("escapes C1 controls, line separators and bidi controls, and parses to the same data", () => {
    const unsafe = [0x00, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066]
      .map((code) => String.fromCharCode(code))
      .join("");
    const safe = "\u00a0Bücher\u2027\u202f\u2065\u206a 日本 🐝";
    const data = { name: `${HOSTILE}\u009b31m`, unsafe, safe, [`key\u202e`]: ["\u2066x\u2069"] };
    let line = "";
    writeSuccess(
      {
        write: (chunk: string) => {
          line += chunk;
        },
      },
      { json: true, command: "whoami", data, human: [] },
    );
    expect(line.endsWith("\n")).toBe(true);
    const raw = line
      .slice(0, -1)
      .match(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g);
    expect(raw).toBeNull();
    expect(line).toContain(safe);
    expect(line).toContain("\\u009b31m");
    expect(JSON.parse(line)).toEqual({ schemaVersion: 1, command: "whoami", ok: true, data });
  });
});

describe("errorEnvelopeFor", () => {
  it("builds a schema-valid envelope with the hint folded into the message", () => {
    registerSecret("hm_registered_secret_value");
    const envelope = errorEnvelopeFor("whoami", {
      code: "UNAUTHORIZED",
      message: "rejected hm_registered_secret_value",
      hint: "Run 'hivemind login'.",
    });
    expect(anyCliEnvelopeSchema.parse(envelope)).toEqual({
      schemaVersion: 1,
      command: "whoami",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "rejected [REDACTED] Run 'hivemind login'." },
    });
  });

  it("caps the message at the schema's 4096 characters", () => {
    const envelope = errorEnvelopeFor("whoami", { code: "X", message: "x".repeat(10_000) });
    expect(anyCliEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});
