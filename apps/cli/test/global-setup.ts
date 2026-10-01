import { build } from "../scripts/build.ts";
import { PROBE_BINARY } from "./helpers/binaries.ts";

// Compiles the probe harness once per test run, with the same flags as the
// shipped binary, so runtime tests exercise a real `bun build --compile` output.
export default function setup(): void {
  build({ entry: "test/native/probe.ts", outfile: PROBE_BINARY, commit: "test" });
}
