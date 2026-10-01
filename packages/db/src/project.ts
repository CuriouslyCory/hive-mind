import { and, eq } from "drizzle-orm";
import type { Db } from "./index.ts";
import { type Project, project } from "./schema/project.ts";

/** A Drizzle client or a transaction from `db.transaction`. */
export type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ProjectInput {
  organizationId: string;
  slug: string;
  name: string;
  repoUrl: string | null;
}

export type CreateOrReuseProjectResult =
  /** No Project had this slug in the organization; this call created it. */
  | { status: "created"; project: Project }
  /** A Project with this slug already existed with the same name and repo URL. */
  | { status: "existing"; project: Project }
  /** A Project with this slug exists with a different name or repo URL. Nothing changed. */
  | { status: "conflict"; project: Project };

/**
 * Creates the organization's Project with this slug, or returns the existing
 * one if its name and repo URL equal the input's. Inputs are compared exactly,
 * so callers normalize them first. The caller authorizes: this only writes.
 *
 * Safe under concurrency without locks: the insert skips on the unique
 * (organization_id, slug) constraint, waiting for any concurrent insert of
 * the same slug to commit or roll back, and the follow-up select then sees
 * the winner. Concurrent calls with equal inputs all return the same row; one
 * reports `created`. Run it at the default READ COMMITTED isolation, where
 * that select gets a fresh snapshot.
 */
export async function createOrReuseProject(
  db: DbOrTransaction,
  input: ProjectInput,
): Promise<CreateOrReuseProjectResult> {
  // A Project found by neither statement was deleted between them; Projects
  // are not deleted in M1, so a second attempt is enough.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [created] = await db
      .insert(project)
      .values(input)
      .onConflictDoNothing({ target: [project.organizationId, project.slug] })
      .returning();
    if (created) return { status: "created", project: created };

    const [existing] = await db
      .select()
      .from(project)
      .where(and(eq(project.organizationId, input.organizationId), eq(project.slug, input.slug)))
      .limit(1);
    if (!existing) continue;
    const equivalent = existing.name === input.name && existing.repoUrl === input.repoUrl;
    return { status: equivalent ? "existing" : "conflict", project: existing };
  }
  throw new Error(
    `Project ${input.slug} in organization ${input.organizationId} was deleted while being created.`,
  );
}
