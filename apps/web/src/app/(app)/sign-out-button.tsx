"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    // An error response resolves with `error`; a network failure rejects.
    const signedOut = await authClient.signOut().then(
      ({ error }) => !error,
      () => false,
    );
    if (!signedOut) {
      setFailed(true);
      setPending(false);
      return;
    }
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={signOut} disabled={pending}>
        Sign out
      </button>
      {failed && <p role="alert">Sign-out failed. Try again.</p>}
    </>
  );
}
