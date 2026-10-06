import { z } from "zod";
import { idSchema, pageSchema, paginationInputShape } from "./common.ts";

/**
 * Operations a Project key may perform in its bound Project. The server grants
 * every permission here to every Project key, including keys created before a
 * permission was added: adding coordination permissions in M2 lets existing
 * keys create Plans, run Sessions and claim Tasks (#12), and M4 lets them
 * reserve ADR numbers and run ADR sync (#19, ADR-0017). Permissions come
 * from this constant, never from a request or key metadata. Clients must
 * accept permission strings they do not know; the output schema checks the
 * `resource:action` form, not membership in this list.
 */
export const PROJECT_KEY_PERMISSIONS = [
  "project:read",
  "plan:read",
  "plan:write",
  "task:read",
  "task:write",
  "session:read",
  "session:write",
  "scope:read",
  "scope:write",
  "event:read",
  "adr:read",
  "adr:write",
] as const;

export type ProjectKeyPermission = (typeof PROJECT_KEY_PERMISSIONS)[number];

const permissionSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z-]*:[a-z][a-z-]*$/);

// User and Organization fields come from GitHub and better-auth. Their output
// schemas check only types and bounds: a stricter format check here would turn
// one unusual stored value into a 500 for that User.
export const userSchema = z.strictObject({
  id: idSchema,
  name: z.string().max(256),
  email: z.string().min(1).max(320),
});

export type User = z.infer<typeof userSchema>;

/**
 * An Organization as seen by one Member. `role` is the Member's role string
 * (`owner`, `admin`, `member`, or a role added later), so it is not an enum.
 */
export const organizationSchema = z.strictObject({
  id: idSchema,
  name: z.string().max(256),
  slug: z.string().max(256),
  role: z.string().min(1).max(64),
});

export type Organization = z.infer<typeof organizationSchema>;

/** A User signed in through a login session (browser cookie or CLI device login). */
export const userPrincipalSchema = z.strictObject({
  kind: z.literal("user"),
  user: userSchema,
  organizations: z.array(organizationSchema).optional(),
});

export type UserPrincipal = z.infer<typeof userPrincipalSchema>;

/**
 * A verified Project key. It is an organization credential bound to one
 * Project; it never stands in for a User, so it carries no user.
 */
export const projectKeyPrincipalSchema = z.strictObject({
  kind: z.literal("projectKey"),
  keyId: idSchema,
  organizationId: idSchema,
  projectId: idSchema,
  permissions: z.array(permissionSchema).max(64),
});

export type ProjectKeyPrincipal = z.infer<typeof projectKeyPrincipalSchema>;

/** Who the server resolved the caller's credential to. `GET /me` returns this. */
export const principalSchema = z.discriminatedUnion("kind", [
  userPrincipalSchema,
  projectKeyPrincipalSchema,
]);

export type Principal = z.infer<typeof principalSchema>;

export const meOutputSchema = principalSchema;

export type MeOutput = Principal;

/** `GET /organizations`: the caller's memberships. User principals only. */
export const listOrganizationsInputSchema = z.strictObject(paginationInputShape);

export type ListOrganizationsInput = z.input<typeof listOrganizationsInputSchema>;

export const organizationPageSchema = pageSchema(organizationSchema);

export type OrganizationPage = z.infer<typeof organizationPageSchema>;

/**
 * Who performed a coordination change, as recorded on Events and Plans. The
 * server derives it from the authenticated principal; no request field can
 * set it. A Project key acts as itself (its key ID is kept after the key is
 * revoked or deleted), never as the User who created it. `system` is the
 * maintenance sweep.
 */
export const ACTOR_KINDS = ["user", "project_key", "system"] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

export const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: idSchema }),
  z.strictObject({ kind: z.literal("project_key"), keyId: idSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);

export type Actor = z.infer<typeof actorSchema>;
