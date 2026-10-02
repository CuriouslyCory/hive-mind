import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

// A reverse proxy for the app that adds an unknown field to every JSON object
// the API answers with, nested ones included (in an error body, only below its
// top level). ADR-0009 lets the server add response fields without breaking
// released CLIs; running the compiled CLI through this proxy checks that it
// tolerates them.

/** The field the proxy adds to every object. */
const ADDED_FIELD = "e2eAddedField";

export interface FieldAddingProxy {
  /** The proxy's origin, e.g. `http://127.0.0.1:41234`. */
  origin: string;
  /** How many JSON answers the proxy changed. */
  changedAnswers(): number;
  close(): Promise<void>;
}

export async function startFieldAddingProxy(target: string): Promise<FieldAddingProxy> {
  const targetUrl = new URL(target);
  let changed = 0;
  const server = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, host: targetUrl.host };
    // An uncompressed answer, so the proxy can rewrite it.
    delete headers["accept-encoding"];
    const upstream = request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
          let body = Buffer.concat(chunks);
          if (String(answer.headers["content-type"] ?? "").includes("application/json")) {
            const json: unknown = JSON.parse(body.toString("utf8"));
            // An error body is oRPC's fixed `{ defined, code, status, message,
            // data? }` (ADR-0009); oRPC clients reject other top-level keys, so
            // a server can only add fields below it.
            const isError = (answer.statusCode ?? 500) >= 400;
            body = Buffer.from(JSON.stringify(isError ? addFieldBelow(json) : addField(json)));
            changed += 1;
          }
          const answerHeaders = { ...answer.headers, "content-length": String(body.length) };
          delete answerHeaders["transfer-encoding"];
          outgoing.writeHead(answer.statusCode ?? 502, answerHeaders);
          outgoing.end(body);
        });
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    changedAnswers: () => changed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function addFieldBelow(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, addField(child)]));
}

function addField(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(addField);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = addField(child);
  copy[ADDED_FIELD] = { addedBy: "a newer server" };
  return copy;
}
