import { oc } from "@orpc/contract";
import { listOrganizationsInputSchema, meOutputSchema, organizationPageSchema } from "./auth.ts";
import { apiErrorMap } from "./errors.ts";
import {
  createProjectKeyInputSchema,
  createProjectKeyOutputSchema,
  listProjectKeysInputSchema,
  projectKeyPageSchema,
  revokeProjectKeyInputSchema,
  revokeProjectKeyOutputSchema,
} from "./keys.ts";
import {
  createProjectInputSchema,
  createProjectOutputSchema,
  getProjectInputSchema,
  listProjectsInputSchema,
  projectPageSchema,
  projectSchema,
} from "./project.ts";

/**
 * Where the server mounts the contract. Route paths below are relative to it:
 * the server passes this as the OpenAPI handler's `prefix`, the CLI appends it
 * to the backend origin for its link's `url`, and the OpenAPI document lists
 * it as the server URL. Keeping the version out of the route paths lets a
 * future `/api/v2` reuse the same paths with a new contract.
 */
export const API_BASE_PATH = "/api/v1";

const base = oc.errors(apiErrorMap);

/**
 * The `/api/v1` contract. Every route needs a credential (a login-session
 * bearer token or a Project key) and answers 401 without one; it never
 * redirects to the web sign-in. Project keys may call only `me` and
 * `projects.get` for their own Project; everything else is user-only (403).
 * `operationId`s are fixed so generated clients keep their method names.
 */
export const apiContract = {
  me: base
    .route({
      method: "GET",
      path: "/me",
      successStatus: 200,
      operationId: "getMe",
      tags: ["Identity"],
      summary: "Describe the caller's principal",
    })
    .output(meOutputSchema),

  organizations: {
    list: base
      .route({
        method: "GET",
        path: "/organizations",
        successStatus: 200,
        operationId: "listOrganizations",
        tags: ["Identity"],
        summary: "List the caller's Organizations (user principals only)",
      })
      .input(listOrganizationsInputSchema)
      .output(organizationPageSchema),
  },

  projects: {
    list: base
      .route({
        method: "GET",
        path: "/projects",
        successStatus: 200,
        operationId: "listProjects",
        tags: ["Projects"],
        summary: "List Projects the caller can access (user principals only)",
      })
      .input(listProjectsInputSchema)
      .output(projectPageSchema),

    // 200, not 201: equivalent data returns the existing Project, and the
    // `created` flag says which happened.
    create: base
      .route({
        method: "POST",
        path: "/projects",
        successStatus: 200,
        operationId: "createProject",
        tags: ["Projects"],
        summary: "Create a Project, or return the equivalent existing one",
      })
      .input(createProjectInputSchema)
      .output(createProjectOutputSchema),

    get: base
      .route({
        method: "GET",
        path: "/projects/{id}",
        successStatus: 200,
        operationId: "getProject",
        tags: ["Projects"],
        summary: "Get a Project",
      })
      .input(getProjectInputSchema)
      .output(projectSchema),

    keys: {
      list: base
        .route({
          method: "GET",
          path: "/projects/{id}/keys",
          successStatus: 200,
          operationId: "listProjectKeys",
          tags: ["Project keys"],
          summary: "List a Project's active keys, without secrets (owners only)",
        })
        .input(listProjectKeysInputSchema)
        .output(projectKeyPageSchema),

      create: base
        .route({
          method: "POST",
          path: "/projects/{id}/keys",
          successStatus: 201,
          operationId: "createProjectKey",
          tags: ["Project keys"],
          summary: "Create a Project key; the response holds the raw key once (owners only)",
        })
        .input(createProjectKeyInputSchema)
        .output(createProjectKeyOutputSchema),

      revoke: base
        .route({
          method: "DELETE",
          path: "/projects/{id}/keys/{keyId}",
          successStatus: 200,
          operationId: "revokeProjectKey",
          tags: ["Project keys"],
          summary: "Revoke a Project key (owners only)",
        })
        .input(revokeProjectKeyInputSchema)
        .output(revokeProjectKeyOutputSchema),
    },
  },
};

export type ApiContract = typeof apiContract;
