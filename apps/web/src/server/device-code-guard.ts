import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import type { DBAdapter, Where } from "better-auth/types";

/**
 * Makes the device plugin's two state changes on a pending device code atomic
 * on Postgres. Both are races in better-auth 1.7.6 with the Drizzle adapter:
 *
 * - Binding. Opening a code (`GET /device`, `deviceVerify`) binds it to the
 *   viewer with `incrementOne`, guarded by "still pending and unbound". The
 *   Drizzle adapter runs that as `UPDATE ... WHERE id IN (SELECT id ... WHERE
 *   <guard> LIMIT 1)`. Postgres evaluates the subquery once, on its snapshot,
 *   and does not re-evaluate it after waiting for a concurrent writer, so two
 *   Users opening one code at once both "bind" it and the second overwrites
 *   the first.
 * - Decision. approve and deny check that the code is pending and bound to
 *   the signed-in User, then `update` it by id alone, so a concurrent Approve
 *   and Deny both succeed and the last write wins: the CLI could be signed in
 *   after the user saw "Denied".
 *
 * This wrapper runs both as one `UPDATE ... WHERE <id and guard>` through
 * `updateMany`. Postgres re-checks a plain WHERE clause against the row it
 * updates once a concurrent writer commits, so exactly one of two racing
 * writes changes the row. The loser of a binding race gets `null`, as the
 * plugin expects from an unmatched guard, and is not shown the request; the
 * loser of a decision race gets the plugin's own "already processed" error,
 * the same answer as a decision made after the first.
 *
 * Redemption needs no wrapper: the plugin claims an approved code with
 * `consumeOne`, a `DELETE ... RETURNING`, and a row can be deleted once, so
 * concurrent token requests get it at most once (device-auth.test.ts).
 */
export function guardDeviceCodeDecisions(
  createAdapter: (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>,
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  return (options) => {
    const adapter = createAdapter(options);

    /**
     * Updates the device code that `where` selects by id, only if the rest of
     * `where` and `guard` still hold, in one statement. Returns the updated
     * row, or `null` if nothing changed.
     */
    async function guardedUpdate<T>(
      where: Where[],
      guard: Where[],
      update: Record<string, unknown>,
    ) {
      const byId = where.filter((clause) => clause.field === "id");
      // Both plugin writes select the row by id. Without it this could change
      // more than one row, so anything else fails closed.
      if (byId.length !== 1 || where.some((clause) => clause.connector === "OR")) {
        throw new Error("Unexpected device code update.");
      }
      const changed = await adapter.updateMany({
        model: "deviceCode",
        where: [...where, ...guard],
        update,
      });
      if (changed !== 1) return null;
      return adapter.findOne<T>({ model: "deviceCode", where: byId });
    }

    return {
      ...adapter,

      incrementOne: async <T>(
        data: Parameters<DBAdapter["incrementOne"]>[0],
      ): Promise<T | null> => {
        const isBinding =
          data.model === "deviceCode" &&
          Object.keys(data.increment).length === 0 &&
          Object.keys(data.set ?? {}).join() === "userId";
        if (!isBinding) return adapter.incrementOne<T>(data);
        // The plugin's guard (id, still pending, no User yet) is already in
        // `where`; it only needs to be evaluated in the UPDATE itself.
        return guardedUpdate<T>(data.where, [], data.set ?? {});
      },

      update: async <T>(data: Parameters<DBAdapter["update"]>[0]): Promise<T | null> => {
        if (data.model !== "deviceCode" || !("status" in data.update)) {
          return adapter.update<T>(data);
        }
        const userId: unknown = data.update.userId;
        // approve and deny always set the deciding User. Anything else is a
        // write this wrapper was not reviewed for, so it fails closed.
        if (typeof userId !== "string") throw new Error("Unexpected device code update.");
        const decided = await guardedUpdate<T>(
          data.where,
          [
            { field: "status", value: "pending" },
            { field: "userId", value: userId },
            { field: "expiresAt", operator: "gt", value: new Date() },
          ],
          data.update,
        );
        if (!decided) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "Device code already processed",
          });
        }
        return decided;
      },
    };
  };
}
