import {
  createProjectOutputSchema,
  MAX_MANAGEMENT_BODY_BYTES,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_SLUG_LENGTH,
  MAX_REPO_URL_LENGTH,
  projectPageSchema,
  projectSchema,
} from "@hivemind/contract";
import { describeDb } from "@hivemind/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, errorCode, type SignedInUser } from "./support/api";

describeDb("/api/v1 Projects", () => {
  let api: ApiHarness;
  let owner: SignedInUser;
  let slugCount = 0;

  function uniqueSlug() {
    slugCount += 1;
    return `repo-${slugCount}`;
  }

  beforeAll(async () => {
    api = await createApiHarness();
    owner = await api.signUp();
  });

  afterAll(async () => {
    await api?.drop();
  });

  function create(user: SignedInUser, body: Record<string, unknown>) {
    return api.request("/projects", { token: user.token, body });
  }

  describe("create", () => {
    it("creates a Project, then returns the same one for equivalent data", async () => {
      const body = {
        organizationId: owner.organizationId,
        slug: uniqueSlug(),
        name: "Hive",
        repoUrl: "git@github.com:octo/hive.git",
      };
      const first = await create(owner, body);
      expect(first.status).toBe(200);
      const created = createProjectOutputSchema.parse(await first.json());
      expect(created).toMatchObject({ created: true, project: { ...body } });

      const again = createProjectOutputSchema.parse(await (await create(owner, body)).json());
      expect(again).toEqual({ created: false, project: created.project });
    });

    it("answers 409 for the same slug with different data", async () => {
      const slug = uniqueSlug();
      await create(owner, { organizationId: owner.organizationId, slug, name: "One" });
      const response = await create(owner, {
        organizationId: owner.organizationId,
        slug,
        name: "Two",
      });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("CONFLICT");
    });

    it("returns one Project to concurrent equivalent requests", async () => {
      const body = { organizationId: owner.organizationId, slug: uniqueSlug(), name: "Race" };
      const responses = await Promise.all(Array.from({ length: 5 }, () => create(owner, body)));
      const results = await Promise.all(
        responses.map(async (response) => createProjectOutputSchema.parse(await response.json())),
      );
      expect(new Set(results.map((result) => result.project.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    });

    it("is open to every member, not only owners", async () => {
      const memberUser = await api.signUp();
      await api.addMember(owner.organizationId, memberUser.id, "member");
      const response = await create(memberUser, {
        organizationId: owner.organizationId,
        slug: uniqueSlug(),
        name: "By a member",
      });
      expect(response.status).toBe(200);
    });

    it("answers 404 in an organization the user is not a member of", async () => {
      const outsider = await api.signUp();
      const response = await create(outsider, {
        organizationId: owner.organizationId,
        slug: uniqueSlug(),
        name: "Intrusion",
      });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("NOT_FOUND");
    });

    it("is forbidden to Project keys", async () => {
      const projectId = await api.createProject(owner);
      const key = await api.createKey(owner, projectId);
      const response = await api.request("/projects", {
        token: key.secret,
        body: { organizationId: owner.organizationId, slug: uniqueSlug(), name: "By a key" },
      });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("FORBIDDEN");
    });
  });

  describe("input", () => {
    const valid = () => ({ organizationId: owner.organizationId, slug: uniqueSlug(), name: "Ok" });

    it.each([
      ["an invalid slug", { slug: "Not A Slug" }],
      ["a slug that is too long", { slug: "a".repeat(MAX_PROJECT_SLUG_LENGTH + 1) }],
      ["a name that is too long", { name: "n".repeat(MAX_PROJECT_NAME_LENGTH + 1) }],
      ["a blank name", { name: "   " }],
      ["a name with control characters", { name: "evil\u001b[2J" }],
      ["a repo URL with a password", { repoUrl: "https://user:token@github.com/o/r.git" }],
      ["a repo URL that is too long", { repoUrl: `https://h/${"r".repeat(MAX_REPO_URL_LENGTH)}` }],
      ["an organization id that is not a uuid", { organizationId: "org-1" }],
      ["an unknown field", { activeOrganizationId: "x" }],
    ])("answers 400 for %s", async (_case, override) => {
      const response = await create(owner, { ...valid(), ...override });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("BAD_REQUEST");
    });

    it("answers 400 for a body that is not JSON", async () => {
      const response = await api.request("/projects", { token: owner.token, body: "{not json" });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("BAD_REQUEST");
    });

    it("answers 400 for a Project id that is not a uuid", async () => {
      const response = await api.request("/projects/not-a-uuid", { token: owner.token });
      expect(response.status).toBe(400);
    });

    it("answers 413 for a body over the limit, declared or streamed", async () => {
      const big = JSON.stringify({ ...valid(), name: "x".repeat(MAX_MANAGEMENT_BODY_BYTES) });
      const declared = await create(owner, JSON.parse(big));
      expect(declared.status).toBe(413);
      expect(await errorCode(declared)).toBe("PAYLOAD_TOO_LARGE");

      // No content-length: the server counts bytes as they arrive.
      const encoded = new TextEncoder().encode(big);
      const streamed = await api.handle(
        new Request("http://localhost:3000/api/v1/projects", {
          method: "POST",
          headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
          body: new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < encoded.length; offset += 1024) {
                controller.enqueue(encoded.slice(offset, offset + 1024));
              }
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
      );
      expect(streamed.status).toBe(413);
      expect(await errorCode(streamed)).toBe("PAYLOAD_TOO_LARGE");
    });

    it("accepts a body of exactly the limit, and refuses one byte more", async () => {
      const json = JSON.stringify(valid());
      const padded = (size: number) => json + " ".repeat(size - json.length);
      const atLimit = await api.request("/projects", {
        token: owner.token,
        body: padded(MAX_MANAGEMENT_BODY_BYTES),
      });
      expect(atLimit.status).toBe(200);
      const over = await api.request("/projects", {
        token: owner.token,
        body: padded(MAX_MANAGEMENT_BODY_BYTES + 1),
      });
      expect(over.status).toBe(413);
    });
  });

  describe("get", () => {
    it("returns the Project to members and to its own key", async () => {
      const projectId = await api.createProject(owner);
      const key = await api.createKey(owner, projectId);
      for (const token of [owner.token, key.secret]) {
        const response = await api.request(`/projects/${projectId}`, { token });
        expect(response.status).toBe(200);
        expect(projectSchema.parse(await response.json())).toMatchObject({
          id: projectId,
          organizationId: owner.organizationId,
        });
      }
    });

    it("answers 404, not 403, for another organization's Project", async () => {
      const outsider = await api.signUp();
      const projectId = await api.createProject(owner);
      const hidden = await api.request(`/projects/${projectId}`, { token: outsider.token });
      const absent = await api.request(`/projects/${crypto.randomUUID()}`, {
        token: outsider.token,
      });
      expect(hidden.status).toBe(404);
      expect(absent.status).toBe(404);
      // Same body either way, so the answer does not tell them apart.
      expect(await hidden.json()).toEqual(await absent.json());
    });

    it("answers 404 to a key for another Project of its organization", async () => {
      const keyProject = await api.createProject(owner);
      const otherProject = await api.createProject(owner);
      const key = await api.createKey(owner, keyProject);
      const response = await api.request(`/projects/${otherProject}`, { token: key.secret });
      expect(response.status).toBe(404);
    });

    it("answers 404 to a key for another organization's Project", async () => {
      const other = await api.signUp();
      const otherProject = await api.createProject(other);
      const key = await api.createKey(owner, await api.createProject(owner));
      const response = await api.request(`/projects/${otherProject}`, { token: key.secret });
      expect(response.status).toBe(404);
    });

    it("stops answering once the user's membership is removed", async () => {
      const memberUser = await api.signUp();
      await api.addMember(owner.organizationId, memberUser.id, "member");
      const projectId = await api.createProject(owner);
      const path = `/projects/${projectId}`;
      expect((await api.request(path, { token: memberUser.token })).status).toBe(200);

      await api.removeMember(owner.organizationId, memberUser.id);
      expect((await api.request(path, { token: memberUser.token })).status).toBe(404);
      const list = projectPageSchema.parse(
        await (await api.request("/projects", { token: memberUser.token })).json(),
      );
      expect(list.items.map((project) => project.organizationId)).not.toContain(
        owner.organizationId,
      );
      const created = await create(memberUser, {
        organizationId: owner.organizationId,
        slug: uniqueSlug(),
        name: "After leaving",
      });
      expect(created.status).toBe(404);
    });
  });

  describe("list", () => {
    it("pages through the user's Projects without repeats", async () => {
      const user = await api.signUp();
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await api.createProject(user));

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
        const response = await api.request(`/projects${query}`, { token: user.token });
        expect(response.status).toBe(200);
        const page = projectPageSchema.parse(await response.json());
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((project) => project.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
    });

    it("filters by organization, and answers 404 for one the user is not in", async () => {
      const user = await api.signUp();
      const own = await api.createProject(user);
      await api.addMember(owner.organizationId, user.id, "member");
      await api.createProject(owner);

      const filtered = await api.request(`/projects?organizationId=${user.organizationId}`, {
        token: user.token,
      });
      expect(projectPageSchema.parse(await filtered.json()).items.map((p) => p.id)).toEqual([own]);

      const stranger = await api.signUp();
      const response = await api.request(`/projects?organizationId=${stranger.organizationId}`, {
        token: user.token,
      });
      expect(response.status).toBe(404);
    });

    it.each([
      ["a limit over the maximum", "?limit=101"],
      ["a zero limit", "?limit=0"],
      ["a malformed cursor", "?cursor=not!base64"],
      [
        "a cursor with an impossible date",
        `?cursor=${Buffer.from("2024-13-01T00:00:00.000000Z|00000000-0000-0000-0000-000000000001").toString("base64url")}`,
      ],
      ["a cursor this server did not issue", `?cursor=${Buffer.from("x|y").toString("base64url")}`],
    ])("answers 400 for %s", async (_case, query) => {
      const response = await api.request(`/projects${query}`, { token: owner.token });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("BAD_REQUEST");
    });

    it("is forbidden to Project keys, as is listing organizations", async () => {
      const key = await api.createKey(owner, await api.createProject(owner));
      for (const path of ["/projects", "/organizations"]) {
        const response = await api.request(path, { token: key.secret });
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe("FORBIDDEN");
      }
    });

    it("lists the user's organizations by membership", async () => {
      const response = await api.request("/organizations", { token: owner.token });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [expect.objectContaining({ id: owner.organizationId, role: "owner" })],
        nextCursor: null,
      });
    });
  });
});
