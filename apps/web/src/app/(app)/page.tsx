import { headers } from "next/headers";
import { Suspense } from "react";
import { auth, getActiveOrganization } from "../../server/auth";
import { requireLoginSession } from "../../server/login-session";
import { SignOutButton } from "./sign-out-button";

// A placeholder until the dashboard (M3): who is signed in, and in which
// organization.
export default function HomePage() {
  return (
    <main>
      <h1>hive-mind</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <SignedInAs />
      </Suspense>
    </main>
  );
}

async function SignedInAs() {
  const { user } = await requireLoginSession();
  // Null when the user is no longer a member of the active organization.
  const activeOrganization = await getActiveOrganization(auth, await headers());

  return (
    <>
      <p>Signed in as {user.name}</p>
      <p>Organization: {activeOrganization?.name ?? "none"}</p>
      <SignOutButton />
    </>
  );
}
