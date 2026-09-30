"use client";

import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    // Redirects the browser to GitHub on success. An error response resolves
    // with `error`; a network failure rejects.
    const started = await authClient.signIn.social({ provider: "github", callbackURL: "/" }).then(
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
      <button type="button" onClick={signIn} disabled={pending}>
        Sign in with GitHub
      </button>
      {failed && <p role="alert">Sign-in failed. Try again.</p>}
    </>
  );
}
