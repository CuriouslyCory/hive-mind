import type { CreatorKind, SessionOwnerKind } from "./schema/coordination.ts";

// Who performs a coordination change. The web layer fills these from the
// authenticated request (a User's login session or a verified Project key)
// and never from request fields; this package trusts them as given. They are
// plain values, independent of better-auth and the contract package.

/** An authenticated caller: a User, or a Project key acting as itself. */
export type Principal = { kind: "user"; userId: string } | { kind: "project_key"; keyId: string };

/**
 * The actor an Event records: a principal, optionally acting through one of
 * its Sessions, or `system` for the sweep. A system actor has no Session.
 */
export type Actor = (Principal & { sessionId?: string | null }) | { kind: "system" };

/** A principal as a Plan's or Task's `created_by_*` columns. */
export function creatorColumns(principal: Principal): {
  createdByKind: CreatorKind;
  createdByUserId: string | null;
  createdByKeyId: string | null;
} {
  return principal.kind === "user"
    ? { createdByKind: "user", createdByUserId: principal.userId, createdByKeyId: null }
    : { createdByKind: "project_key", createdByUserId: null, createdByKeyId: principal.keyId };
}

/** A principal as a Session's owner columns. Session owner kinds are `user` and `key`. */
export function sessionOwnerColumns(principal: Principal): {
  ownerKind: SessionOwnerKind;
  userId: string | null;
  keyId: string | null;
} {
  return principal.kind === "user"
    ? { ownerKind: "user", userId: principal.userId, keyId: null }
    : { ownerKind: "key", userId: null, keyId: principal.keyId };
}

/** The principal that owns a Session row. */
export function sessionOwner(row: {
  ownerKind: SessionOwnerKind;
  userId: string | null;
  keyId: string | null;
}): Principal {
  if (row.ownerKind === "user" && row.userId) return { kind: "user", userId: row.userId };
  if (row.ownerKind === "key" && row.keyId) return { kind: "project_key", keyId: row.keyId };
  // The agent_session_owner_check constraint rules this out.
  throw new Error("Session row has no owner.");
}

/** Whether two principals are the same User or the same Project key. */
export function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.kind === "user") return b.kind === "user" && a.userId === b.userId;
  return b.kind === "project_key" && a.keyId === b.keyId;
}
