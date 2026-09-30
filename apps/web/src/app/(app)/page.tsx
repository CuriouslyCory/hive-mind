import { headers } from "next/headers";
import { Suspense } from "react";
import { auth } from "../../server/auth";
import { requireSession } from "../../server/session";
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
  const { user } = await requireSession();
  // Checks that the user is still a member of the active organization.
  const activeOrganization = await auth.api.getFullOrganization({
    headers: await headers(),
    query: { membersLimit: 1 },
  });

  return (
    <>
      <p>Signed in as {user.name}</p>
      <p>Organization: {activeOrganization?.name ?? "none"}</p>
      <SignOutButton />
    </>
  );
}
