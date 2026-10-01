import { z } from "zod";
import {
  idSchema,
  nameSchema,
  pageSchema,
  paginationInputShape,
  timestampSchema,
} from "./common.ts";

export const MAX_KEY_NAME_LENGTH = 120;

// Matches the API-key plugin's default bounds (1 to 365 days). A relative
// lifetime keeps the CLI's clock out of the decision.
export const MIN_KEY_EXPIRES_IN_DAYS = 1;
export const MAX_KEY_EXPIRES_IN_DAYS = 365;

export const keyNameSchema = nameSchema(MAX_KEY_NAME_LENGTH);

/**
 * Metadata of a Project key. This is the only shape list and revoke responses
 * use, and it is strict, so a raw key or hash that reaches it fails the
 * server's output validation instead of being sent.
 */
export const projectKeySchema = z.strictObject({
  id: idSchema,
  organizationId: idSchema,
  projectId: idSchema,
  name: keyNameSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
});

export type ProjectKey = z.infer<typeof projectKeySchema>;

/** `GET /projects/{id}/keys`: active keys of the Project, metadata only. */
export const listProjectKeysInputSchema = z.strictObject({
  id: idSchema,
  ...paginationInputShape,
});

export type ListProjectKeysInput = z.input<typeof listProjectKeysInputSchema>;

export const projectKeyPageSchema = pageSchema(projectKeySchema);

export type ProjectKeyPage = z.infer<typeof projectKeyPageSchema>;

/**
 * `POST /projects/{id}/keys`. Without `expiresInDays` the server applies its
 * default. The key's permissions are not chosen by the caller: M1 keys get
 * `PROJECT_KEY_PERMISSIONS`.
 */
export const createProjectKeyInputSchema = z.strictObject({
  id: idSchema,
  name: keyNameSchema,
  expiresInDays: z.int().min(MIN_KEY_EXPIRES_IN_DAYS).max(MAX_KEY_EXPIRES_IN_DAYS).optional(),
});

export type CreateProjectKeyInput = z.input<typeof createProjectKeyInputSchema>;

/**
 * The raw key appears here and nowhere else, once: the server keeps only a
 * hash. Creation is not idempotent, so a client never retries it blindly after
 * a lost response; the user lists keys and revokes an unused one by ID.
 */
export const createProjectKeyOutputSchema = z.strictObject({
  projectKey: projectKeySchema,
  secret: z
    .string()
    .min(16)
    .max(512)
    .regex(/^[\x21-\x7e]+$/, "Must be printable ASCII without spaces."),
});

export type CreateProjectKeyOutput = z.infer<typeof createProjectKeyOutputSchema>;

/** `DELETE /projects/{id}/keys/{keyId}`. Revoking an already revoked or unknown key is NOT_FOUND. */
export const revokeProjectKeyInputSchema = z.strictObject({
  id: idSchema,
  keyId: idSchema,
});

export type RevokeProjectKeyInput = z.input<typeof revokeProjectKeyInputSchema>;

export const revokeProjectKeyOutputSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  revoked: z.literal(true),
});

export type RevokeProjectKeyOutput = z.infer<typeof revokeProjectKeyOutputSchema>;
