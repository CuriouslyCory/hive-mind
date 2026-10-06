import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  ADR_STATES,
  ADR_STATUSES,
  type AdrStatus,
  adrContentSha256,
  adrFileName,
  adrPageSchema,
  eventPageSchema,
  getAdrOutputSchema,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_FLOOR_ADVANCE,
  MAX_ADR_NUMBER,
  MAX_ADR_PATH_LENGTH,
  MAX_ADR_PROBLEM_MESSAGE_LENGTH,
  MAX_ADR_SUPERSEDES,
  MAX_ADR_SYNC_ENTRIES,
  MAX_ADR_TITLE_LENGTH,
  MAX_ADR_UPLOAD_BODY_BYTES,
  MAX_MANAGEMENT_BODY_BYTES,
  type ProjectKeyPermission,
  parseAdrContent,
  renderAdrTemplate,
  reserveAdrOutputSchema,
  rewriteAdrFrontmatter,
  slugifyAdrTitle,
  syncAdrsOutputSchema,
  UNAVAILABLE_EVENT_TYPE,
  uploadAdrContentsOutputSchema,
} from "@hivemind/contract";
import {
  ADR_STATES as DB_ADR_STATES,
  ADR_STATUSES as DB_ADR_STATUSES,
  MAX_ADR_CONTENT_BYTES as DB_MAX_ADR_CONTENT_BYTES,
  MAX_ADR_FLOOR_ADVANCE as DB_MAX_ADR_FLOOR_ADVANCE,
  MAX_ADR_NUMBER as DB_MAX_ADR_NUMBER,
  MAX_ADR_PATH_LENGTH as DB_MAX_ADR_PATH_LENGTH,
  MAX_ADR_SUPERSEDES as DB_MAX_ADR_SUPERSEDES,
  MAX_ADR_SYNC_ENTRIES as DB_MAX_ADR_SYNC_ENTRIES,
  MAX_ADR_TITLE_LENGTH as DB_MAX_ADR_TITLE_LENGTH,
} from "@hivemind/db";
import { adrContent, agentSession, event, project } from "@hivemind/db/schema";
import { describeDb } from "@hivemind/db/testing";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { truncated } from "../src/server/api/adrs";
import { authorizeProject } from "../src/server/api/coordination-auth";
import type { ProjectKeyPrincipal } from "../src/server/api/principal";
import {
  type ApiHarness,
  createApiHarness,
  errorCode,
  ORIGIN,
  type RequestOptions,
  type SignedInUser,
} from "./support/api";

// The ADR routes of #19 (ADR-0017): the authorization matrix, nested
// isolation, the route-scoped body limits, server-side parsing of uploads,
// ADR sync's compare-and-set and refusals, replay, sync notices, and which
// routes write Events. Every success body is parsed with the contract's
// output schema.

const ADR_DIRECTORY = new URL("../../../docs/adr/", import.meta.url);

const uuid = () => crypto.randomUUID();
const randomSha = () => randomBytes(20).toString("hex");

describe("the ADR limits of the contract and @hivemind/db", () => {
  it("agree", () => {
    expect([...ADR_STATES]).toEqual([...DB_ADR_STATES]);
    expect([...ADR_STATUSES]).toEqual([...DB_ADR_STATUSES]);
    expect(MAX_ADR_FLOOR_ADVANCE).toBe(DB_MAX_ADR_FLOOR_ADVANCE);
    expect(MAX_ADR_NUMBER).toBe(DB_MAX_ADR_NUMBER);
    expect(MAX_ADR_TITLE_LENGTH).toBe(DB_MAX_ADR_TITLE_LENGTH);
    expect(MAX_ADR_FILE_BYTES).toBe(DB_MAX_ADR_CONTENT_BYTES);
    expect(MAX_ADR_SUPERSEDES).toBe(DB_MAX_ADR_SUPERSEDES);
    // The contract may be stricter than the database, never looser.
    expect(MAX_ADR_SYNC_ENTRIES).toBeLessThanOrEqual(DB_MAX_ADR_SYNC_ENTRIES);
    expect(MAX_ADR_PATH_LENGTH).toBeLessThanOrEqual(DB_MAX_ADR_PATH_LENGTH);
  });

  it("shortens long problem messages to 500 code units without splitting a character", () => {
    expect(truncated("short")).toBe("short");
    const exact = "x".repeat(MAX_ADR_PROBLEM_MESSAGE_LENGTH);
    expect(truncated(exact)).toBe(exact);
    const long = truncated("y".repeat(MAX_ADR_PROBLEM_MESSAGE_LENGTH + 1));
    expect(long).toHaveLength(MAX_ADR_PROBLEM_MESSAGE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    // An emoji is two code units; the cut falls between them.
    const emoji = truncated(`${"z".repeat(MAX_ADR_PROBLEM_MESSAGE_LENGTH - 2)}😀😀`);
    expect(emoji.isWellFormed()).toBe(true);
    expect(emoji.length).toBeLessThanOrEqual(MAX_ADR_PROBLEM_MESSAGE_LENGTH);
  });
});

interface AdrFile {
  fileName: string;
  content: string;
  sha256: string;
}

interface FileOptions {
  slug?: string;
  status?: AdrStatus;
  supersedes?: number[];
  date?: string;
}

/** The text of a valid ADR: ADR-0001's template, with any frontmatter changes. */
function adrText(title: string, options: FileOptions = {}): string {
  const rendered = renderAdrTemplate({ title, date: options.date ?? "2026-10-05" });
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
  if (!options.status && !options.supersedes) return rendered.contents;
  const rewritten = rewriteAdrFrontmatter(rendered.contents, {
    status: options.status,
    supersedes: options.supersedes,
  });
  if (!rewritten.ok) throw new Error(JSON.stringify(rewritten.errors));
  return rewritten.contents;
}

async function withHash(fileName: string, content: string): Promise<AdrFile> {
  return { fileName, content, sha256: await adrContentSha256(content) };
}

async function adrFile(number: number, title: string, options: FileOptions = {}) {
  const slug = options.slug ?? slugifyAdrTitle(title) ?? "adr";
  return withHash(adrFileName(number, slug), adrText(title, options));
}

/** This repository's ADR files. */
async function repositoryAdrs(): Promise<AdrFile[]> {
  const names = (await readdir(ADR_DIRECTORY)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (name) => withHash(name, await readFile(new URL(name, ADR_DIRECTORY), "utf8"))),
  );
}

/** A JSON body padded with trailing spaces to exactly `size` bytes. */
function padded(body: unknown, size: number): string {
  const json = JSON.stringify(body);
  const length = new TextEncoder().encode(json).byteLength;
  if (length > size) throw new Error(`The body is already ${length} bytes.`);
  return json + " ".repeat(size - length);
}

describeDb("/api/v1 ADRs", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let member: SignedInUser;
  let outsider: SignedInUser;
  let projectA: string;
  let projectB: string;
  let keyA: { id: string; secret: string };
  let keyB: { id: string; secret: string };

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
    member = await api.signUp();
    outsider = await api.signUp();
    await api.addMember(owner.organizationId, member.id, "member");
    projectA = await api.createProject(owner);
    projectB = await api.createProject(owner);
    keyA = await api.createKey(owner, projectA);
    keyB = await api.createKey(owner, projectB);
  });

  afterAll(async () => {
    await api?.drop();
  });

  function call(token: string, path: string, options: Omit<RequestOptions, "token"> = {}) {
    return api.request(path, { ...options, token });
  }

  /** The body of a 200, parsed with the contract's output schema; throws on any other status. */
  async function ok<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
    if (response.status !== 200) {
      throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
    }
    return schema.parse(await response.json());
  }

  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(await errorCode(response.clone())).toBe(code);
    return ((await response.json()) as { message: string }).message;
  }

  function reserve(token: string, projectId: string, body: Record<string, unknown> = {}) {
    return call(token, `/projects/${projectId}/adrs`, {
      body: { adrId: uuid(), title: "Reserved", slug: "reserved", ...body },
    });
  }

  async function reserved(token: string, projectId: string, body: Record<string, unknown> = {}) {
    return ok(await reserve(token, projectId, body), reserveAdrOutputSchema);
  }

  function upload(token: string, projectId: string, files: Pick<AdrFile, "sha256" | "content">[]) {
    return call(token, `/projects/${projectId}/adrs/contents`, {
      body: { files: files.map(({ sha256, content }) => ({ sha256, content })) },
    });
  }

  /** Uploads `files` as the owner and expects every one to be valid. */
  async function uploaded(projectId: string, files: AdrFile[]) {
    const result = await ok(
      await upload(owner.token, projectId, files),
      uploadAdrContentsOutputSchema,
    );
    expect(result.files.map((file) => [file.sha256, file.valid, file.errors])).toEqual(
      files.map((file) => [file.sha256, true, []]),
    );
    return result;
  }

  async function list(projectId: string, query = "") {
    return ok(await call(owner.token, `/projects/${projectId}/adrs${query}`), adrPageSchema);
  }

  async function getAdr(projectId: string, number: number) {
    return ok(await call(owner.token, `/projects/${projectId}/adrs/${number}`), getAdrOutputSchema);
  }

  /** The commit the copy is at, as `adr sync` reads it: `lastSync` of the first page. */
  async function currentBase(projectId: string): Promise<string | null> {
    return (await list(projectId, "?limit=1")).lastSync?.commitSha ?? null;
  }

  interface SyncOptions {
    commitSha?: string;
    /** Defaults to the current base, read just before the request. */
    baseCommitSha?: string | null;
    directory?: string;
    forced?: boolean;
    sessionId?: string;
  }

  async function syncRequest(
    token: string,
    projectId: string,
    files: Pick<AdrFile, "fileName" | "sha256">[],
    options: SyncOptions = {},
  ) {
    const baseCommitSha =
      options.baseCommitSha === undefined ? await currentBase(projectId) : options.baseCommitSha;
    return call(token, `/projects/${projectId}/adrs/sync`, {
      body: {
        commitSha: options.commitSha ?? randomSha(),
        baseCommitSha,
        directory: options.directory ?? "docs/adr",
        entries: files.map(({ fileName, sha256 }) => ({ fileName, sha256 })),
        ...(options.forced === undefined ? {} : { forced: options.forced }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
    });
  }

  /** Uploads `files` and syncs exactly them as the owner. */
  async function synced(projectId: string, files: AdrFile[], options: SyncOptions = {}) {
    if (files.length > 0) await uploaded(projectId, files);
    return ok(await syncRequest(owner.token, projectId, files, options), syncAdrsOutputSchema);
  }

  async function eventsOf(projectId: string) {
    return api.testDb.db
      .select()
      .from(event)
      .where(eq(event.projectId, projectId))
      .orderBy(event.seq);
  }

  async function insertSession(projectId: string, owned: { userId: string } | { keyId: string }) {
    const [row] = await api.testDb.db
      .insert(agentSession)
      .values({
        projectId,
        ...("userId" in owned
          ? { ownerKind: "user" as const, userId: owned.userId }
          : { ownerKind: "key" as const, keyId: owned.keyId }),
        agent: "test",
        intent: "Testing",
        creationFingerprint: "0".repeat(64),
      })
      .returning();
    if (!row) throw new Error("Session insert returned no row.");
    return row;
  }

  describe("the authorization matrix", () => {
    type Route = Omit<RequestOptions, "token"> & { path: string };

    // One valid request per operation. Each is built just before it is sent:
    // a sync needs the base as it is then, and an upload a file of its own.
    async function routes(projectId: string): Promise<Record<string, () => Promise<Route>>> {
      const { adr } = await reserved(owner.token, projectId);
      const base = `/projects/${projectId}/adrs`;
      return {
        listAdrs: async () => ({ path: base }),
        reserveAdr: async () => ({
          path: base,
          body: { adrId: uuid(), title: "Matrix", slug: "matrix" },
        }),
        getAdr: async () => ({ path: `${base}/${adr.number}` }),
        uploadAdrContents: async () => {
          const file = await adrFile(1, `Matrix ${uuid()}`);
          return {
            path: `${base}/contents`,
            body: { files: [{ sha256: file.sha256, content: file.content }] },
          };
        },
        syncAdrs: async () => ({
          path: `${base}/sync`,
          body: {
            commitSha: randomSha(),
            baseCommitSha: await currentBase(projectId),
            directory: "docs/adr",
            entries: [],
          },
        }),
      };
    }

    it("covers every ADR route of the contract", async () => {
      const fixture = JSON.parse(
        await readFile(
          new URL("../../../packages/contract/test/fixtures/v1/routes.adr.json", import.meta.url),
          "utf8",
        ),
      ) as { operationId: string }[];
      expect(Object.keys(await routes(projectA)).sort()).toEqual(
        fixture.map((route) => route.operationId).sort(),
      );
    });

    const callers: [string, () => string, () => string, number][] = [
      ["an organization owner", () => owner.token, () => projectA, 200],
      ["a member who is not an owner", () => member.token, () => projectA, 200],
      ["a non-member", () => outsider.token, () => projectA, 404],
      ["the Project's own key", () => keyA.secret, () => projectA, 200],
      ["another Project's key", () => keyB.secret, () => projectA, 404],
    ];

    for (const [who, token, projectId, status] of callers) {
      it(`answers ${status} to ${who} on every route`, async () => {
        for (const [operation, build] of Object.entries(await routes(projectId()))) {
          const route = await build();
          const response = await call(token(), route.path, route);
          expect([operation, response.status]).toEqual([operation, status]);
          if (status === 404) {
            expect(await response.json()).toMatchObject({
              code: "NOT_FOUND",
              message: "Project not found.",
            });
          }
        }
      });
    }

    it("refuses a Project key without adr:read or adr:write with 403, after Project access", async () => {
      const limited: ProjectKeyPrincipal = {
        kind: "projectKey",
        keyId: keyA.id,
        organizationId: owner.organizationId,
        projectId: projectA,
        permissions: ["project:read", "adr:read"],
      };
      const attempt = (projectId: string, permissions: ProjectKeyPermission[]) =>
        authorizeProject(api.testDb.db, limited, projectId, permissions).catch(
          (error: unknown) => error,
        );
      expect(await attempt(projectA, ["adr:read"])).toMatchObject({
        principal: { kind: "project_key", keyId: keyA.id },
      });
      const denied = await attempt(projectA, ["adr:write"]);
      expect(denied).toBeInstanceOf(ORPCError);
      expect(denied).toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(await attempt(projectB, ["adr:read"])).toMatchObject({ code: "NOT_FOUND" });
    });

    it("answers 401 to a revoked or expired key, and keeps its reservation readable", async () => {
      const projectId = await api.createProject(owner);
      const revoked = await api.createKey(owner, projectId);
      const expired = await api.createKey(owner, projectId);
      const { adr } = await reserved(revoked.secret, projectId, { title: "By a key", slug: "key" });
      await call(owner.token, `/projects/${projectId}/keys/${revoked.id}`, { method: "DELETE" });
      await api.testDb.pool.query(
        "update apikey set expires_at = now() - interval '1 second' where id = $1",
        [expired.id],
      );
      for (const secret of [revoked.secret, expired.secret]) {
        for (const response of [
          await call(secret, `/projects/${projectId}/adrs`),
          await reserve(secret, projectId),
          await syncRequest(secret, projectId, []),
        ]) {
          await expectError(response, 401, "UNAUTHORIZED");
        }
      }
      const page = await list(projectId);
      expect(page.items.find((item) => item.id === adr.id)?.reservation).toMatchObject({
        title: "By a key",
        reservedBy: { kind: "project_key", keyId: revoked.id },
      });
    });

    it("stops answering a member who left the organization", async () => {
      const leaver = await api.signUp();
      await api.addMember(owner.organizationId, leaver.id, "member");
      expect((await call(leaver.token, `/projects/${projectA}/adrs`)).status).toBe(200);
      await api.removeMember(owner.organizationId, leaver.id);
      await expectError(await call(leaver.token, `/projects/${projectA}/adrs`), 404, "NOT_FOUND");
    });

    it("attributes a reservation to the caller's own Session only", async () => {
      const projectId = await api.createProject(owner);
      const own = await insertSession(projectId, { userId: owner.id });
      const { adr } = await reserved(owner.token, projectId, { sessionId: own.id });
      expect(adr.reservation?.sessionId).toBe(own.id);
      const [logged] = await eventsOf(projectId);
      expect(logged).toMatchObject({ type: "adr.reserved", actorSessionId: own.id });

      await expectError(
        await reserve(member.token, projectId, { sessionId: own.id }),
        403,
        "FORBIDDEN",
      );
      await expectError(
        await reserve(owner.token, projectId, { sessionId: uuid() }),
        404,
        "NOT_FOUND",
      );
      await expectError(
        await syncRequest(member.token, projectId, [], { sessionId: own.id }),
        403,
        "FORBIDDEN",
      );
    });
  });

  describe("nested isolation", () => {
    it("answers 404 for another Project's ADR exactly like an absent one", async () => {
      const projectId = await api.createProject(owner);
      const foreign = await api.createProject(owner);
      const { adr } = await reserved(owner.token, foreign);
      expect(adr.number).toBe(1);
      const other = await call(owner.token, `/projects/${projectId}/adrs/1`);
      const absent = await call(owner.token, `/projects/${projectId}/adrs/77`);
      expect(other.status).toBe(404);
      const body = await other.json();
      expect(body).toEqual(await absent.json());
      expect(body).toMatchObject({ code: "NOT_FOUND", message: "ADR not found." });
    });

    it("answers 400 for a number that is not 1 to 9999 without leading zeros", async () => {
      for (const number of ["0", "10000", "abc", "007", "-1", "1.5"]) {
        const response = await call(owner.token, `/projects/${projectA}/adrs/${number}`);
        expect([number, response.status]).toEqual([number, 400]);
      }
    });

    it("refuses a sync naming content uploaded to another Project", async () => {
      const projectId = await api.createProject(owner);
      const foreign = await api.createProject(owner);
      const file = await adrFile(1, "Uploaded elsewhere");
      await uploaded(foreign, [file]);
      const message = await expectError(
        await syncRequest(owner.token, projectId, [file]),
        400,
        "BAD_REQUEST",
      );
      expect(message).toContain(`docs/adr/${file.fileName}`);
    });
  });

  describe("route-scoped body limits", () => {
    function streamed(path: string, body: string): Promise<Response> {
      // No content-length: the server counts bytes as they arrive.
      const encoded = new TextEncoder().encode(body);
      return api.handle(
        new Request(`${ORIGIN}/api/v1${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
          body: new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < encoded.length; offset += 4096) {
                controller.enqueue(encoded.slice(offset, offset + 4096));
              }
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
      );
    }

    it("accepts ADR-0014, larger than 16 KiB, and syncs it", async () => {
      const projectId = await api.createProject(owner);
      const adr14 = (await repositoryAdrs()).find((file) => file.fileName.startsWith("0014-"));
      if (!adr14) throw new Error("docs/adr has no ADR-0014.");
      expect(new TextEncoder().encode(adr14.content).byteLength).toBeGreaterThan(16 * 1024);
      const [result] = (await uploaded(projectId, [adr14])).files;
      expect(result).toMatchObject({ valid: true, created: true });
      await synced(projectId, [adr14]);
      const parsed = parseAdrContent(adr14.content);
      if (!parsed.ok) throw new Error("ADR-0014 does not parse.");
      const { adr } = await getAdr(projectId, 14);
      expect(adr).toMatchObject({
        title: parsed.adr.title,
        path: `docs/adr/${adr14.fileName}`,
        content: adr14.content,
        contentSha256: adr14.sha256,
      });
    });

    it("keeps 413 for a 17 KiB Plan body", async () => {
      const before = await eventsOf(projectA);
      const response = await call(owner.token, `/projects/${projectA}/plans`, {
        body: padded({ planId: uuid(), title: "Padded" }, 17 * 1024),
      });
      await expectError(response, 413, "PAYLOAD_TOO_LARGE");
      expect(await eventsOf(projectA)).toHaveLength(before.length);
    });

    it("keeps 16 KiB on the reservation route", async () => {
      const path = `/projects/${projectA}/adrs`;
      const body = () => ({ adrId: uuid(), title: "Padded", slug: "padded" });
      const atLimit = await call(owner.token, path, {
        body: padded(body(), MAX_MANAGEMENT_BODY_BYTES),
      });
      await ok(atLimit, reserveAdrOutputSchema);
      const over = await call(owner.token, path, {
        body: padded(body(), MAX_MANAGEMENT_BODY_BYTES + 1),
      });
      await expectError(over, 413, "PAYLOAD_TOO_LARGE");
    });

    it("accepts exactly 256 KiB on the upload routes and refuses one byte more, declared or streamed", async () => {
      const projectId = await api.createProject(owner);
      const file = await adrFile(1, "Padded upload");
      const contents = `/projects/${projectId}/adrs/contents`;
      const contentsBody = { files: [{ sha256: file.sha256, content: file.content }] };
      const atLimit = await call(owner.token, contents, {
        body: padded(contentsBody, MAX_ADR_UPLOAD_BODY_BYTES),
      });
      await ok(atLimit, uploadAdrContentsOutputSchema);
      for (const response of [
        await call(owner.token, contents, {
          body: padded(contentsBody, MAX_ADR_UPLOAD_BODY_BYTES + 1),
        }),
        await streamed(contents, padded(contentsBody, MAX_ADR_UPLOAD_BODY_BYTES + 1)),
      ]) {
        await expectError(response, 413, "PAYLOAD_TOO_LARGE");
      }

      const sync = `/projects/${projectId}/adrs/sync`;
      const syncBody = async () => ({
        commitSha: randomSha(),
        baseCommitSha: await currentBase(projectId),
        directory: "docs/adr",
        entries: [{ fileName: file.fileName, sha256: file.sha256 }],
      });
      const syncAtLimit = await call(owner.token, sync, {
        body: padded(await syncBody(), MAX_ADR_UPLOAD_BODY_BYTES),
      });
      expect((await ok(syncAtLimit, syncAdrsOutputSchema)).added).toBe(1);
      // A streamed body of exactly the limit is read to the end.
      const streamedAtLimit = await streamed(
        sync,
        padded(await syncBody(), MAX_ADR_UPLOAD_BODY_BYTES),
      );
      expect((await ok(streamedAtLimit, syncAdrsOutputSchema)).changed).toBe(true);
      for (const response of [
        await call(owner.token, sync, {
          body: padded(await syncBody(), MAX_ADR_UPLOAD_BODY_BYTES + 1),
        }),
        await streamed(sync, padded(await syncBody(), MAX_ADR_UPLOAD_BODY_BYTES + 1)),
      ]) {
        await expectError(response, 413, "PAYLOAD_TOO_LARGE");
      }
    });

    it("matches only the two upload paths, and only for POST", async () => {
      const base = `/projects/${projectA}/adrs`;
      const big = padded({}, 17 * 1024);
      const requests: [string, RequestOptions["method"]][] = [
        [`${base}/contents/x`, "POST"],
        [`${base}/sync/`, "POST"],
        [`${base}/x/contents`, "POST"],
        [base, "POST"],
        [`${base}/contents`, "PATCH"],
        [`${base}/sync`, "DELETE"],
        [`/projects/${projectA}/plans/contents`, "POST"],
      ];
      for (const [path, method] of requests) {
        const response = await call(owner.token, path, { method, body: big });
        expect([method, path, response.status]).toEqual([method, path, 413]);
      }
    });

    it("refuses an oversize upload before authentication", async () => {
      const response = await api.request(`/projects/${projectA}/adrs/contents`, {
        body: padded({}, MAX_ADR_UPLOAD_BODY_BYTES + 1),
      });
      await expectError(response, 413, "PAYLOAD_TOO_LARGE");
    });
  });

  describe("server-side parsing of uploads", () => {
    it("ignores what the client claims and parses the content itself", async () => {
      const projectId = await api.createProject(owner);
      const file = await adrFile(1, "Claimed accepted");
      // (a) Fields other than sha256 and content are refused.
      const extra = await call(owner.token, `/projects/${projectId}/adrs/contents`, {
        body: { files: [{ sha256: file.sha256, content: file.content, status: "accepted" }] },
      });
      await expectError(extra, 400, "BAD_REQUEST");

      // (b) A hash that is not the content's, even another file's real hash,
      // stores nothing under it.
      const other = await adrFile(2, "The real owner of the hash");
      const poisoned = await ok(
        await upload(owner.token, projectId, [{ sha256: other.sha256, content: file.content }]),
        uploadAdrContentsOutputSchema,
      );
      expect(poisoned.files).toEqual([
        {
          sha256: other.sha256,
          valid: false,
          created: false,
          errors: [
            { code: "ADR_SHA256_MISMATCH", message: "The sha256 does not match the content." },
          ],
          warnings: [],
        },
      ]);
      const stored = await api.testDb.db
        .select()
        .from(adrContent)
        .where(
          and(eq(adrContent.projectId, projectId), eq(adrContent.contentSha256, other.sha256)),
        );
      expect(stored).toEqual([]);
      const refused = await syncRequest(owner.token, projectId, [other]);
      await expectError(refused, 400, "BAD_REQUEST");

      // (c) The status comes from the content.
      await synced(projectId, [file]);
      const { adr } = await getAdr(projectId, 1);
      expect(adr).toMatchObject({
        status: "proposed",
        title: "Claimed accepted",
        date: "2026-10-05",
      });
    });

    it("reports per-file problems and stores only valid files", async () => {
      const projectId = await api.createProject(owner);
      const valid = await adrFile(1, "Valid");
      const unknownKey = await withHash(
        "0002-unknown-key.md",
        valid.content.replace("status: proposed\n", "status: proposed\nauthor: someone\n"),
      );
      const nul = await withHash("0003-nul.md", `${valid.content}\u0000`);
      const result = await ok(
        await upload(owner.token, projectId, [valid, unknownKey, nul]),
        uploadAdrContentsOutputSchema,
      );
      expect(result.files.map((file) => [file.valid, file.created])).toEqual([
        [true, true],
        [false, false],
        [false, false],
      ]);
      expect(result.files[1]?.errors.map((error) => error.code)).toEqual([
        "ADR_FRONTMATTER_UNKNOWN_KEY",
      ]);
      expect(result.files[2]?.errors.map((error) => error.code)).toEqual(["ADR_CONTROL_CHARACTER"]);
      // The template has every section, so a valid file here has no warnings.
      expect(result.files[0]?.warnings).toEqual([]);

      const message = await expectError(
        await syncRequest(owner.token, projectId, [valid, unknownKey]),
        400,
        "BAD_REQUEST",
      );
      expect(message).toMatch(/^ADR sync refused: docs\/adr\/0002-unknown-key\.md: /);
      expect(message).not.toContain("0001-valid.md");

      // A second upload of stored content is valid but not created.
      const again = await ok(
        await upload(owner.token, projectId, [valid]),
        uploadAdrContentsOutputSchema,
      );
      expect(again.files[0]).toMatchObject({ valid: true, created: false });
    });

    // Every file the parser accepts must be one @hivemind/db stores: a file it
    // refuses after parsing would fail the whole upload with a 500.
    it("refuses a title of only Unicode whitespace per file, storing the rest", async () => {
      const projectId = await api.createProject(owner);
      const valid = await adrFile(1, "Valid");
      const blank = await withHash(
        "0002-blank.md",
        valid.content.replace("# Valid\n", "# \u3000\ufeff\n"),
      );
      const c1 = await withHash("0003-c1.md", valid.content.replace("# Valid", "# Valid \u009b"));
      const result = await ok(
        await upload(owner.token, projectId, [valid, blank, c1]),
        uploadAdrContentsOutputSchema,
      );
      expect(result.files.map((file) => [file.valid, file.errors.map((e) => e.code)])).toEqual([
        [true, []],
        [false, ["ADR_TITLE_MISSING"]],
        [false, ["ADR_CONTROL_CHARACTER"]],
      ]);
      expect(result.files[0]?.created).toBe(true);
    });

    it("returns the parser's warnings and keeps them on the ADR", async () => {
      const projectId = await api.createProject(owner);
      const file = await withHash(
        "0001-short.md",
        "---\nstatus: accepted\ndate: 2026-10-05\n---\n\n# Short\n\n## Context\n\nOnly context.\n",
      );
      const [result] = (await uploaded(projectId, [file])).files;
      expect(result?.warnings.length).toBeGreaterThan(0);
      expect(result?.warnings.every((warning) => warning.code === "ADR_SECTION_MISSING")).toBe(
        true,
      );
      await synced(projectId, [file]);
      const { adr } = await getAdr(projectId, 1);
      expect(adr.warnings).toEqual(result?.warnings);
      expect((await list(projectId)).items[0]?.warningCount).toBe(result?.warnings.length);
    });

    it(`refuses a file that supersedes more than ${MAX_ADR_SUPERSEDES} ADRs`, async () => {
      const projectId = await api.createProject(owner);
      const supersedes = Array.from({ length: MAX_ADR_SUPERSEDES + 1 }, (_, index) => index + 1);
      const tooMany = await adrFile(100, "Too many", { supersedes });
      const enough = await adrFile(101, "Enough", { supersedes: supersedes.slice(1) });
      const result = await ok(
        await upload(owner.token, projectId, [tooMany, enough]),
        uploadAdrContentsOutputSchema,
      );
      expect(result.files.map((file) => [file.valid, file.errors.map((e) => e.code)])).toEqual([
        [false, ["ADR_SUPERSEDES_INVALID"]],
        [true, []],
      ]);
    });
  });

  describe("compare-and-set and refusals", () => {
    it("answers 409 CONFLICT for a stale base and applies nothing", async () => {
      const projectId = await api.createProject(owner);
      const first = await adrFile(1, "First");
      const c1 = randomSha();
      await synced(projectId, [first], { commitSha: c1, baseCommitSha: null });
      const before = await eventsOf(projectId);

      const second = await adrFile(2, "Second");
      await uploaded(projectId, [second]);
      const c2 = randomSha();
      const message = await expectError(
        await syncRequest(owner.token, projectId, [first, second], {
          commitSha: c2,
          baseCommitSha: null,
        }),
        409,
        "CONFLICT",
      );
      expect(message).toBe(
        `The ADR copy is at commit ${c1}, not no commit (never synced). Another ADR sync finished first.`,
      );
      // `forced` does not skip the comparison.
      await expectError(
        await syncRequest(owner.token, projectId, [first, second], {
          baseCommitSha: randomSha(),
          forced: true,
        }),
        409,
        "CONFLICT",
      );
      const page = await list(projectId);
      expect(page.lastSync?.commitSha).toBe(c1);
      expect(page.items.map((item) => item.number)).toEqual([1]);
      expect(await eventsOf(projectId)).toHaveLength(before.length);
    });

    it("answers 409 CONFLICT for a commit already synced with other files", async () => {
      const projectId = await api.createProject(owner);
      const first = await adrFile(1, "First");
      const commitSha = randomSha();
      await synced(projectId, [first], { commitSha });
      const message = await expectError(
        await syncRequest(owner.token, projectId, [], { commitSha }),
        409,
        "CONFLICT",
      );
      expect(message).toBe(`Commit ${commitSha} was already synced with different files.`);
    });

    it("answers 409 CONFLICT for two files with one number, naming both paths", async () => {
      const projectId = await api.createProject(owner);
      const a = await adrFile(18, "Cache ADR pages");
      const b = await adrFile(18, "Use keyset pages");
      await uploaded(projectId, [a, b]);
      const message = await expectError(
        await syncRequest(owner.token, projectId, [a, b]),
        409,
        "CONFLICT",
      );
      expect(message).toBe(
        "More than one file has the same ADR number: ADR-0018 " +
          "(docs/adr/0018-cache-adr-pages.md, docs/adr/0018-use-keyset-pages.md).",
      );
      expect(await eventsOf(projectId)).toEqual([]);
    });

    it("lists the first 20 problems, then how many more", async () => {
      const projectId = await api.createProject(owner);
      const files = await Promise.all(
        Array.from({ length: 22 }, (_, index) =>
          adrFile(index + 1, `Missing ${index + 1}`, { slug: `missing-${index + 1}` }),
        ),
      );
      const missing = await expectError(
        await syncRequest(owner.token, projectId, files),
        400,
        "BAD_REQUEST",
      );
      expect(missing).toMatch(/^ADR sync refused: docs\/adr\/0001-missing-1\.md: /);
      expect(missing).toContain("docs/adr/0020-missing-20.md");
      expect(missing).not.toContain("0021-missing-21.md");
      expect(missing.endsWith("; and 2 more.")).toBe(true);

      const duplicates = files.flatMap((file, index) => [
        file,
        { fileName: adrFileName(index + 1, `other-${index + 1}`), sha256: file.sha256 },
      ]);
      const conflict = await expectError(
        await syncRequest(owner.token, projectId, duplicates),
        409,
        "CONFLICT",
      );
      expect(conflict).toContain("ADR-0020 (");
      expect(conflict).not.toContain("ADR-0021");
      expect(conflict.endsWith("; and 2 more.")).toBe(true);
    });

    it("refuses a manifest past the entry limit or outside a docs/adr directory", async () => {
      const file = await adrFile(1, "Limit");
      const entries = Array.from({ length: MAX_ADR_SYNC_ENTRIES + 1 }, (_, index) => ({
        fileName: adrFileName((index % MAX_ADR_NUMBER) + 1, `limit-${index}`),
        sha256: file.sha256,
      }));
      const tooMany = await call(owner.token, `/projects/${projectA}/adrs/sync`, {
        body: { commitSha: randomSha(), baseCommitSha: null, directory: "docs/adr", entries },
      });
      await expectError(tooMany, 400, "BAD_REQUEST");
      for (const directory of [
        "../docs/adr",
        "/docs/adr",
        "docs/adrs",
        "a//docs/adr",
        "a\\docs/adr",
      ]) {
        const response = await syncRequest(owner.token, projectA, [], { directory });
        expect([directory, response.status]).toEqual([directory, 400]);
      }
    });

    it("refuses a floor too far ahead and an exhausted number space with 409", async () => {
      const projectId = await api.createProject(owner);
      const tooHigh = await expectError(
        await reserve(owner.token, projectId, { floor: MAX_ADR_FLOOR_ADVANCE + 1 }),
        409,
        "CONFLICT",
      );
      expect(tooHigh).toContain("hivemind adr sync");
      // The largest allowed floor works.
      expect(
        (await reserved(owner.token, projectId, { floor: MAX_ADR_FLOOR_ADVANCE })).adr.number,
      ).toBe(MAX_ADR_FLOOR_ADVANCE + 1);

      const full = await api.createProject(owner);
      await api.testDb.db
        .update(project)
        .set({ nextAdrNumber: MAX_ADR_NUMBER + 1 })
        .where(eq(project.id, full));
      const exhausted = await expectError(await reserve(owner.token, full), 409, "CONFLICT");
      expect(exhausted).toBe(`This Project has used every ADR number up to ${MAX_ADR_NUMBER}.`);
      expect(await eventsOf(full)).toEqual([]);
    });

    it("refuses a reservation title that would not read back as the H1", async () => {
      for (const title of [" Leading", "Trailing ", "Closing #", "#", "Tab\there"]) {
        const response = await reserve(owner.token, projectA, { title });
        expect([title, response.status]).toEqual([title, 400]);
      }
      const csharp = await reserved(owner.token, projectA, { title: "Use C#", slug: "use-c" });
      expect(csharp.adr.title).toBe("Use C#");
    });
  });

  describe("replay", () => {
    it("returns the same number for a replayed reservation, as the ADR is now", async () => {
      const projectId = await api.createProject(owner);
      const body = { adrId: uuid(), title: "Replay me", slug: "replay-me", gitBranch: "feat/x" };
      const first = await reserved(owner.token, projectId, body);
      expect(first).toMatchObject({
        created: true,
        adr: {
          number: 1,
          state: "reserved",
          title: "Replay me",
          path: null,
          content: null,
          reservation: { gitBranch: "feat/x", reservedBy: { kind: "user", userId: owner.id } },
        },
      });
      // A changed floor is not part of the replay check, and a replay does
      // not apply it: the next reservation below still gets 2.
      const again = await reserved(owner.token, projectId, { ...body, floor: 5 });
      expect(again).toMatchObject({ created: false, adr: { id: first.adr.id, number: 1 } });
      expect(await eventsOf(projectId)).toHaveLength(1);

      await expectError(
        await reserve(owner.token, projectId, { ...body, title: "Other" }),
        409,
        "CONFLICT",
      );
      await expectError(await reserve(member.token, projectId, body), 409, "CONFLICT");
      // The ID is taken in another Project.
      await expectError(await reserve(owner.token, projectB, body), 404, "NOT_FOUND");

      // Once synced, a replay returns the published ADR.
      await synced(projectId, [await adrFile(1, "Replay me")]);
      const published = await reserved(owner.token, projectId, body);
      expect(published).toMatchObject({
        created: false,
        adr: { number: 1, state: "published", path: "docs/adr/0001-replay-me.md" },
      });
      expect(published.adr.content).not.toBeNull();
      const next = await reserved(owner.token, projectId);
      expect(next.adr.number).toBe(2);
    });

    it("answers a repeated sync of the same commit and files with changed: false", async () => {
      const projectId = await api.createProject(owner);
      const file = await adrFile(1, "Once");
      const commitSha = randomSha();
      const first = await synced(projectId, [file], { commitSha, baseCommitSha: null });
      const events = await eventsOf(projectId);
      // A retry of a lost answer sends the same base, which is now stale.
      const retry = await ok(
        await syncRequest(owner.token, projectId, [file], { commitSha, baseCommitSha: null }),
        syncAdrsOutputSchema,
      );
      expect(retry).toEqual({
        changed: false,
        lastSync: first.lastSync,
        previousCommitSha: commitSha,
        forced: false,
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 1,
        changes: [],
        warnings: { items: [], complete: true },
      });
      expect(await eventsOf(projectId)).toHaveLength(events.length);
    });
  });

  describe("ADR sync", () => {
    it("adds, updates, removes and restores ADRs, keeping removed copies", async () => {
      const projectId = await api.createProject(owner);
      const one = await adrFile(1, "One", { status: "accepted" });
      const two = await adrFile(2, "Two");
      const three = await adrFile(3, "Three");
      const c1 = randomSha();
      const first = await synced(projectId, [one, two, three], { commitSha: c1 });
      expect(first).toMatchObject({
        changed: true,
        previousCommitSha: null,
        forced: false,
        added: 3,
        updated: 0,
        removed: 0,
        unchanged: 0,
        // The first sync reports no unreserved numbers.
        warnings: { items: [], complete: true },
      });
      expect(first.changes).toEqual([
        {
          number: 1,
          change: "added",
          path: "docs/adr/0001-one.md",
          statusFrom: null,
          statusTo: "accepted",
        },
        {
          number: 2,
          change: "added",
          path: "docs/adr/0002-two.md",
          statusFrom: null,
          statusTo: "proposed",
        },
        {
          number: 3,
          change: "added",
          path: "docs/adr/0003-three.md",
          statusFrom: null,
          statusTo: "proposed",
        },
      ]);

      const threeAccepted = await adrFile(3, "Three", { status: "accepted" });
      const four = await adrFile(4, "Four");
      const c2 = randomSha();
      const second = await synced(projectId, [one, threeAccepted, four], {
        commitSha: c2,
        forced: true,
      });
      expect(second).toMatchObject({
        previousCommitSha: c1,
        forced: true,
        added: 1,
        updated: 1,
        removed: 1,
        unchanged: 1,
      });
      expect(
        second.changes.map((change) => [
          change.number,
          change.change,
          change.statusFrom,
          change.statusTo,
        ]),
      ).toEqual([
        [2, "removed", "proposed", null],
        [3, "updated", "proposed", "accepted"],
        [4, "added", null, "proposed"],
      ]);
      expect(second.warnings.items).toEqual([
        {
          number: 4,
          path: "docs/adr/0004-four.md",
          code: "ADR_NUMBER_UNRESERVED",
          message: "ADR-0004 was not reserved with hivemind adr new.",
        },
      ]);
      const removed = await getAdr(projectId, 2);
      expect(removed.adr).toMatchObject({
        state: "removed",
        status: "proposed",
        content: two.content,
        commitSha: c1,
      });
      expect(removed.lastSync?.commitSha).toBe(c2);
      expect((await getAdr(projectId, 3)).adr.commitSha).toBe(c2);
      expect((await getAdr(projectId, 1)).adr.commitSha).toBe(c1);

      const third = await synced(projectId, [one, two, threeAccepted]);
      expect(third.changes.map((change) => [change.number, change.change])).toEqual([
        [2, "restored"],
        [4, "removed"],
      ]);
      expect(third).toMatchObject({ added: 1, removed: 1, unchanged: 2 });
      expect((await getAdr(projectId, 2)).adr.state).toBe("published");
    });

    it("keeps the bound directory in paths", async () => {
      const projectId = await api.createProject(owner);
      const file = await adrFile(1, "Nested");
      const result = await synced(projectId, [file], { directory: "packages/app/docs/adr" });
      expect(result.changes[0]?.path).toBe("packages/app/docs/adr/0001-nested.md");
      expect((await getAdr(projectId, 1)).adr.path).toBe("packages/app/docs/adr/0001-nested.md");
    });

    it("reports a file that took a reserved number, and a renamed reserved file", async () => {
      const projectId = await api.createProject(owner);
      const taken = await reserved(owner.token, projectId, {
        title: "Use keyset pages",
        slug: "use-keyset-pages",
      });
      const renamed = await reserved(owner.token, projectId, {
        title: "Same title",
        slug: "same-title",
      });
      expect([taken.adr.number, renamed.adr.number]).toEqual([1, 2]);
      const result = await synced(projectId, [
        await adrFile(1, "Cache ADR pages"),
        await adrFile(2, "Same title", { slug: "other-slug" }),
      ]);
      // The first sync drops only the unreserved-number notices.
      expect(result.warnings).toEqual({
        complete: true,
        items: [
          {
            number: 1,
            path: "docs/adr/0001-cache-adr-pages.md",
            code: "ADR_RESERVATION_TAKEN",
            message:
              'ADR-0001 was reserved for "Use keyset pages" (use-keyset-pages), but ' +
              "docs/adr/0001-cache-adr-pages.md took the number. The reserved ADR needs a new " +
              "number: run hivemind adr new for it.",
          },
          {
            number: 2,
            path: "docs/adr/0002-other-slug.md",
            code: "ADR_SLUG_DIFFERS_FROM_RESERVATION",
            message:
              "docs/adr/0002-other-slug.md has the slug other-slug; ADR-0002 was reserved as same-title.",
          },
        ],
      });
      const { adr } = await getAdr(projectId, 1);
      expect(adr).toMatchObject({
        state: "published",
        title: "Cache ADR pages",
        slug: "cache-adr-pages",
        reservationTaken: true,
        reservation: { title: "Use keyset pages", slug: "use-keyset-pages" },
      });
      expect((await getAdr(projectId, 2)).adr.reservationTaken).toBe(false);
    });

    it("adds the supersedes-graph warnings of the synced set and links superseded ADRs", async () => {
      const projectId = await api.createProject(owner);
      const result = await synced(projectId, [
        await adrFile(1, "Old", { status: "superseded" }),
        await adrFile(2, "Orphaned", { status: "superseded" }),
        await adrFile(3, "New", { supersedes: [1] }),
        await adrFile(4, "Dangling", { supersedes: [9] }),
      ]);
      expect(
        result.warnings.items.map((warning) => [warning.number, warning.code, warning.path]),
      ).toEqual([
        [2, "ADR_SUPERSEDED_WITHOUT_SUCCESSOR", "docs/adr/0002-orphaned.md"],
        [4, "ADR_SUPERSEDES_MISSING_TARGET", "docs/adr/0004-dangling.md"],
      ]);
      const old = await getAdr(projectId, 1);
      expect(old.adr).toMatchObject({ status: "superseded", supersededBy: [3] });
      expect((await getAdr(projectId, 3)).adr).toMatchObject({ supersedes: [1], supersededBy: [] });
    });

    it("raises the counter past the synced numbers", async () => {
      const projectId = await api.createProject(owner);
      await synced(projectId, [await adrFile(40, "Forty")]);
      expect((await reserved(owner.token, projectId)).adr.number).toBe(41);
    });
  });

  describe("lists", () => {
    it("pages by number, filters by status and state, and never returns content", async () => {
      const projectId = await api.createProject(owner);
      await synced(projectId, [
        await adrFile(1, "One", { status: "accepted" }),
        await adrFile(2, "Two"),
        await adrFile(3, "Three", { status: "accepted" }),
      ]);
      const { adr: reservedAdr } = await reserved(owner.token, projectId);
      expect(reservedAdr.number).toBe(4);

      const response = await call(owner.token, `/projects/${projectId}/adrs?limit=1`);
      const raw = (await response.clone().json()) as { items: Record<string, unknown>[] };
      expect(raw.items[0]).not.toHaveProperty("content");
      const numbers: number[] = [];
      let page = adrPageSchema.parse(await response.json());
      for (;;) {
        numbers.push(...page.items.map((item) => item.number));
        expect(page.lastSync).not.toBeNull();
        if (!page.nextCursor) break;
        page = await list(projectId, `?limit=1&cursor=${page.nextCursor}`);
      }
      expect(numbers).toEqual([4, 3, 2, 1]);

      const accepted = await list(projectId, "?status=accepted");
      expect(accepted.items.map((item) => item.number)).toEqual([3, 1]);
      const reservedOnly = await list(projectId, "?state=reserved");
      expect(reservedOnly.items.map((item) => [item.number, item.status, item.path])).toEqual([
        [4, null, null],
      ]);
      expect((await list(projectId, "?state=reserved&status=accepted")).items).toEqual([]);

      // A cursor belongs to the list (filters included) that returned it.
      const filtered = await list(projectId, "?status=accepted&limit=1");
      if (!filtered.nextCursor) throw new Error("Expected a second page.");
      const foreign = await call(
        owner.token,
        `/projects/${projectId}/adrs?cursor=${filtered.nextCursor}`,
      );
      await expectError(foreign, 400, "BAD_REQUEST");
      await expectError(
        await call(owner.token, `/projects/${projectId}/adrs?status=draft`),
        400,
        "BAD_REQUEST",
      );
    });

    it("has no last sync before the first one", async () => {
      const projectId = await api.createProject(owner);
      expect(await list(projectId)).toEqual({ items: [], nextCursor: null, lastSync: null });
      await reserved(owner.token, projectId);
      expect((await getAdr(projectId, 1)).lastSync).toBeNull();
      const { lastSync } = await synced(projectId, [], { commitSha: "c".repeat(40) });
      expect(lastSync).toMatchObject({
        commitSha: "c".repeat(40),
        syncedBy: { kind: "user", userId: owner.id },
      });
      expect((await list(projectId)).lastSync).toEqual(lastSync);
    });

    it("lists removed ADRs with ?state=removed, keeping their last copy", async () => {
      const projectId = await api.createProject(owner);
      const one = await adrFile(1, "One", { status: "accepted" });
      const two = await adrFile(2, "Two");
      await synced(projectId, [one, two]);
      await synced(projectId, [one]);

      const removed = await list(projectId, "?state=removed");

      expect(removed.items).toEqual([
        expect.objectContaining({
          number: 2,
          state: "removed",
          title: "Two",
          status: "proposed",
          path: "docs/adr/0002-two.md",
          contentSha256: two.sha256,
        }),
      ]);
      expect((await list(projectId, "?state=removed&status=accepted")).items).toEqual([]);
      expect((await list(projectId, "?state=published")).items.map((i) => i.number)).toEqual([1]);
    });

    it("names a Project key as the principal of its sync", async () => {
      const projectId = await api.createProject(owner);
      const key = await api.createKey(owner, projectId);
      const file = await adrFile(1, "By a key");
      expect((await upload(key.secret, projectId, [file])).status).toBe(200);

      const result = await ok(
        await syncRequest(key.secret, projectId, [file], { baseCommitSha: null }),
        syncAdrsOutputSchema,
      );

      const syncedBy = { kind: "project_key", keyId: key.id };
      expect(result.lastSync).toMatchObject({ syncedBy });
      expect(result.lastSync.syncedBy).toEqual(syncedBy);
      expect((await list(projectId)).lastSync?.syncedBy).toEqual(syncedBy);
      expect((await getAdr(projectId, 1)).lastSync?.syncedBy).toEqual(syncedBy);
    });
  });

  describe("Events", () => {
    it("writes Events only from reserve and sync, one per transaction", async () => {
      const projectId = await api.createProject(owner);
      const count = async () => (await eventsOf(projectId)).length;
      const added = async (action: () => Promise<unknown>) => {
        const before = await count();
        await action();
        return (await count()) - before;
      };

      const body = { adrId: uuid(), title: "Evented", slug: "evented" };
      expect(await added(() => reserved(owner.token, projectId, body))).toBe(1);
      expect(await added(() => reserved(owner.token, projectId, body))).toBe(0);
      const file = await adrFile(1, "Evented");
      expect(await added(() => uploaded(projectId, [file]))).toBe(0);
      expect(await added(() => list(projectId))).toBe(0);
      expect(await added(() => getAdr(projectId, 1))).toBe(0);
      const commitSha = randomSha();
      expect(await added(() => synced(projectId, [file], { commitSha }))).toBe(1);
      expect(
        await added(async () => {
          await expectError(
            await syncRequest(owner.token, projectId, [file], { baseCommitSha: null }),
            409,
            "CONFLICT",
          );
        }),
      ).toBe(0);
      expect(await added(() => synced(projectId, [file], { commitSha, baseCommitSha: null }))).toBe(
        0,
      );
      // A sync that changes nothing still records that it ran.
      expect(await added(() => synced(projectId, [file]))).toBe(1);

      const page = eventPageSchema.parse(
        await (await call(owner.token, `/projects/${projectId}/events`)).json(),
      );
      // Newest first.
      expect(page.items.map((item) => item.type)).toEqual([
        "adr.synced",
        "adr.synced",
        "adr.reserved",
      ]);
      expect(page.items.some((item) => item.type === UNAVAILABLE_EVENT_TYPE)).toBe(false);
      const [, syncedEvent, reservedEvent] = page.items;
      expect(reservedEvent?.payload).toEqual({
        adrId: body.adrId,
        number: 1,
        title: "Evented",
        slug: "evented",
        floor: 0,
      });
      expect(syncedEvent?.payload).toEqual({
        commitSha,
        previousCommitSha: null,
        forced: false,
        added: 1,
        updated: 0,
        removed: 0,
        changes: [{ number: 1, change: "added", statusFrom: null, statusTo: "proposed" }],
        truncated: false,
      });
      // Content is never in an Event.
      expect(JSON.stringify(page)).not.toContain("## Context");
    });
  });

  describe("this repository's ADRs", () => {
    it("all parse, upload in one batch and sync", async () => {
      const projectId = await api.createProject(owner);
      const files = await repositoryAdrs();
      expect(files.length).toBeGreaterThanOrEqual(17);
      const result = await synced(projectId, files, { commitSha: randomSha() });
      expect(result.added).toBe(files.length);
      // Content warnings come back from the upload; the set has no relational problems.
      expect(result.warnings).toEqual({ items: [], complete: true });

      const items = [];
      let page = await list(projectId, "?limit=100");
      items.push(...page.items);
      while (page.nextCursor) {
        page = await list(projectId, `?limit=100&cursor=${page.nextCursor}`);
        items.push(...page.items);
      }
      expect(items.map((item) => item.path).sort()).toEqual(
        files.map((file) => `docs/adr/${file.fileName}`),
      );
      for (const file of files) {
        const parsed = parseAdrContent(file.content);
        if (!parsed.ok) throw new Error(`${file.fileName} does not parse.`);
        const number = Number(file.fileName.slice(0, 4));
        const { adr } = await getAdr(projectId, number);
        expect(adr).toMatchObject({
          state: "published",
          title: parsed.adr.title,
          status: parsed.adr.status,
          content: file.content,
          contentSha256: file.sha256,
        });
      }
      // The next reservation comes after the highest synced number.
      expect((await reserved(owner.token, projectId)).adr.number).toBe(files.length + 1);
    });
  });
});
