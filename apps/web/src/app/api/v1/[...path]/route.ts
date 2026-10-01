import { createApiHandler } from "../../../../server/api/router";
import { auth } from "../../../../server/auth";
import { getDb } from "../../../../server/db";

// `/api/v1`, the contract the CLI calls. `auth` and the database are created
// on the first request, so `next build` can import this module without
// runtime environment variables. Authentication and authorization happen in
// the handler on every request; `proxy.ts` does not cover `/api`.
const handle = createApiHandler(() => ({ auth, db: getDb() }));

export { handle as DELETE, handle as GET, handle as POST };
