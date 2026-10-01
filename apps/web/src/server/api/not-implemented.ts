import { apiError } from "./authorize";
import { api } from "./implementer";

// TEMPORARY. The coordination routes of #12 are in the contract before their
// handlers exist, and `api.router` must implement every contract procedure.
// Each handler below answers 500 until the real one replaces it; remove the
// entry here, wire the real handler in `router.ts`, and remove its
// operationId from `NOT_YET_SERVED` in `test/openapi.test.ts`. This file is
// deleted once it is empty.

export const NOT_IMPLEMENTED_MESSAGE = "This operation is not implemented yet.";

function notImplemented(): never {
  throw apiError("INTERNAL_SERVER_ERROR", NOT_IMPLEMENTED_MESSAGE);
}

export const pendingCoordination = {
  tasks: {
    claim: api.projects.tasks.claim.handler(notImplemented),
    release: api.projects.tasks.release.handler(notImplemented),
    start: api.projects.tasks.start.handler(notImplemented),
    block: api.projects.tasks.block.handler(notImplemented),
    done: api.projects.tasks.done.handler(notImplemented),
  },
  sessions: {
    list: api.projects.sessions.list.handler(notImplemented),
    start: api.projects.sessions.start.handler(notImplemented),
    get: api.projects.sessions.get.handler(notImplemented),
    update: api.projects.sessions.update.handler(notImplemented),
    heartbeat: api.projects.sessions.heartbeat.handler(notImplemented),
    attach: api.projects.sessions.attach.handler(notImplemented),
    end: api.projects.sessions.end.handler(notImplemented),
    claims: api.projects.sessions.claims.handler(notImplemented),
    overlaps: api.projects.sessions.overlaps.handler(notImplemented),
    scopes: {
      list: api.projects.sessions.scopes.list.handler(notImplemented),
      add: api.projects.sessions.scopes.add.handler(notImplemented),
      remove: api.projects.sessions.scopes.remove.handler(notImplemented),
    },
    collections: {
      manifest: api.projects.sessions.collections.manifest.handler(notImplemented),
      batch: api.projects.sessions.collections.batch.handler(notImplemented),
      finalize: api.projects.sessions.collections.finalize.handler(notImplemented),
    },
  },
  status: api.projects.status.handler(notImplemented),
};
