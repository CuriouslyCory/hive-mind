// Bundling check for @orpc/client 1.x inside a compiled binary: one RPCLink call
// with a bearer header. Not the real API client (cli-core builds that from
// packages/contract); this only proves the library compiles and runs under Bun.
import { type Client, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

type ProbeClient = { me: Client<Record<never, never>, undefined, unknown, Error> };

const [url] = process.argv.slice(2);
if (!url) throw new Error("usage: orpc-entry <rpc base url>");
const link = new RPCLink({
  url,
  headers: { authorization: `Bearer ${process.env.HIVEMIND_PROBE_TOKEN ?? ""}` },
});
const client = createORPCClient<ProbeClient>(link);
process.stdout.write(`${JSON.stringify(await client.me())}\n`);
