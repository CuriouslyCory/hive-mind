import { anyCliEnvelopeSchema } from "@hivemind/contract";
import { describe, expect, it } from "vitest";
import { commandHelp, validateRegistry } from "../src/cli.ts";
import type { CommandDefinition } from "../src/command.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { HOSTILE, TEST_COMMANDS } from "./fixtures/test-commands.ts";
import { onlyJsonLine, runShell } from "./helpers/shell.ts";

const envelope = (stdout: string) => anyCliEnvelopeSchema.parse(onlyJsonLine(stdout));

describe("registry", () => {
  it("has no ambiguous names or flags, in the shipped and the test registry", () => {
    expect(validateRegistry(COMMANDS)).toEqual([]);
    expect(validateRegistry(TEST_COMMANDS)).toEqual([]);
  });

  it("reports shadowed globals, duplicate shorts and command/group clashes", () => {
    const run: CommandDefinition["run"] = async () => ({ data: null, human: [] });
    const bad: CommandDefinition[] = [
      { name: "key", summary: "", run },
      {
        name: "key create",
        summary: "",
        run,
        options: { json: { type: "boolean", description: "" } },
      },
      {
        name: "a",
        summary: "",
        run,
        options: { x: { type: "boolean", short: "h", description: "" } },
      },
      { name: "Bad_Name", summary: "", run },
    ];
    expect(validateRegistry(bad)).toEqual([
      "key create: --json shadows a global flag",
      "a: -h is used twice",
      "Bad_Name: invalid name",
      "key: is also a command group",
    ]);
  });
});

describe("dispatch and parsing", () => {
  it("runs a command with options and positionals, globals anywhere", async () => {
    for (const argv of [
      ["echo", "hi", "--shout"],
      ["--json", "echo", "--shout", "hi"],
      ["echo", "hi", "--shout", "--json"],
      ["--server", "https://x.example", "echo", "--shout", "hi"],
    ]) {
      const result = await runShell(argv);
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.stderr).toBe("working...\n");
      if (argv.includes("--json")) {
        expect(envelope(result.stdout)).toEqual({
          schemaVersion: 1,
          command: "echo",
          ok: true,
          data: { text: "HI" },
        });
      } else expect(result.stdout).toBe("text: HI\n");
    }
  });

  it("matches multi-word commands", async () => {
    const result = await runShell(["config", "write", "--json", "not-a-uuid"]);
    expect(envelope(result.stdout)).toMatchObject({
      command: "config write",
      ok: false,
      error: { code: "USAGE_ERROR" },
    });
  });

  it("explains a group without a subcommand", async () => {
    const result = await runShell(["cred"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("'hivemind cred' needs a subcommand: save, source, remove.");
    const help = await runShell(["cred", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: hivemind cred <command>");
  });

  it("prints overview help with no arguments and command help with --help", async () => {
    const overview = await runShell([]);
    expect(overview.code).toBe(0);
    expect(overview.stdout).toContain("Usage:\n  hivemind <command> [options]");
    expect(overview.stdout).toContain("echo");
    const help = await runShell(["echo", "--help"]);
    expect(help.stdout).toBe(commandHelp(TEST_COMMANDS[0] as CommandDefinition));
    expect(help.stdout).toContain("Usage: hivemind echo <text> [options]");
    expect(help.stdout).toContain("--shout");
    expect(help.stdout).toContain("hivemind echo hello");
    const json = await runShell(["-h", "--json"]);
    expect(envelope(json.stdout)).toMatchObject({ command: "help", ok: true });
  });

  it("prints the version, as an envelope under --json", async () => {
    expect((await runShell(["--version"])).stdout).toMatch(/^hivemind \S+ \(\S+, \S+\)\n$/);
    expect(envelope((await runShell(["--version", "--json"])).stdout)).toMatchObject({
      command: "version",
      data: { version: expect.any(String), commit: expect.any(String), target: expect.any(String) },
    });
  });

  it("never echoes an unknown option's value or an unsafe unknown command", async () => {
    for (const argv of [
      ["echo", "x", "--token=hm_secret_value"],
      ["hm_secret_value"],
      ["--json", "Bearer hm_secret_value"],
    ]) {
      const result = await runShell(argv);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("hm_secret_value");
    }
    const option = await runShell(["echo", "x", "--token=hm_secret_value"]);
    expect(option.stderr).toContain("Unknown option '--token'.");
    const command = await runShell(["--json", "logn"]);
    expect(envelope(command.stdout)).toMatchObject({
      command: "hivemind",
      error: { code: "USAGE_ERROR", message: expect.stringContaining("'logn'") },
    });
  });

  it("checks positional counts and option values", async () => {
    expect((await runShell(["echo"])).stderr).toContain("Missing <text>.");
    expect((await runShell(["echo", "a", "b"])).stderr).toContain("Too many arguments.");
    expect((await runShell(["origin", "--server"])).stderr).toContain(
      "Option --server is missing its value",
    );
    expect((await runShell(["echo", "a", "--shout=yes"])).code).toBe(1);
  });
});

describe("output contract", () => {
  it("maps error codes to exit codes, with exactly one JSON object on stdout", async () => {
    const cases: [string, number][] = [
      ["BAD_REQUEST", 1],
      ["CONFLICT", 2],
      ["UNAUTHORIZED", 3],
      ["FORBIDDEN", 3],
      ["NOT_FOUND", 4],
      ["CONFIG_INVALID", 1],
      ["SOMETHING_NEW", 1],
    ];
    for (const [code, exit] of cases) {
      const json = await runShell(["fail", code, "--json"]);
      expect(json.code).toBe(exit);
      expect(json.stderr).toBe("");
      expect(envelope(json.stdout)).toMatchObject({ command: "fail", ok: false, error: { code } });
      const human = await runShell(["fail", code]);
      expect(human.code).toBe(exit);
      expect(human.stdout).toBe("");
      expect(human.stderr).toMatch(/^hivemind: failed with /);
      expect(human.stderr).toContain("\n  Try again.\n");
    }
  });

  it("escapes control characters in human output, stderr and errors", async () => {
    const human = await runShell(["hostile"]);
    expect(human.stdout).toBe("Project name\\x1b]0;pwned\\x07\\x1b[2J\\r\\nforged line\\u202e\n");
    expect(human.stderr).toBe("progress name\\x1b]0;pwned\\x07\\x1b[2J\\r\\nforged line\\u202e\n");
    const failure = await runShell(["fail", "X"]);
    expect(failure.stderr).not.toContain("\u001b");
    // JSON keeps the exact string (JSON escapes control characters itself).
    const json = await runShell(["hostile", "--json"]);
    expect(json.stdout).not.toContain("\u001b");
    expect(envelope(json.stdout)).toMatchObject({ data: { name: HOSTILE } });
  });

  it("turns unexpected exceptions into INTERNAL_ERROR with secrets redacted", async () => {
    const token = "hm_env_token_for_crash";
    const result = await runShell(["crash", "--json"], {
      env: { HIVEMIND_TOKEN: token, HIVEMIND_DEBUG: "1" },
    });
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stderr).toContain("[REDACTED]");
    // The debug stack is human output too: escaped line by line.
    expect(result.stderr).toContain("boom\\x9b2J");
    expect(result.stderr).not.toContain("\u009b");
  });

  it("never prompts without a terminal", async () => {
    const result = await runShell(["ask", "--json"], { interactive: false });
    expect(result.code).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({
      error: { code: "USAGE_ERROR", message: expect.stringContaining("Pass --org <id>.") },
    });
  });

  it("resolves the origin from --server, HIVEMIND_URL and the default", async () => {
    const run = async (argv: string[], env = {}) =>
      envelope((await runShell([...argv, "--json"], { env })).stdout);
    expect(
      await run(["origin", "--server", "https://A.example:443"], {
        HIVEMIND_URL: "https://b.example",
      }),
    ).toMatchObject({
      data: { origin: "https://a.example", source: "flag" },
    });
    expect(await run(["origin"], { HIVEMIND_URL: "https://b.example/" })).toMatchObject({
      data: { origin: "https://b.example", source: "env" },
    });
    expect(await run(["origin"], { HIVEMIND_URL: "http://b.example" })).toMatchObject({
      error: { code: "INVALID_SERVER" },
    });
  });
});
