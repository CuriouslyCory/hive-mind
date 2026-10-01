"use client";

import { useEffect, useState } from "react";
import { authClient } from "../../lib/auth-client";

/** `callbackURL` must already be a validated same-origin path. */
export function SignInButton({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The page is prerendered, so the button shows before this script runs; a
  // click then would do nothing. It is enabled once it can act.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function signIn() {
    setPending(true);
    setFailed(false);
    // Redirects the browser to GitHub on success. An error response resolves
    // with `error`; a network failure rejects.
    const started = await authClient.signIn.social({ provider: "github", callbackURL }).then(
      ({ error }) => !error,
      () => false,
    );
    if (!started) {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={signIn} disabled={pending || !ready}>
        Sign in with GitHub
      </button>
      {failed && <p role="alert">Sign-in failed. Try again.</p>}
    </>
  );
}
