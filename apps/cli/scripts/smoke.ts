// Native smoke test for one release archive. Each runner in
// .github/workflows/cli-native.yml builds its own target, packs it with
// release-assets.ts, then runs this against that archive, so what is tested is
// exactly what ships.
//
//   node scripts/smoke.ts --archive <hivemind-<version>-<os>-<arch>.tar.gz>
//                         --probe <compiled test/native/probe.ts>
//                         [--commit <sha>] [--secret-service]
//
// --commit          Commit the binary must report (default: "unknown").
// --secret-service  A Secret Service is running on DBUS_SESSION_BUS_ADDRESS
//                   (Linux CI starts gnome-keyring under dbus-run-session), so
//                   the libsecret roundtrip must pass.
//
// The script itself runs on Node, but the binaries run with no Node or Bun
// reachable: PATH is a fresh directory holding only `secret-tool` (Linux),
// HOME and the config dir are empty temp directories, the working directory is
// outside the repository and holds a hostile .env and bunfig.toml, and nothing
// else from this process's environment is passed on.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CLI_ROOT, hostTarget, type Target } from "./build.ts";
import {
  archiveName,
  BINARY_NAME,
  cliVersion,
  inspectBinary,
  targetParts,
} from "./release-assets.ts";

const FIXTURES = resolve(CLI_ROOT, "../../packages/contract/test/fixtures/v1");

interface Result {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runAsync(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number },
): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

function describe(result: Result): string {
  const exit = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
  return `${exit}; stdout=${JSON.stringify(result.stdout.slice(0, 2000))} stderr=${JSON.stringify(result.stderr.slice(0, 2000))}`;
}

/** The single JSON object a `--json` command printed, or an error if stdout is anything else. */
function oneJsonObject(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new Error(`expected one JSON line on stdout, got ${lines.length}`);
  const value: unknown = JSON.parse(lines[0] as string);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stdout is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A stand-in API: GET /api/v1/me answers the golden v1 fixture for one bearer token. */
function startApi(token: string): Promise<{ server: Server; origin: string; seen: string[] }> {
  const me = readFileSync(join(FIXTURES, "me.user.json"), "utf8");
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const json = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    };
    if (request.url !== "/api/v1/me") {
      json(
        404,
        JSON.stringify({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }),
      );
    } else if (request.headers.authorization === `Bearer ${token}`) {
      json(200, me);
    } else {
      json(
        401,
        JSON.stringify({
          defined: true,
          code: "UNAUTHORIZED",
          status: 401,
          message: "Authentication is missing, invalid or expired.",
        }),
      );
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, origin: `http://127.0.0.1:${port}`, seen });
    });
  });
}

/** First match for `command` on this process's PATH. */
function which(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The Keychain addon this Darwin target must embed, from the build's node_modules. */
function darwinAddon(target: Target): Buffer | undefined {
  const { os, arch } = targetParts(target);
  if (os !== "darwin") return undefined;
  const file = `@napi-rs/keyring-darwin-${arch}/keyring.darwin-${arch}.node`;
  return readFileSync(createRequire(join(CLI_ROOT, "package.json")).resolve(file));
}

export interface SmokeOptions {
  archive: string;
  probe: string;
  commit: string;
  secretService: boolean;
  target?: Target;
}

export async function smoke(options: SmokeOptions): Promise<boolean> {
  const target = options.target ?? hostTarget();
  const { os } = targetParts(target);
  const version = cliVersion();
  const failures: string[] = [];
  const check = async (name: string, body: () => Promise<void> | void) => {
    try {
      await body();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failures.push(name);
      process.stdout.write(`FAIL ${name}: ${(error as Error).message}\n`);
    }
  };

  const root = mkdtempSync(join(tmpdir(), "hivemind-smoke-"));
  const bin = join(root, "extract");
  const pathDir = join(root, "path");
  const home = join(root, "home");
  const cwd = join(root, "work");
  for (const dir of [bin, pathDir, home, cwd]) mkdirSync(dir, { recursive: true });
  const binary = join(bin, BINARY_NAME);

  // A hostile working directory: a compiled binary that loaded these would
  // talk to the wrong server or run the preload.
  writeFileSync(join(cwd, ".env"), "HIVEMIND_URL=http://127.0.0.1:9\nHIVEMIND_TOKEN=from-dotenv\n");
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(cwd, "preload.ts"), 'process.stderr.write("PRELOAD RAN\\n");\n');

  // Only secret-tool is reachable; `node` and `bun` are not.
  const secretTool = os === "linux" ? which("secret-tool") : undefined;
  if (secretTool) symlinkSync(secretTool, join(pathDir, "secret-tool"));
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: pathDir,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: join(root, "tmp"),
  };
  mkdirSync(baseEnv.TMPDIR as string);
  const token = `hm_smoke_${randomBytes(12).toString("hex")}`;
  const api = await startApi(token);

  try {
    await check("archive holds only the binary", () => {
      assert(
        basename(options.archive) === archiveName(version, target),
        `archive should be named ${archiveName(version, target)}`,
      );
      const list = spawnSync("tar", ["-tzf", options.archive], { encoding: "utf8" });
      assert(list.status === 0, `tar -t failed: ${list.stderr}`);
      assert(list.stdout === `${BINARY_NAME}\n`, `archive lists ${JSON.stringify(list.stdout)}`);
      const extract = spawnSync("tar", ["-xzf", options.archive, "-C", bin], { encoding: "utf8" });
      assert(extract.status === 0, `tar -x failed: ${extract.stderr}`);
      assert((statSync(binary).mode & 0o777) === 0o755, "binary is not mode 0755");
    });

    await check(`binary format is ${target}`, () => {
      const problems = inspectBinary(readFileSync(binary), target, darwinAddon(target));
      assert(problems.length === 0, problems.join("; "));
    });

    await check("runtime PATH has no node or bun", () => {
      for (const tool of ["node", "bun"]) {
        assert(!existsSync(join(pathDir, tool)), `${tool} is on the runtime PATH`);
      }
    });

    await check("--version", async () => {
      const result = await runAsync(binary, ["--version"], { env: baseEnv, cwd });
      const expected = `${BINARY_NAME} ${version} (${options.commit}, ${target})\n`;
      assert(
        result.status === 0 && result.stdout === expected && result.stderr === "",
        `expected ${JSON.stringify(expected)}; ${describe(result)}`,
      );
    });

    await check("--help", async () => {
      const result = await runAsync(binary, ["--help"], { env: baseEnv, cwd });
      assert(
        result.status === 0 && /usage/i.test(result.stdout) && result.stderr === "",
        describe(result),
      );
    });

    // JSON output and exit mapping through the real client and transport:
    // HIVEMIND_URL and HIVEMIND_TOKEN select the stand-in API, not the .env.
    const apiEnv = { ...baseEnv, HIVEMIND_URL: api.origin };
    await check("whoami --json (success, exit 0)", async () => {
      const result = await runAsync(binary, ["whoami", "--json"], {
        env: { ...apiEnv, HIVEMIND_TOKEN: token },
        cwd,
      });
      assert(result.status === 0, describe(result));
      const expected: unknown = JSON.parse(
        readFileSync(join(FIXTURES, "cli.whoami.user.json"), "utf8"),
      );
      assert(
        JSON.stringify(oneJsonObject(result.stdout)) === JSON.stringify(expected),
        `stdout does not match the v1 fixture; ${describe(result)}`,
      );
      assert(!`${result.stdout}${result.stderr}`.includes(token), "the token was printed");
    });

    await check("whoami --json (rejected token, exit 3)", async () => {
      const wrong = `hm_wrong_${randomBytes(8).toString("hex")}`;
      const result = await runAsync(binary, ["whoami", "--json"], {
        env: { ...apiEnv, HIVEMIND_TOKEN: wrong },
        cwd,
      });
      assert(result.status === 3, describe(result));
      const envelope = oneJsonObject(result.stdout);
      const error = envelope.error as Record<string, unknown> | undefined;
      assert(
        envelope.schemaVersion === 1 &&
          envelope.command === "whoami" &&
          envelope.ok === false &&
          error?.code === "UNAUTHORIZED",
        `unexpected envelope; ${describe(result)}`,
      );
      assert(!`${result.stdout}${result.stderr}`.includes(wrong), "the token was printed");
    });

    await check("probe info reports this build", async () => {
      const result = await runAsync(options.probe, ["info"], { env: baseEnv, cwd });
      assert(result.status === 0, describe(result));
      const info = oneJsonObject(result.stdout);
      assert(
        info.version === version && info.commit === options.commit && info.target === target,
        `probe was built from another build: ${result.stdout}`,
      );
      const env = info.env as Record<string, unknown>;
      assert(
        env.HIVEMIND_URL === null && env.HIVEMIND_TOKEN === null,
        "the hostile .env was loaded",
      );
      assert(!result.stderr.includes("PRELOAD RAN"), "the hostile bunfig.toml preload ran");
    });

    await check("probe http sends the bearer token", async () => {
      const result = await runAsync(options.probe, ["http", `${api.origin}/api/v1/me`], {
        env: { ...baseEnv, HIVEMIND_PROBE_TOKEN: token },
        cwd,
      });
      assert(result.status === 0 && oneJsonObject(result.stdout).status === 200, describe(result));
    });

    await check("credential roundtrip: file", async () => {
      const result = await runAsync(options.probe, ["roundtrip", "file"], { env: baseEnv, cwd });
      assert(result.status === 0, describe(result));
    });

    if (os === "darwin") {
      // Same user, real login keychain (so the real HOME). The probe uses a
      // unique service name and deletes its item. It also checks that the
      // addon was loaded from an exact 0600 copy in the private 0700
      // ~/Library/Caches/hivemind/native, and that Bun extracted nothing into
      // TMPDIR (see src/credentials/keychain-binding.ts).
      const keychainEnv = { ...baseEnv, HOME: process.env.HOME ?? home };
      let copy: string | undefined;
      await check("credential roundtrip: keychain", async () => {
        const result = await runAsync(options.probe, ["roundtrip", "keychain"], {
          env: keychainEnv,
          cwd,
        });
        assert(result.status === 0, describe(result));
        const { addon } = oneJsonObject(result.stdout) as { addon?: { copy?: unknown } };
        if (typeof addon?.copy === "string") copy = addon.copy;
      });

      // Bun's own extraction would dlopen a same-size file owned by the user
      // without reading it. The CLI must compare contents and replace it. Run
      // with TMPDIR unset, where Bun would otherwise use the shared /private/tmp.
      await check("keychain replaces a tampered addon copy", async () => {
        const addon = darwinAddon(target);
        assert(copy && addon, "no addon copy from the previous roundtrip");
        writeFileSync(copy, Buffer.alloc(addon.length));
        // spawn() leaves out variables whose value is undefined.
        const result = await runAsync(options.probe, ["roundtrip", "keychain"], {
          env: { ...keychainEnv, TMPDIR: undefined },
          cwd,
        });
        assert(result.status === 0, describe(result));
        assert(readFileSync(copy).equals(addon), "the addon copy was not restored");
      });
    }

    if (os === "linux") {
      // No session bus: secret-tool's real error must map to "unavailable",
      // which permits the file fallback, not to "error". The message is
      // printed so it can be compared with NO_SERVICE_PATTERNS in libsecret.ts.
      await check("libsecret without a session bus is unavailable", async () => {
        assert(secretTool, "secret-tool is not installed (apt install libsecret-tools)");
        const result = await runAsync(
          options.probe,
          ["store", "libsecret", "get", "https://smoke.invalid"],
          { env: baseEnv, cwd },
        );
        process.stdout.write(`     secret-tool without a bus: ${result.stdout.trim()}\n`);
        const outcome = oneJsonObject(result.stdout);
        assert(outcome.ok === false && outcome.reason === "unavailable", describe(result));
      });

      if (options.secretService) {
        await check("credential roundtrip: libsecret", async () => {
          assert(process.env.DBUS_SESSION_BUS_ADDRESS, "DBUS_SESSION_BUS_ADDRESS is not set");
          const result = await runAsync(options.probe, ["roundtrip", "libsecret"], {
            env: { ...baseEnv, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
            cwd,
          });
          assert(result.status === 0, describe(result));
        });
      }
    }
  } finally {
    api.server.close();
    rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(
    failures.length === 0
      ? `smoke passed for ${target}\n`
      : `smoke FAILED for ${target}: ${failures.join(", ")}\n`,
  );
  return failures.length === 0;
}

async function runFromCommandLine(): Promise<boolean> {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      probe: { type: "string" },
      commit: { type: "string", default: "unknown" },
      "secret-service": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.archive || !values.probe) {
    throw new Error(
      "usage: smoke.ts --archive <path> --probe <path> [--commit <sha>] [--secret-service]",
    );
  }
  return smoke({
    archive: resolve(values.archive),
    probe: resolve(values.probe),
    commit: values.commit,
    secretService: values["secret-service"],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runFromCommandLine().then(
    (passed) => {
      process.exitCode = passed ? 0 : 1;
    },
    (error: unknown) => {
      process.stderr.write(`smoke: ${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
