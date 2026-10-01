import type { ProjectKey } from "@hivemind/contract";
import { apikey, projectApiKey } from "@hivemind/db/schema";
import { and, asc, eq, gt, inArray, isNull, or, type SQL } from "drizzle-orm";
import { apiError, requireKeyManager } from "./authorize";
import { api } from "./implementer";
import { after, decodeCursor, pageLimit, positionOf, toPage } from "./pagination";

// Project key management. Only organization owners reach these handlers'
// data (`requireKeyManager`). The api-key plugin's HTTP routes are disabled,
// so this is the only way to create, list or revoke a key, and every key it
// creates is bound to exactly one Project before its secret is returned.

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * `GET /projects/{id}/keys`: the Project's usable keys (enabled, not
 * expired), metadata only. The stored hash and the key's first characters are
 * never selected.
 */
export const listProjectKeys = api.projects.keys.list.handler(
  async ({ input, context: { principal, db } }) => {
    const { project } = await requireKeyManager(db, principal, input.id);

    const limit = pageLimit(input.limit);
    const conditions: (SQL | undefined)[] = [
      eq(projectApiKey.projectId, project.id),
      eq(apikey.referenceId, project.organizationId),
      eq(apikey.enabled, true),
      or(isNull(apikey.expiresAt), gt(apikey.expiresAt, new Date())),
    ];
    if (input.cursor) {
      conditions.push(after(apikey.createdAt, apikey.id, decodeCursor(input.cursor)));
    }
    const rows = await db
      .select({
        id: apikey.id,
        position: positionOf(apikey.createdAt),
        organizationId: projectApiKey.organizationId,
        projectId: projectApiKey.projectId,
        name: apikey.name,
        createdAt: apikey.createdAt,
        expiresAt: apikey.expiresAt,
      })
      .from(apikey)
      .innerJoin(
        projectApiKey,
        and(
          eq(projectApiKey.keyId, apikey.id),
          eq(projectApiKey.organizationId, apikey.referenceId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(apikey.createdAt), asc(apikey.id))
      .limit(limit + 1);
    return toPage(rows, limit, toProjectKeyDto);
  },
);

/**
 * `POST /projects/{id}/keys`. Authorizes first, then has the plugin create an
 * organization-owned key (it hashes and stores it), then binds it to the
 * Project. The plugin writes through its own adapter, so the two writes
 * cannot share a transaction: if binding fails, the key is deleted and no
 * secret is returned. A key left behind by a failed delete has no binding,
 * so it authenticates nothing (`resolvePrincipal` requires one).
 */
export const createProjectKey = api.projects.keys.create.handler(
  async ({ input, context: { principal, db, auth, serverHeaders } }) => {
    const { user, project } = await requireKeyManager(db, principal, input.id);

    // Called with the already-authorized user's id and headers that carry no
    // credential, so nothing is re-resolved from the request. The plugin
    // still checks the user's organization role itself. With headers present
    // it treats the call as a client request and accepts `remaining` only
    // as null (no usage limit), which is what Project keys need.
    const created = await auth.api.createApiKey({
      headers: serverHeaders,
      body: {
        remaining: null,
        userId: user.user.id,
        organizationId: project.organizationId,
        name: input.name,
        expiresIn:
          input.expiresInDays === undefined ? undefined : input.expiresInDays * SECONDS_PER_DAY,
      },
    });

    try {
      await db.insert(projectApiKey).values({
        keyId: created.id,
        projectId: project.id,
        organizationId: project.organizationId,
      });
    } catch (error) {
      await db
        .delete(apikey)
        .where(eq(apikey.id, created.id))
        .catch((cleanup: unknown) => {
          console.error(`Could not delete unbound Project key ${created.id}.`, cleanup);
        });
      throw error;
    }

    return {
      projectKey: toProjectKeyDto({
        id: created.id,
        organizationId: project.organizationId,
        projectId: project.id,
        name: created.name ?? input.name,
        createdAt: new Date(created.createdAt),
        expiresAt: created.expiresAt ? new Date(created.expiresAt) : null,
      }),
      secret: created.key,
    };
  },
);

/**
 * `DELETE /projects/{id}/keys/{keyId}`: deletes the key (its binding
 * cascades), like the plugin's own delete. Only a key bound to this Project
 * matches, so a key ID from another Project is 404, as is a key already
 * revoked.
 */
export const revokeProjectKey = api.projects.keys.revoke.handler(
  async ({ input, context: { principal, db } }) => {
    const { project } = await requireKeyManager(db, principal, input.id);
    const bound = db
      .select({ keyId: projectApiKey.keyId })
      .from(projectApiKey)
      .where(and(eq(projectApiKey.keyId, input.keyId), eq(projectApiKey.projectId, project.id)));
    const [deleted] = await db
      .delete(apikey)
      .where(
        and(
          eq(apikey.id, input.keyId),
          eq(apikey.referenceId, project.organizationId),
          inArray(apikey.id, bound),
        ),
      )
      .returning({ id: apikey.id });
    if (!deleted) throw apiError("NOT_FOUND", "Project key not found.");
    return { id: deleted.id, projectId: project.id, revoked: true };
  },
);

function toProjectKeyDto(row: {
  id: string;
  organizationId: string;
  projectId: string;
  name: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}): ProjectKey {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    // Keys are only created here, always with a name, but the plugin's column
    // is nullable, and an empty name would fail the contract's output check.
    name: row.name || "unnamed",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
