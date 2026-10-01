import {
  createProjectKeyOutputSchema,
  MAX_KEY_NAME_LENGTH,
  projectKeyPageSchema,
  revokeProjectKeyOutputSchema,
} from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_KEY_PREFIX } from "../src/server/auth";
import { type ApiHarness, createApiHarness, errorCode, type SignedInUser } from "./support/api";

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb("/api/v1 Project keys", () => {
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

  const keysPath = (id = projectId) => `/projects/${id}/keys`;

  async function keyCount(organizationId = owner.organizationId): Promise<number> {
    const result = await api.testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from apikey where reference_id = $1",
      [organizationId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function listIds(token = owner.token, id = projectId): Promise<string[]> {
    const response = await api.request(keysPath(id), { token });
    expect(response.status).toBe(200);
    return projectKeyPageSchema.parse(await response.json()).items.map((key) => key.id);
  }

  describe("create", () => {
    it("returns the raw key once, bound to the Project", async () => {
      const before = Date.now();
      const response = await api.request(keysPath(), {
        token: owner.token,
        body: { name: "deploy", expiresInDays: 30 },
      });
      expect(response.status).toBe(201);
      const { projectKey, secret } = createProjectKeyOutputSchema.parse(await response.json());
      expect(secret.startsWith(PROJECT_KEY_PREFIX)).toBe(true);
      expect(projectKey).toMatchObject({
        organizationId: owner.organizationId,
        projectId,
        name: "deploy",
      });
      const expiresAt = Date.parse(projectKey.expiresAt ?? "");
      expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS + 1000);

      const binding = await api.testDb.pool.query(
        "select project_id, organization_id from project_api_key where key_id = $1",
        [projectKey.id],
      );
      expect(binding.rows).toEqual([
        { project_id: projectId, organization_id: owner.organizationId },
      ]);
      // Only the hash is stored.
      const stored = await api.testDb.pool.query("select key from apikey where id = $1", [
        projectKey.id,
      ]);
      expect(stored.rows[0]?.key).not.toBe(secret);
    });

    it("has no expiry unless asked for one", async () => {
      const response = await api.request(keysPath(), { token: owner.token, body: { name: "ci" } });
      const { projectKey } = createProjectKeyOutputSchema.parse(await response.json());
      expect(projectKey.expiresAt).toBeNull();
    });

    it.each([
      ["no name", {}],
      ["a blank name", { name: " " }],
      ["a name that is too long", { name: "k".repeat(MAX_KEY_NAME_LENGTH + 1) }],
      ["a zero expiry", { name: "k", expiresInDays: 0 }],
      ["an expiry over a year", { name: "k", expiresInDays: 366 }],
      ["a fractional expiry", { name: "k", expiresInDays: 1.5 }],
      ["caller-chosen permissions", { name: "k", permissions: { project: ["write"] } }],
      ["a caller-chosen prefix", { name: "k", prefix: "xx_" }],
    ])("answers 400 for %s, creating nothing", async (_case, body) => {
      const before = await keyCount();
      const response = await api.request(keysPath(), { token: owner.token, body });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("BAD_REQUEST");
      expect(await keyCount()).toBe(before);
    });

    it("deletes the key and returns no secret when binding fails", async () => {
      const before = await keyCount();
      // Injected failure: the binding insert raises after the plugin has
      // created the key.
      await api.testDb.pool.query(`
        create function fail_binding() returns trigger language plpgsql as $$
        begin raise exception 'injected binding failure'; end $$;
        create trigger fail_binding before insert on project_api_key
        for each row execute function fail_binding();
      `);
      try {
        const response = await api.request(keysPath(), {
          token: owner.token,
          body: { name: "doomed" },
        });
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).not.toContain(PROJECT_KEY_PREFIX);
        expect(JSON.parse(text)).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
      } finally {
        await api.testDb.pool.query(
          "drop trigger fail_binding on project_api_key; drop function fail_binding();",
        );
      }
      expect(await keyCount()).toBe(before);
    });
  });

  describe("list", () => {
    it("shows usable keys as metadata only, in pages", async () => {
      const user = await api.signUp();
      const project = await api.createProject(user);
      const keys = [];
      for (let i = 0; i < 3; i++) keys.push(await api.createKey(user, project, { name: `k${i}` }));
      // Expired and revoked keys are not listed.
      await api.testDb.pool.query(
        "update apikey set expires_at = now() - interval '1 second' where id = $1",
        [keys[1]?.id],
      );
      const revoked = await api.createKey(user, project);
      await api.request(`${keysPath(project)}/${revoked.id}`, {
        method: "DELETE",
        token: user.token,
      });

      const first = await api.request(`${keysPath(project)}?limit=1`, { token: user.token });
      const raw = await first.text();
      for (const key of keys) expect(raw).not.toContain(key.secret);
      const page = projectKeyPageSchema.parse(JSON.parse(raw));
      expect(page.items.map((key) => key.id)).toEqual([keys[0]?.id]);
      expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(
        ["createdAt", "expiresAt", "id", "name", "organizationId", "projectId"].sort(),
      );

      const second = await api.request(`${keysPath(project)}?limit=1&cursor=${page.nextCursor}`, {
        token: user.token,
      });
      const rest = projectKeyPageSchema.parse(await second.json());
      expect(rest).toEqual({
        items: [expect.objectContaining({ id: keys[2]?.id })],
        nextCursor: null,
      });
    });

    it("shows only the Project's own keys", async () => {
      const other = await api.createProject(owner);
      const otherKey = await api.createKey(owner, other);
      expect(await listIds()).not.toContain(otherKey.id);
      expect(await listIds(owner.token, other)).toEqual([otherKey.id]);
    });
  });

  describe("revoke", () => {
    it("revokes by id, and answers 404 the second time", async () => {
      const key = await api.createKey(owner, projectId);
      const path = `${keysPath()}/${key.id}`;
      const response = await api.request(path, { method: "DELETE", token: owner.token });
      expect(response.status).toBe(200);
      expect(revokeProjectKeyOutputSchema.parse(await response.json())).toEqual({
        id: key.id,
        projectId,
        revoked: true,
      });
      expect(await listIds()).not.toContain(key.id);
      expect((await api.request("/me", { token: key.secret })).status).toBe(401);

      const again = await api.request(path, { method: "DELETE", token: owner.token });
      expect(again.status).toBe(404);
      expect(await errorCode(again)).toBe("NOT_FOUND");
    });

    it("answers 404 for an unknown key id", async () => {
      const response = await api.request(`${keysPath()}/${crypto.randomUUID()}`, {
        method: "DELETE",
        token: owner.token,
      });
      expect(response.status).toBe(404);
    });

    it("does not revoke another Project's key through this Project", async () => {
      const other = await api.createProject(owner);
      const otherKey = await api.createKey(owner, other);
      const response = await api.request(`${keysPath()}/${otherKey.id}`, {
        method: "DELETE",
        token: owner.token,
      });
      expect(response.status).toBe(404);
      expect((await api.request("/me", { token: otherKey.secret })).status).toBe(200);
    });
  });

  describe("authorization", () => {
    let memberUser: SignedInUser;
    let outsider: SignedInUser;
    let existingKey: { id: string; secret: string };

    beforeAll(async () => {
      memberUser = await api.signUp();
      await api.addMember(owner.organizationId, memberUser.id, "member");
      outsider = await api.signUp();
      existingKey = await api.createKey(owner, projectId);
    });

    const operations = () =>
      [
        ["list", { method: "GET", path: keysPath() }],
        ["create", { method: "POST", path: keysPath(), body: { name: "x" } }],
        ["revoke", { method: "DELETE", path: `${keysPath()}/${existingKey.id}` }],
      ] as const;

    async function attempt(token: string) {
      const results: Record<string, [number, string]> = {};
      for (const [name, { method, path, ...rest }] of operations()) {
        const response = await api.request(path, { method, token, ...rest });
        results[name] = [response.status, await errorCode(response)];
      }
      return results;
    }

    it("is forbidden to members who are not owners", async () => {
      const before = await keyCount();
      expect(await attempt(memberUser.token)).toEqual({
        list: [403, "FORBIDDEN"],
        create: [403, "FORBIDDEN"],
        revoke: [403, "FORBIDDEN"],
      });
      expect(await keyCount()).toBe(before);
    });

    it("is not found for users outside the organization", async () => {
      const before = await keyCount();
      expect(await attempt(outsider.token)).toEqual({
        list: [404, "NOT_FOUND"],
        create: [404, "NOT_FOUND"],
        revoke: [404, "NOT_FOUND"],
      });
      expect(await keyCount()).toBe(before);
    });

    it("is forbidden to Project keys, even for their own Project", async () => {
      const before = await keyCount();
      expect(await attempt(existingKey.secret)).toEqual({
        list: [403, "FORBIDDEN"],
        create: [403, "FORBIDDEN"],
        revoke: [403, "FORBIDDEN"],
      });
      expect(await keyCount()).toBe(before);
      expect((await api.request("/me", { token: existingKey.secret })).status).toBe(200);
    });

    it("ends for an owner whose membership is removed", async () => {
      const departing = await api.signUp();
      const project = await api.createProject(departing);
      await api.removeMember(departing.organizationId, departing.id);
      const response = await api.request(keysPath(project), {
        token: departing.token,
        body: { name: "late" },
      });
      expect(response.status).toBe(404);
      expect(await keyCount(departing.organizationId)).toBe(0);
    });
  });
});
