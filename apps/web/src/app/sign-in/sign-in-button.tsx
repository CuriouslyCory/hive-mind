"use client";

import { useEffect, useId, useState } from "react";
import { Alert } from "../../design-system/alert";
import { Button } from "../../design-system/button";
import { authClient } from "../../lib/auth-client";

/** `callbackURL` must already be a validated same-origin path. */
export function SignInButton({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The page is prerendered, so the button shows before this script runs; a
  // click then would do nothing. It is enabled once it can act.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const id = useId();

  // Back from GitHub, the browser can restore this page from its back/forward
  // cache as it was when it left: still pending.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  // Disabling the focused button while pending drops focus to the body; a
  // failure gives it back, so a keyboard user can try again from there.
  useEffect(() => {
    if (failed && document.activeElement === document.body) {
      document.getElementById(id)?.focus();
    }
  }, [failed, id]);

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
      <Button
        id={id}
        variant="primary"
        size="lg"
        className="si-cta"
        onClick={signIn}
        disabled={pending || !ready}
      >
        {pending ? "Signing in…" : "Sign in with GitHub"}
      </Button>
      {failed && (
        <Alert tone="danger" title="Sign-in failed.">
          HiveMind could not start the sign-in with GitHub. Try again.
        </Alert>
      )}
    </>
  );
}
