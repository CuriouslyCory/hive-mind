import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export interface FakeServer {
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type Handler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

/** A loopback HTTP server that records every request (method, URL, Authorization, body). */
export async function startServer(handler: Handler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (incoming: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const recorded = {
      method: incoming.method ?? "",
      url: incoming.url ?? "",
      authorization: incoming.headers.authorization,
      body,
    };
    requests.push(recorded);
    await handler(recorded, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The oRPC error body the real server sends. */
export function sendOrpcError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { defined: true, code, status, message });
}

export const USER_PRINCIPAL = {
  kind: "user",
  user: { id: "0b6d2c64-0b3a-4a51-8a2c-3c1f8f3d9e01", name: "Ada", email: "ada@example.com" },
  organizations: [
    { id: "6f0f8c1e-3f7a-4a0e-9a59-0d1b8f5b6c11", name: "Org", slug: "org", role: "owner" },
  ],
};
