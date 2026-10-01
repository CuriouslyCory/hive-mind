// Stand-in for the hivemind binary in the npm launcher tests
// (test/npm-launcher.test.ts), compiled with scripts/build.ts like the real one.
//
//   fixture args ...        print argv as JSON
//   fixture exit <code>     exit with <code>
//   fixture trap            print "ready", then on SIGINT/SIGTERM/SIGHUP print
//                           "got <signal>" and exit 7
//   fixture wait            print "ready", then wait with default signal handling

const [command, ...rest] = process.argv.slice(2);

if (command === "args") {
  process.stdout.write(`${JSON.stringify(rest)}\n`);
} else if (command === "exit") {
  process.exitCode = Number(rest[0]);
} else if (command === "trap" || command === "wait") {
  if (command === "trap") {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        process.stdout.write(`got ${signal}\n`);
        process.exit(7);
      });
    }
  }
  setInterval(() => {}, 1000);
  process.stdout.write("ready\n");
} else {
  process.stderr.write(`fixture: unknown command ${command}\n`);
  process.exitCode = 64;
}
