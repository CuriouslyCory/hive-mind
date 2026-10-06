import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  MAX_ADR_UPLOAD_BODY_BYTES,
  MAX_MANAGEMENT_BODY_BYTES,
  PROJECT_KEY_PERMISSIONS,
} from "@hivemind/contract";
import {
  type FakeServer,
  type RecordedRequest,
  sendJson,
  sendOrpcError,
  startServer,
} from "./api-server.ts";
import {
  createFakeCoordination,
  type FakeCoordination,
  type FakeOwner,
} from "./fake-coordination.ts";

/**
 * A small stateful stand-in for the web app's `/api/v1` and the better-auth
 * routes the CLI calls, following ADR-0009 and ADR-0013: bearer only,
 * user vs Project-key principals, 404 for inaccessible Projects, create-or-
 * reuse by organization and slug, owner-only key management, one-time key
 * secrets. Enough to drive every command and exit category without a
 * database; the real server is covered by apps/web tests and the e2e spec.
 */

export const USER_TOKEN = "user-login-token-0123456789abcdef";
export const SECOND_USER_TOKEN = "second-user-login-token-0123456789";

export interface FakeOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface FakeProject {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  repoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FakeKey {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  secret: string;
}

interface FakeUser {
  user: { id: string; name: string; email: string };
  organizations: FakeOrganization[];
}

export interface FakeBackend extends FakeServer {
  users: Map<string, FakeUser>;
  projects: Map<string, FakeProject>;
  keys: Map<string, FakeKey>;
  /** Make the next sign-out answer with this status (default 200). */
  signOutStatus: number;
  /** How the device flow ends after one `authorization_pending` (default approve). */
  deviceOutcome: "approve" | "deny";
  /** Login tokens handed out by the device flow, for "never printed" checks. */
  issuedTokens: string[];
  addProject(organizationId: string, slug: string, name?: string): FakeProject;
  /** Plans, Tasks, Sessions, Scopes and Events (fake-coordination.ts). */
  coordination: FakeCoordination;
}

export const ORG_A: FakeOrganization = {
  id: "6f0f8c1e-3f7a-4a0e-9a59-0d1b8f5b6c11",
  name: "Org A",
  slug: "org-a",
  role: "owner",
};
export const ORG_B: FakeOrganization = {
  id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Org B",
  slug: "org-b",
  role: "member",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function startFakeBackend(
  options: { organizations?: FakeOrganization[] } = {},
): Promise<FakeBackend> {
  const users = new Map<string, FakeUser>([
    [
      USER_TOKEN,
      {
        user: { id: randomUUID(), name: "Ada", email: "ada@example.com" },
        organizations: options.organizations ?? [ORG_A],
      },
    ],
    [
      SECOND_USER_TOKEN,
      {
        user: { id: randomUUID(), name: "Bob", email: "bob@example.com" },
        organizations: [{ ...ORG_B, role: "owner" }],
      },
    ],
  ]);
  const projects = new Map<string, FakeProject>();
  const keys = new Map<string, FakeKey>();
  const coordination = createFakeCoordination();
  const now = () => new Date().toISOString();
  let polls = 0;

  const addProject = (organizationId: string, slug: string, name = slug): FakeProject => {
    const project: FakeProject = {
      id: randomUUID(),
      organizationId,
      slug,
      name,
      repoUrl: null,
      createdAt: now(),
      updatedAt: now(),
    };
    projects.set(project.id, project);
    return project;
  };

  const publicKey = ({ secret: _secret, ...key }: FakeKey) => key;

  const handle = (request: RecordedRequest, response: ServerResponse): void | Promise<void> => {
    const url = new URL(request.url, "http://fake");
    const token = request.authorization?.replace(/^Bearer /, "") ?? null;
    const user = token ? users.get(token) : undefined;
    const key = token && !user ? [...keys.values()].find((k) => k.secret === token) : undefined;

    if (url.pathname === "/api/auth/device/code" && request.method === "POST") {
      polls = 0;
      sendJson(response, 200, {
        device_code: randomUUID().replaceAll("-", ""),
        user_code: "WDJBMJHT",
        verification_uri: `${backend.origin}/device`,
        verification_uri_complete: `${backend.origin}/device?user_code=WDJBMJHT`,
        expires_in: 600,
        // The real server says 5; one second keeps subprocess tests fast.
        interval: 1,
      });
      return;
    }
    if (url.pathname === "/api/auth/device/token" && request.method === "POST") {
      polls++;
      if (polls === 1) sendJson(response, 400, { error: "authorization_pending" });
      else if (backend.deviceOutcome === "deny")
        sendJson(response, 400, { error: "access_denied" });
      else {
        const issued = `device-login-${randomUUID()}`;
        backend.issuedTokens.push(issued);
        users.set(issued, users.get(USER_TOKEN) as FakeUser);
        sendJson(response, 200, { access_token: issued, token_type: "Bearer", expires_in: 604800 });
      }
      return;
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      if (backend.signOutStatus !== 200) {
        sendJson(response, backend.signOutStatus, { message: "unavailable" });
        return;
      }
      if (token) users.delete(token);
      sendJson(response, 200, { success: true });
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      sendJson(response, 404, {});
      return;
    }
    if (!user && !key) {
      sendOrpcError(
        response,
        401,
        "UNAUTHORIZED",
        "Authentication is missing, invalid or expired.",
      );
      return;
    }
    const parts = url.pathname.slice("/api/v1/".length).split("/");
    const body = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
    const forbidden = () =>
      sendOrpcError(response, 403, "FORBIDDEN", "This operation is not allowed.");
    const notFound = () => sendOrpcError(response, 404, "NOT_FOUND", "Not found.");
    const memberOf = (organizationId: string) =>
      user?.organizations.find((org) => org.id === organizationId);

    // GET /me
    if (parts[0] === "me" && parts.length === 1) {
      if (user) sendJson(response, 200, { kind: "user", ...user });
      else if (key)
        sendJson(response, 200, {
          kind: "projectKey",
          keyId: key.id,
          organizationId: key.organizationId,
          projectId: key.projectId,
          permissions: [...PROJECT_KEY_PERMISSIONS],
        });
      return;
    }
    if (parts[0] === "organizations" && parts.length === 1) {
      if (!user) {
        forbidden();
        return;
      }
      sendJson(response, 200, { items: user.organizations, nextCursor: null });
      return;
    }
    if (parts[0] !== "projects") {
      notFound();
      return;
    }

    if (parts.length === 1 && request.method === "GET") {
      if (!user) {
        forbidden();
        return;
      }
      const orgFilter = url.searchParams.get("organizationId");
      if (orgFilter && !memberOf(orgFilter)) {
        notFound();
        return;
      }
      const items = [...projects.values()].filter(
        (project) =>
          memberOf(project.organizationId) && (!orgFilter || project.organizationId === orgFilter),
      );
      sendJson(response, 200, { items, nextCursor: null });
      return;
    }
    if (parts.length === 1 && request.method === "POST") {
      if (!user) {
        forbidden();
        return;
      }
      const organizationId = String(body.organizationId);
      if (!memberOf(organizationId)) {
        notFound();
        return;
      }
      const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : null;
      const existing = [...projects.values()].find(
        (project) => project.organizationId === organizationId && project.slug === body.slug,
      );
      if (existing) {
        if (existing.name !== body.name || existing.repoUrl !== repoUrl) {
          sendOrpcError(response, 409, "CONFLICT", "A different Project uses this slug.");
          return;
        }
        sendJson(response, 200, { project: existing, created: false });
        return;
      }
      const project = addProject(organizationId, String(body.slug), String(body.name));
      project.repoUrl = repoUrl;
      sendJson(response, 200, { project, created: true });
      return;
    }

    const projectId = parts[1] ?? "";
    if (!UUID.test(projectId)) {
      sendOrpcError(response, 400, "BAD_REQUEST", "Input validation failed");
      return;
    }
    const project = projects.get(projectId);
    const readable =
      project && (user ? memberOf(project.organizationId) : key?.projectId === project.id);
    if (parts.length === 2 && request.method === "GET") {
      if (!project || !readable) {
        notFound();
        return;
      }
      sendJson(response, 200, project);
      return;
    }
    if (parts[2] !== "keys") {
      if (!project || !readable || parts.length < 3) {
        notFound();
        return;
      }
      // The server's request cap, enforced before parsing; the two ADR
      // upload routes have their own.
      const cap =
        request.method === "POST" && /^adrs\/(?:contents|sync)$/.test(parts.slice(2).join("/"))
          ? MAX_ADR_UPLOAD_BODY_BYTES
          : MAX_MANAGEMENT_BODY_BYTES;
      if (Buffer.byteLength(request.body) > cap) {
        sendOrpcError(response, 413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
        return;
      }
      const owner: FakeOwner = user
        ? { kind: "user", userId: user.user.id }
        : { kind: "key", keyId: (key as FakeKey).id };
      return coordination.handle(
        {
          method: request.method,
          projectId: project.id,
          parts: parts.slice(2),
          query: url.searchParams,
          body,
          owner,
        },
        response,
      );
    }
    if (!user) {
      forbidden();
      return;
    }
    if (!project || !readable) {
      notFound();
      return;
    }
    if (memberOf(project.organizationId)?.role !== "owner") {
      forbidden();
      return;
    }
    if (parts.length === 3 && request.method === "GET") {
      const items = [...keys.values()].filter((k) => k.projectId === project.id).map(publicKey);
      sendJson(response, 200, { items, nextCursor: null });
      return;
    }
    if (parts.length === 3 && request.method === "POST") {
      const days = typeof body.expiresInDays === "number" ? body.expiresInDays : null;
      const created: FakeKey = {
        id: randomUUID(),
        organizationId: project.organizationId,
        projectId: project.id,
        name: String(body.name),
        createdAt: now(),
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        secret: `hm_${randomUUID().replaceAll("-", "")}`,
      };
      keys.set(created.id, created);
      sendJson(response, 201, { projectKey: publicKey(created), secret: created.secret });
      return;
    }
    if (parts.length === 4 && request.method === "DELETE") {
      const target = keys.get(parts[3] ?? "");
      if (!target || target.projectId !== project.id) {
        notFound();
        return;
      }
      keys.delete(target.id);
      sendJson(response, 200, { id: target.id, projectId: project.id, revoked: true });
      return;
    }
    notFound();
  };

  const server = await startServer(handle);
  const backend: FakeBackend = {
    ...server,
    users,
    projects,
    keys,
    signOutStatus: 200,
    deviceOutcome: "approve",
    issuedTokens: [],
    addProject,
    coordination,
  };
  return backend;
}
