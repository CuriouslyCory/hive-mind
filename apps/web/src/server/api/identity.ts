import type { Organization } from "@hivemind/contract";
import type { Db } from "@hivemind/db";
import { member, organization } from "@hivemind/db/schema";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { requireUser } from "./authorize";
import { api } from "./implementer";
import { after, decodeCursor, pageLimit, positionOf, toPage } from "./pagination";

/**
 * `GET /me`. A user's organizations come from their current memberships, so
 * a removed membership disappears on the next request. A Project key
 * describes itself: its key, organization, Project and permissions.
 */
export const me = api.me.handler(async ({ context: { principal, db } }) => {
  if (principal.kind === "projectKey") {
    const { keyId, organizationId, projectId, permissions } = principal;
    return { kind: "projectKey", keyId, organizationId, projectId, permissions: [...permissions] };
  }
  const { items } = await organizationsOf(db, principal.user.id, {});
  return { kind: "user", user: principal.user, organizations: items };
});

/** `GET /organizations`: the user's organizations, by membership. Users only. */
export const listOrganizations = api.organizations.list.handler(
  async ({ input, context: { principal, db } }) => {
    const user = requireUser(principal);
    return organizationsOf(db, user.user.id, input);
  },
);

/**
 * A page of the user's memberships, oldest first, so the first is the
 * personal organization. `/me` uses the first page.
 */
async function organizationsOf(
  db: Db,
  userId: string,
  input: { limit?: number | undefined; cursor?: string | undefined },
): Promise<{ items: Organization[]; nextCursor: string | null }> {
  const limit = pageLimit(input.limit);
  const conditions: SQL[] = [eq(member.userId, userId)];
  if (input.cursor) conditions.push(after(member.createdAt, member.id, decodeCursor(input.cursor)));
  const rows = await db
    .select({
      id: member.id,
      position: positionOf(member.createdAt),
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(...conditions))
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({
    id: row.organizationId,
    name: row.name,
    slug: row.slug,
    role: row.role,
  }));
}
