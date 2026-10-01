import { API_BASE_PATH } from "@hivemind/contract";
import { createTestDatabase, type TestDatabase } from "@hivemind/db/testing";
import { type TestHelpers, testUtils } from "better-auth/plugins";
import { createApiHandler } from "../../src/server/api/router";
import { allowedHosts, createAuth } from "../../src/server/auth";

// Harness for `/api/v1` tests: a fresh migrated database, a real better-auth
// instance on it (with the app's plugins, plus testUtils), and the same
// request handler the Next.js route serves. Requests run in process.
//
// Credentials are real: a user's bearer token is the token of a login
// session row created by better-auth (what the device flow hands the CLI),
// and Project keys come from `POST /projects/{id}/keys`.

export const ORIGIN = "http://localhost:3000";

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** JSON-encoded unless it is already a string. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SignedInUser {
  id: string;
  name: string;
  email: string;
  /** The user's personal organization, which they own. */
  organizationId: string;
  /** Login session token, used as a bearer token. */
  token: string;
}

export type ApiHarness = Awaited<ReturnType<typeof createApiHarness>>;

/** Call in `beforeAll` inside `describeDb`; call `drop` in `afterAll`. */
export async function createApiHarness() {
  const testDb: TestDatabase = await createTestDatabase();
  const auth = createAuth({
    db: testDb.db,
    secret: "test-better-auth-secret-0123456789abcdef",
    github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
    oauthProxySecret: "test-oauth-proxy-secret-0123456789abcdef",
    allowedHosts: allowedHosts({
      vercelEnv: undefined,
      productionURL: undefined,
      deploymentHosts: [],
    }),
    plugins: [testUtils()],
  });
  const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;
  const handle = createApiHandler(() => ({ auth, db: testDb.db }));

  /** A request to `/api/v1<path>` through the route handler. */
  async function request(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return handle(
      new Request(`${ORIGIN}${API_BASE_PATH}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
      }),
    );
  }

  /** A new user with their personal organization and a fresh login session. */
  async function signUp(): Promise<SignedInUser> {
    const user = await test.saveUser(test.createUser());
    const membership = await testDb.db.query.member.findFirst({
      where: (row, { eq }) => eq(row.userId, user.id),
    });
    if (!membership) throw new Error("The personal organization was not created.");
    const { token } = await test.login({ userId: user.id });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: membership.organizationId,
      token,
    };
  }

  /** Adds `user` to an organization with `role`. */
  async function addMember(organizationId: string, userId: string, role: string) {
    await testDb.pool.query(
      "insert into member (organization_id, user_id, role) values ($1, $2, $3)",
      [organizationId, userId, role],
    );
  }

  async function removeMember(organizationId: string, userId: string) {
    await testDb.pool.query("delete from member where organization_id = $1 and user_id = $2", [
      organizationId,
      userId,
    ]);
  }

  let projectCount = 0;

  /** Creates a Project through the API and returns its id. */
  async function createProject(owner: SignedInUser, organizationId = owner.organizationId) {
    projectCount += 1;
    const response = await request("/projects", {
      token: owner.token,
      body: { organizationId, slug: `project-${projectCount}`, name: `Project ${projectCount}` },
    });
    if (response.status !== 200) throw new Error(`createProject: ${await response.text()}`);
    const { project } = (await response.json()) as { project: { id: string } };
    return project.id;
  }

  /** Creates a Project key through the API. */
  async function createKey(
    owner: SignedInUser,
    projectId: string,
    body: { name?: string; expiresInDays?: number } = {},
  ): Promise<{ id: string; secret: string }> {
    const response = await request(`/projects/${projectId}/keys`, {
      token: owner.token,
      body: { name: "ci", ...body },
    });
    if (response.status !== 201) throw new Error(`createKey: ${await response.text()}`);
    const { projectKey, secret } = (await response.json()) as {
      projectKey: { id: string };
      secret: string;
    };
    return { id: projectKey.id, secret };
  }

  return {
    testDb,
    auth,
    test,
    handle,
    request,
    signUp,
    addMember,
    removeMember,
    createProject,
    createKey,
    drop: () => testDb.drop(),
  };
}

/** The `code` of an error response, after checking it is JSON with the contract's shape. */
export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { code?: unknown; status?: unknown; message?: unknown };
  if (body.status !== response.status || typeof body.message !== "string") {
    throw new Error(`Not a contract error body: ${JSON.stringify(body)}`);
  }
  return String(body.code);
}
