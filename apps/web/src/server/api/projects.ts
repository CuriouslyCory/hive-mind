import type { Project } from "@hivemind/contract";
import { createOrReuseProject } from "@hivemind/db";
import { member, project } from "@hivemind/db/schema";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { apiError, requireMembership, requireReadableProject, requireUser } from "./authorize";
import { api } from "./implementer";
import { after, decodeCursor, pageLimit, positionOf, toPage } from "./pagination";

/** A Project row as the contract's JSON. */
export function toProjectDto(row: typeof project.$inferSelect): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    name: row.name,
    repoUrl: row.repoUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `GET /projects`: Projects in the user's organizations, optionally one
 * organization. Users only; a Project key reads its Project with `GET
 * /projects/{id}`.
 */
export const listProjects = api.projects.list.handler(
  async ({ input, context: { principal, db } }) => {
    const user = requireUser(principal);
    if (input.organizationId) await requireMembership(db, user, input.organizationId);

    const limit = pageLimit(input.limit);
    const conditions: SQL[] = [];
    if (input.organizationId) conditions.push(eq(project.organizationId, input.organizationId));
    if (input.cursor) {
      conditions.push(after(project.createdAt, project.id, decodeCursor(input.cursor)));
    }
    const rows = await db
      .select({ project, id: project.id, position: positionOf(project.createdAt) })
      .from(project)
      .innerJoin(
        member,
        and(eq(member.organizationId, project.organizationId), eq(member.userId, user.user.id)),
      )
      .where(and(...conditions))
      .orderBy(asc(project.createdAt), asc(project.id))
      .limit(limit + 1);
    return toPage(rows, limit, (row) => toProjectDto(row.project));
  },
);

/**
 * `POST /projects`: create a Project, or return the existing one with the
 * same organization and slug when its name and repo URL are equal too. Any
 * member of the organization may; different data under the slug is 409.
 */
export const createProject = api.projects.create.handler(
  async ({ input, context: { principal, db } }) => {
    const user = requireUser(principal);
    await requireMembership(db, user, input.organizationId);

    // The contract has already bounded and validated each field; they are
    // stored and compared exactly as sent.
    const result = await createOrReuseProject(db, {
      organizationId: input.organizationId,
      slug: input.slug,
      name: input.name,
      repoUrl: input.repoUrl ?? null,
    });
    if (result.status === "conflict") {
      throw apiError(
        "CONFLICT",
        "A Project with this slug already exists in the organization with a different name or repo URL.",
      );
    }
    return { project: toProjectDto(result.project), created: result.status === "created" };
  },
);

/** `GET /projects/{id}`: for members of its organization and its own Project keys. */
export const getProject = api.projects.get.handler(async ({ input, context: { principal, db } }) =>
  toProjectDto(await requireReadableProject(db, principal, input.id)),
);
