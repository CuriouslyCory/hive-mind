import { z } from "zod";
import {
  idSchema,
  nameSchema,
  pageSchema,
  paginationInputShape,
  timestampSchema,
} from "./common.ts";

export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_PROJECT_SLUG_LENGTH = 63;
export const MAX_REPO_URL_LENGTH = 2048;

export const projectNameSchema = nameSchema(MAX_PROJECT_NAME_LENGTH);

/**
 * Lowercase letters, digits and hyphens, without a leading or trailing hyphen:
 * a DNS label, so a slug fits in a hostname or a path segment unescaped.
 */
export const projectSlugSchema = z
  .string()
  .min(1)
  .max(MAX_PROJECT_SLUG_LENGTH)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Use lowercase letters, digits and hyphens, without a leading or trailing hyphen.",
  );

const URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);

// scp-like syntax that git accepts for SSH remotes: `git@github.com:owner/repo.git`.
// The user is required, which keeps it distinct from a Windows path or `host:port`.
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/;

/**
 * A git remote as the user would pass it to `git clone`: an `https://`,
 * `http://`, `ssh://` or `git://` URL with a host, or scp-like
 * `user@host:path`. A password is always rejected, and http(s)/git URLs may not
 * carry a username either, so a token pasted into a clone URL is not stored
 * and later displayed. `ssh://` keeps its username (`ssh://git@host/...`).
 * The value is stored and shown as data; nothing in hive-mind clones it.
 */
export function isRepoUrl(value: string): boolean {
  if (/[\s\p{Cc}]/u.test(value)) return false;
  if (SCP_LIKE.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!URL_SCHEMES.has(url.protocol) || url.hostname === "") return false;
  if (url.password !== "") return false;
  if (url.username !== "" && url.protocol !== "ssh:") return false;
  return true;
}

export const repoUrlSchema = z
  .string()
  .min(1)
  .max(MAX_REPO_URL_LENGTH)
  .refine(isRepoUrl, "Use an https, http, ssh or git URL, or user@host:path, without credentials.");

export const projectSchema = z.strictObject({
  id: idSchema,
  organizationId: idSchema,
  slug: projectSlugSchema,
  name: projectNameSchema,
  repoUrl: repoUrlSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Project = z.infer<typeof projectSchema>;

/**
 * `POST /projects`. Create-or-reuse by (organizationId, slug): equivalent data
 * returns the existing Project with `created: false`; a different name or repo
 * URL for an existing slug is CONFLICT.
 */
export const createProjectInputSchema = z.strictObject({
  organizationId: idSchema,
  name: projectNameSchema,
  slug: projectSlugSchema,
  repoUrl: repoUrlSchema.optional(),
});

export type CreateProjectInput = z.input<typeof createProjectInputSchema>;

export const createProjectOutputSchema = z.strictObject({
  project: projectSchema,
  created: z.boolean(),
});

export type CreateProjectOutput = z.infer<typeof createProjectOutputSchema>;

/** `GET /projects`: Projects the caller can access, optionally in one Organization. */
export const listProjectsInputSchema = z.strictObject({
  organizationId: idSchema.optional(),
  ...paginationInputShape,
});

export type ListProjectsInput = z.input<typeof listProjectsInputSchema>;

export const projectPageSchema = pageSchema(projectSchema);

export type ProjectPage = z.infer<typeof projectPageSchema>;

/** `GET /projects/{id}`. */
export const getProjectInputSchema = z.strictObject({
  id: idSchema,
});

export type GetProjectInput = z.input<typeof getProjectInputSchema>;
