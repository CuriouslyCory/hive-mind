import { eventIterator, oc } from "@orpc/contract";
import { listOrganizationsInputSchema, meOutputSchema, organizationPageSchema } from "./auth.ts";
import { apiErrorMap } from "./errors.ts";
import {
  appendPlanLogInputSchema,
  appendPlanLogOutputSchema,
  eventPageSchema,
  listPlanLogInputSchema,
  listProjectEventsInputSchema,
  listSessionEventsInputSchema,
} from "./event.ts";
import { eventStreamFrameSchema, streamProjectEventsInputSchema } from "./event-stream.ts";
import {
  createProjectKeyInputSchema,
  createProjectKeyOutputSchema,
  listProjectKeysInputSchema,
  projectKeyPageSchema,
  revokeProjectKeyInputSchema,
  revokeProjectKeyOutputSchema,
} from "./keys.ts";
import {
  createPlanInputSchema,
  createPlanOutputSchema,
  getPlanInputSchema,
  listPlansInputSchema,
  planPageSchema,
  planSchema,
  setPlanStatusInputSchema,
  setPlanStatusOutputSchema,
  updatePlanInputSchema,
  updatePlanOutputSchema,
} from "./plan.ts";
import {
  createProjectInputSchema,
  createProjectOutputSchema,
  getProjectInputSchema,
  listProjectsInputSchema,
  projectPageSchema,
  projectSchema,
} from "./project.ts";
import {
  addSessionScopeInputSchema,
  addSessionScopeOutputSchema,
  checkSessionOverlapsInputSchema,
  collectionOutputSchema,
  finalizeCollectionInputSchema,
  listSessionScopesInputSchema,
  overlapPageSchema,
  registerCollectionManifestInputSchema,
  removeSessionScopeInputSchema,
  removeSessionScopeOutputSchema,
  scopePageSchema,
  uploadCollectionBatchInputSchema,
  uploadCollectionBatchOutputSchema,
} from "./scope.ts";
import {
  attachSessionInputSchema,
  endSessionInputSchema,
  endSessionOutputSchema,
  getSessionInputSchema,
  heartbeatSessionInputSchema,
  heartbeatSessionOutputSchema,
  listSessionClaimsInputSchema,
  listSessionsInputSchema,
  sessionChangeOutputSchema,
  sessionPageSchema,
  sessionSchema,
  startSessionInputSchema,
  startSessionOutputSchema,
  updateSessionInputSchema,
} from "./session.ts";
import { getProjectStatusInputSchema, projectStatusSchema } from "./status.ts";
import {
  addTaskInputSchema,
  addTaskOutputSchema,
  blockTaskInputSchema,
  claimTaskInputSchema,
  claimTaskOutputSchema,
  completeTaskInputSchema,
  listPlanTasksInputSchema,
  releaseTaskInputSchema,
  startTaskInputSchema,
  taskActionOutputSchema,
  taskPageSchema,
} from "./task.ts";

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
 * redirects to the web sign-in. Organization and Project enumeration, Project
 * creation and key management are user-only (403 for a Project key). The
 * coordination routes under `/projects/{id}` (Plans, Tasks, Sessions, Scopes,
 * Events, status) accept Members of the Project's Organization and keys bound
 * to that Project with the route's permission from `PROJECT_KEY_PERMISSIONS`.
 * An inaccessible Project or a nested ID from elsewhere is the same 404 as an
 * absent one. `operationId`s are fixed so generated clients keep their method
 * names.
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

    // Coordination (#12). Creates return 200 with `{ <resource>, created }`:
    // a retry with the same client-generated UUID and input returns the
    // existing record. State changes return 200 with `changed`.
    plans: {
      list: base
        .route({
          method: "GET",
          path: "/projects/{id}/plans",
          successStatus: 200,
          operationId: "listPlans",
          tags: ["Plans"],
          summary: "List a Project's Plans",
        })
        .input(listPlansInputSchema)
        .output(planPageSchema),

      create: base
        .route({
          method: "POST",
          path: "/projects/{id}/plans",
          successStatus: 200,
          operationId: "createPlan",
          tags: ["Plans"],
          summary: "Create a Plan, or return the one created with this ID",
        })
        .input(createPlanInputSchema)
        .output(createPlanOutputSchema),

      get: base
        .route({
          method: "GET",
          path: "/projects/{id}/plans/{planRef}",
          successStatus: 200,
          operationId: "getPlan",
          tags: ["Plans"],
          summary: "Get a Plan by key (PLAN-N) or UUID, without its Tasks or Events",
        })
        .input(getPlanInputSchema)
        .output(planSchema),

      update: base
        .route({
          method: "PATCH",
          path: "/projects/{id}/plans/{planRef}",
          successStatus: 200,
          operationId: "updatePlan",
          tags: ["Plans"],
          summary: "Edit a Plan's title or body",
        })
        .input(updatePlanInputSchema)
        .output(updatePlanOutputSchema),

      setStatus: base
        .route({
          method: "POST",
          path: "/projects/{id}/plans/{planRef}/status",
          successStatus: 200,
          operationId: "setPlanStatus",
          tags: ["Plans"],
          summary: "Move a Plan to another lifecycle status",
        })
        .input(setPlanStatusInputSchema)
        .output(setPlanStatusOutputSchema),

      log: {
        list: base
          .route({
            method: "GET",
            path: "/projects/{id}/plans/{planRef}/log",
            successStatus: 200,
            operationId: "listPlanLog",
            tags: ["Plans"],
            summary: "List a Plan's activity, log entries included",
          })
          .input(listPlanLogInputSchema)
          .output(eventPageSchema),

        append: base
          .route({
            method: "POST",
            path: "/projects/{id}/plans/{planRef}/log",
            successStatus: 200,
            operationId: "appendPlanLog",
            tags: ["Plans"],
            summary: "Append a markdown entry to a Plan's log",
          })
          .input(appendPlanLogInputSchema)
          .output(appendPlanLogOutputSchema),
      },

      tasks: {
        list: base
          .route({
            method: "GET",
            path: "/projects/{id}/plans/{planRef}/tasks",
            successStatus: 200,
            operationId: "listPlanTasks",
            tags: ["Tasks"],
            summary: "List a Plan's Tasks in order",
          })
          .input(listPlanTasksInputSchema)
          .output(taskPageSchema),

        add: base
          .route({
            method: "POST",
            path: "/projects/{id}/plans/{planRef}/tasks",
            successStatus: 200,
            operationId: "addTask",
            tags: ["Tasks"],
            summary: "Add a Task to a Plan, or return the one added with this ID",
          })
          .input(addTaskInputSchema)
          .output(addTaskOutputSchema),
      },
    },

    tasks: {
      claim: base
        .route({
          method: "POST",
          path: "/projects/{id}/tasks/{taskId}/claim",
          successStatus: 200,
          operationId: "claimTask",
          tags: ["Tasks"],
          summary: "Claim a Task for the caller's Session, or take it over with steal",
        })
        .input(claimTaskInputSchema)
        .output(claimTaskOutputSchema),

      release: base
        .route({
          method: "POST",
          path: "/projects/{id}/tasks/{taskId}/release",
          successStatus: 200,
          operationId: "releaseTask",
          tags: ["Tasks"],
          summary: "Release the caller's Session's claim on a Task",
        })
        .input(releaseTaskInputSchema)
        .output(taskActionOutputSchema),

      start: base
        .route({
          method: "POST",
          path: "/projects/{id}/tasks/{taskId}/start",
          successStatus: 200,
          operationId: "startTask",
          tags: ["Tasks"],
          summary: "Start a claimed Task",
        })
        .input(startTaskInputSchema)
        .output(taskActionOutputSchema),

      block: base
        .route({
          method: "POST",
          path: "/projects/{id}/tasks/{taskId}/block",
          successStatus: 200,
          operationId: "blockTask",
          tags: ["Tasks"],
          summary: "Mark a claimed Task blocked, with a reason",
        })
        .input(blockTaskInputSchema)
        .output(taskActionOutputSchema),

      done: base
        .route({
          method: "POST",
          path: "/projects/{id}/tasks/{taskId}/done",
          successStatus: 200,
          operationId: "completeTask",
          tags: ["Tasks"],
          summary: "Mark a claimed Task done and clear its claim",
        })
        .input(completeTaskInputSchema)
        .output(taskActionOutputSchema),
    },

    sessions: {
      list: base
        .route({
          method: "GET",
          path: "/projects/{id}/sessions",
          successStatus: 200,
          operationId: "listSessions",
          tags: ["Sessions"],
          summary: "List a Project's Sessions, current and past",
        })
        .input(listSessionsInputSchema)
        .output(sessionPageSchema),

      start: base
        .route({
          method: "POST",
          path: "/projects/{id}/sessions",
          successStatus: 200,
          operationId: "startSession",
          tags: ["Sessions"],
          summary: "Start a Session owned by the caller, or return the one started with this ID",
        })
        .input(startSessionInputSchema)
        .output(startSessionOutputSchema),

      get: base
        .route({
          method: "GET",
          path: "/projects/{id}/sessions/{sessionId}",
          successStatus: 200,
          operationId: "getSession",
          tags: ["Sessions"],
          summary: "Get a Session",
        })
        .input(getSessionInputSchema)
        .output(sessionSchema),

      update: base
        .route({
          method: "PATCH",
          path: "/projects/{id}/sessions/{sessionId}",
          successStatus: 200,
          operationId: "updateSession",
          tags: ["Sessions"],
          summary: "Edit the caller's Session's metadata or live status",
        })
        .input(updateSessionInputSchema)
        .output(sessionChangeOutputSchema),

      heartbeat: base
        .route({
          method: "POST",
          path: "/projects/{id}/sessions/{sessionId}/heartbeat",
          successStatus: 200,
          operationId: "heartbeatSession",
          tags: ["Sessions"],
          summary: "Renew the caller's Session and its claims and open a touched-path collection",
        })
        .input(heartbeatSessionInputSchema)
        .output(heartbeatSessionOutputSchema),

      attach: base
        .route({
          method: "POST",
          path: "/projects/{id}/sessions/{sessionId}/attach",
          successStatus: 200,
          operationId: "attachSession",
          tags: ["Sessions"],
          summary: "Set or clear the caller's Session's Plan and Task focus",
        })
        .input(attachSessionInputSchema)
        .output(sessionChangeOutputSchema),

      end: base
        .route({
          method: "POST",
          path: "/projects/{id}/sessions/{sessionId}/end",
          successStatus: 200,
          operationId: "endSession",
          tags: ["Sessions"],
          summary: "End the caller's Session with a summary and release its claims",
        })
        .input(endSessionInputSchema)
        .output(endSessionOutputSchema),

      claims: base
        .route({
          method: "GET",
          path: "/projects/{id}/sessions/{sessionId}/claims",
          successStatus: 200,
          operationId: "listSessionClaims",
          tags: ["Sessions"],
          summary: "List the Tasks a Session holds usable claims on",
        })
        .input(listSessionClaimsInputSchema)
        .output(taskPageSchema),

      events: base
        .route({
          method: "GET",
          path: "/projects/{id}/sessions/{sessionId}/events",
          successStatus: 200,
          operationId: "listSessionEvents",
          tags: ["Events"],
          summary: "List Events a Session acted through or was affected by",
        })
        .input(listSessionEventsInputSchema)
        .output(eventPageSchema),

      overlaps: base
        .route({
          method: "GET",
          path: "/projects/{id}/sessions/{sessionId}/overlaps",
          successStatus: 200,
          operationId: "checkSessionOverlaps",
          tags: ["Scopes"],
          summary: "Compare a Session's Scopes with other live Sessions'",
        })
        .input(checkSessionOverlapsInputSchema)
        .output(overlapPageSchema),

      scopes: {
        list: base
          .route({
            method: "GET",
            path: "/projects/{id}/sessions/{sessionId}/scopes",
            successStatus: 200,
            operationId: "listSessionScopes",
            tags: ["Scopes"],
            summary: "List a Session's declared and touched Scopes",
          })
          .input(listSessionScopesInputSchema)
          .output(scopePageSchema),

        add: base
          .route({
            method: "POST",
            path: "/projects/{id}/sessions/{sessionId}/scopes",
            successStatus: 200,
            operationId: "addSessionScope",
            tags: ["Scopes"],
            summary: "Declare a Scope glob for the caller's Session",
          })
          .input(addSessionScopeInputSchema)
          .output(addSessionScopeOutputSchema),

        remove: base
          .route({
            method: "DELETE",
            path: "/projects/{id}/sessions/{sessionId}/scopes/{scopeId}",
            successStatus: 200,
            operationId: "removeSessionScope",
            tags: ["Scopes"],
            summary: "Remove a declared Scope from the caller's Session",
          })
          .input(removeSessionScopeInputSchema)
          .output(removeSessionScopeOutputSchema),
      },

      collections: {
        manifest: base
          .route({
            method: "POST",
            path: "/projects/{id}/sessions/{sessionId}/collections/{collectionId}/manifest",
            successStatus: 200,
            operationId: "registerCollectionManifest",
            tags: ["Scopes"],
            summary: "Register a touched-path collection's manifest",
          })
          .input(registerCollectionManifestInputSchema)
          .output(collectionOutputSchema),

        batch: base
          .route({
            method: "POST",
            path: "/projects/{id}/sessions/{sessionId}/collections/{collectionId}/batches",
            successStatus: 200,
            operationId: "uploadCollectionBatch",
            tags: ["Scopes"],
            summary: "Upload one batch of a touched-path collection",
          })
          .input(uploadCollectionBatchInputSchema)
          .output(uploadCollectionBatchOutputSchema),

        finalize: base
          .route({
            method: "POST",
            path: "/projects/{id}/sessions/{sessionId}/collections/{collectionId}/finalize",
            successStatus: 200,
            operationId: "finalizeCollection",
            tags: ["Scopes"],
            summary: "Verify a touched-path collection and mark it complete",
          })
          .input(finalizeCollectionInputSchema)
          .output(collectionOutputSchema),
      },
    },

    events: {
      list: base
        .route({
          method: "GET",
          path: "/projects/{id}/events",
          successStatus: 200,
          operationId: "listProjectEvents",
          tags: ["Events"],
          summary: "List a Project's Events, newest first",
        })
        .input(listProjectEventsInputSchema)
        .output(eventPageSchema),
      /**
       * Server-Sent Events: the Project's Events as they become safe to
       * deliver, plus heartbeats, until the server rotates the stream
       * (ADR-0010). Authorization and the cursor are checked before the
       * stream opens, so those failures are 401, 404 and 400 rather than a
       * 200 stream; a later loss of access ends it with an `access_lost`
       * frame. Delivery is at least once, in feed order, not commit order.
       */
      stream: base
        .route({
          method: "GET",
          path: "/projects/{id}/events/stream",
          successStatus: 200,
          operationId: "streamProjectEvents",
          tags: ["Events"],
          summary: "Stream a Project's Events as Server-Sent Events, resuming from a cursor",
        })
        .input(streamProjectEventsInputSchema)
        .output(eventIterator(eventStreamFrameSchema)),
    },

    status: base
      .route({
        method: "GET",
        path: "/projects/{id}/status",
        successStatus: 200,
        operationId: "getProjectStatus",
        tags: ["Status"],
        summary: "Summarize a Project's active Plans, live Sessions, claims and overlaps",
      })
      .input(getProjectStatusInputSchema)
      .output(projectStatusSchema),
  },
};

export type ApiContract = typeof apiContract;
