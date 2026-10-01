import type { CredentialFailureReason, CredentialStore } from "../../src/credentials/types.ts";

export interface MemoryStore extends CredentialStore {
  readonly items: Map<string, string>;
  /** Make every call fail with this reason (null restores normal behavior). */
  failWith: CredentialFailureReason | null;
  calls: string[];
}

/** An in-memory stand-in for the Keychain or Secret Service, with switchable availability. */
export function memoryStore(id: "keychain" | "libsecret"): MemoryStore {
  const store: MemoryStore = {
    id,
    promptCapable: true,
    items: new Map(),
    failWith: null,
    calls: [],
    async get(origin) {
      store.calls.push(`get ${origin}`);
      if (store.failWith)
        return { ok: false, reason: store.failWith, message: `${id} ${store.failWith}` };
      const secret = store.items.get(origin);
      return secret === undefined ? { ok: true, found: false } : { ok: true, found: true, secret };
    },
    async set(origin, secret) {
      store.calls.push(`set ${origin}`);
      if (store.failWith)
        return { ok: false, reason: store.failWith, message: `${id} ${store.failWith}` };
      store.items.set(origin, secret);
      return { ok: true };
    },
    async delete(origin) {
      store.calls.push(`delete ${origin}`);
      if (store.failWith)
        return { ok: false, reason: store.failWith, message: `${id} ${store.failWith}` };
      return { ok: true, deleted: store.items.delete(origin) };
    },
  };
  return store;
}
