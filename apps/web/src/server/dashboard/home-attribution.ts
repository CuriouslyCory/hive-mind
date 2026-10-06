import type { Transaction } from "@hivemind/db";
import { apikey, projectApiKey, user } from "@hivemind/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { Attribution } from "./queries";

// Display names across Projects, for the home page. The same rules as the
// Project pages' attributions (./queries.ts): a Project key is named only
// through its binding to the Project the record belongs to, and a key whose
// binding is gone shows as revoked. Never a key's secret prefix.

export interface HomeNames {
  user(userId: string): Attribution;
  key(projectId: string, keyId: string): Attribution;
}

export interface HomeNameIds {
  userIds: Iterable<string | null>;
  keys: Iterable<{ projectId: string; keyId: string } | null>;
}

function unique(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))];
}

export async function loadHomeNames(tx: Transaction, ids: HomeNameIds): Promise<HomeNames> {
  const userIds = unique(ids.userIds);
  const keyPairs = [...ids.keys].filter((pair) => pair !== null);
  const keyIds = unique(keyPairs.map((pair) => pair.keyId));
  const users =
    userIds.length === 0
      ? []
      : await tx
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, userIds));
  const bindings =
    keyIds.length === 0
      ? []
      : await tx
          .select({
            keyId: projectApiKey.keyId,
            projectId: projectApiKey.projectId,
            name: apikey.name,
          })
          .from(projectApiKey)
          .innerJoin(apikey, eq(apikey.id, projectApiKey.keyId))
          .where(inArray(projectApiKey.keyId, keyIds));
  const userNames = new Map(users.map((row) => [row.id, row.name]));
  const keyNames = new Map(bindings.map((row) => [`${row.projectId}:${row.keyId}`, row.name]));
  return {
    user: (userId) => ({ kind: "user", userId, name: userNames.get(userId) ?? null }),
    key: (projectId, keyId) => {
      const binding = `${projectId}:${keyId}`;
      return {
        kind: "project_key",
        keyId,
        name: keyNames.get(binding) ?? null,
        revoked: !keyNames.has(binding),
      };
    },
  };
}
