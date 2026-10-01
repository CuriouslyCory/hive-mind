import { readFile } from "node:fs/promises";
import { API_BASE_PATH, API_ERRORS } from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateOpenAPIDocument, OPENAPI_DOCUMENT_PATH } from "../src/server/api/router";
import { type ApiHarness, createApiHarness, ORIGIN, type SignedInUser } from "./support/api";

// The OpenAPI document is generated from the contract the server implements.
// These tests pin it to the contract's golden route table and check that the
// running handler answers each documented operation with its documented
// success status.

interface Operation {
  method: string;
  path: string;
  operationId: string;
  successStatus: number;
  errorStatuses: number[];
}

async function documentedOperations(): Promise<Operation[]> {
  const document = await generateOpenAPIDocument();
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "delete"] as const) {
      const operation = item?.[method];
      if (!operation) continue;
      const statuses = Object.keys(operation.responses ?? {}).map(Number);
      const success = statuses.filter((status) => status < 300);
      expect(success).toHaveLength(1);
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: String(operation.operationId),
        successStatus: success[0] ?? 0,
        errorStatuses: statuses.filter((status) => status >= 400),
      });
    }
  }
  return operations;
}

describe("the OpenAPI document", () => {
  it("matches the contract's golden route table", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../packages/contract/test/fixtures/v1/routes.json", import.meta.url),
        "utf8",
      ),
    ) as { operationId: string; method: string; path: string; successStatus: number }[];
    const operations = await documentedOperations();
    const key = (op: {
      operationId: string;
      method: string;
      path: string;
      successStatus: number;
    }) => `${op.operationId} ${op.method} ${op.path} ${op.successStatus}`;
    expect(operations.map(key).sort()).toEqual(fixture.map(key).sort());
  });

  it("documents every contract error status on every operation", async () => {
    const statuses = Object.values(API_ERRORS)
      .map((error) => error.status)
      .sort();
    for (const operation of await documentedOperations()) {
      expect(operation.errorStatuses.sort()).toEqual(statuses);
    }
  });

  it("names the base path and bearer authentication", async () => {
    const document = await generateOpenAPIDocument();
    expect(document.servers).toEqual([{ url: API_BASE_PATH }]);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.components?.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
    });
  });
});

describeDb("the served API", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let projectId: string;

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    projectId = await api.createProject(owner);
  });

  afterAll(async () => {
    await api?.drop();
  });

  it("serves the document without credentials", async () => {
    const response = await api.handle(new Request(`${ORIGIN}${OPENAPI_DOCUMENT_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(JSON.stringify(await generateOpenAPIDocument())),
    );
  });

  it("answers each documented operation with its documented statuses", async () => {
    const key = await api.createKey(owner, projectId);
    // A valid request for each operation, as the owner.
    const bodies: Record<string, unknown> = {
      createProject: { organizationId: owner.organizationId, slug: "openapi", name: "OpenAPI" },
      createProjectKey: { name: "openapi" },
    };
    for (const operation of await documentedOperations()) {
      const path = operation.path.replace("{id}", projectId).replace("{keyId}", key.id);
      const response = await api.request(path, {
        method: operation.method as "GET" | "POST" | "DELETE",
        token: owner.token,
        body: bodies[operation.operationId],
      });
      expect([operation.operationId, response.status]).toEqual([
        operation.operationId,
        operation.successStatus,
      ]);

      const anonymous = await api.request(path, {
        method: operation.method as "GET" | "POST" | "DELETE",
        body: bodies[operation.operationId],
      });
      expect(anonymous.status).toBe(401);
      expect(operation.errorStatuses).toContain(anonymous.status);
    }
  });
});
